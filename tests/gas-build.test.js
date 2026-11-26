// gas/ の全ファイルの「版の印」（scripts/stamp-gas.js・gas/Version.gs）を確かめる
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { render, listFiles, GAS_DIR } = require('../scripts/stamp-gas.js');

const read = (name) => fs.readFileSync(path.join(GAS_DIR, name), 'utf8');

test('gas/ の版の印が最新（違う場合は npm run stamp:gas）', () => {
  const { files } = render();
  Object.keys(files).forEach((name) => assert.strictEqual(read(name), files[name], name));
});

test('印を付け直しても版は変わらない', () => {
  const first = render();
  const second = render((name) => first.files[name] ?? read(name));
  assert.strictEqual(second.build, first.build);
  assert.deepStrictEqual(second.files, first.files);
});

test('中身を1文字でも変えると版が変わる', () => {
  const base = render();
  const changed = render((name) => (name === 'Sheet.gs' ? read(name) + '\n// x\n' : read(name)));
  assert.notStrictEqual(changed.build, base.build);
});

// Apps Script と同じように、全 .gs を1つのグローバル領域で読み込む
function loadGas(files, html) {
  const ctx = vm.createContext({
    console,
    HtmlService: {
      createTemplateFromFile(name) {
        if (!(name in html)) throw new Error('No HTML file named ' + name);
        return { getRawContent: () => html[name] };
      }
    }
  });
  Object.keys(files).forEach((name) => vm.runInContext(files[name], ctx, { filename: name }));
  return ctx;
}

function currentProject() {
  const files = {};
  const html = {};
  listFiles().forEach((name) => {
    if (name.endsWith('.gs')) files[name] = read(name);
    else html[name.replace(/\.html$/, '')] = read(name);
  });
  return { files, html };
}

test('全ファイルが最新なら、版はそろっている', () => {
  const { files, html } = currentProject();
  const ctx = loadGas(files, html);
  const st = ctx.gasFileStatus_();
  assert.deepStrictEqual(Array.from(st.problems), []);
  assert.strictEqual(st.ok.length, listFiles().length);
  ctx.assertGasFilesMatch_();
});

test('古いファイル・足りないファイル・不要なファイルを見つけて、setup を止める', () => {
  const { files, html } = currentProject();
  // Sheet.gs だけ古い版（印が違う）
  files['Sheet.gs'] = files['Sheet.gs'].replace(/GAS_FILE_BUILDS_\['Sheet\.gs'\] = '\w+'/, "GAS_FILE_BUILDS_['Sheet.gs'] = 'old000000000'");
  // Shift.gs は印のない（この仕組みより前の）ファイル
  files['Shift.gs'] = files['Shift.gs'].replace(/\n\/\/ 版の印[^\n]*\n[^\n]*\n$/, '\n');
  // Manual.gs を貼り忘れ
  delete files['Manual.gs'];
  // JobSend（HTML）が古い
  html.JobSend = html.JobSend.replace(/<!-- gas-build: \w+ -->/, '<!-- gas-build: old000000000 -->');
  // 削除済みのファイルが残っている
  files['Old.gs'] = "var GAS_FILE_BUILDS_ = (typeof GAS_FILE_BUILDS_ === 'object' && GAS_FILE_BUILDS_) || {}; GAS_FILE_BUILDS_['Old.gs'] = 'x';\n";

  const ctx = loadGas(files, html);
  const problems = Array.from(ctx.gasFileStatus_().problems).join('\n');
  assert.match(problems, /Sheet\.gs：版が違います/);
  assert.match(problems, /Shift\.gs：ファイルがないか、版の印がない/);
  assert.match(problems, /Manual\.gs：ファイルがないか/);
  assert.match(problems, /JobSend（HTML）：版が違います/);
  assert.match(problems, /Old\.gs：今の版にはないファイル/);
  assert.throws(() => ctx.assertGasFilesMatch_(), /版がそろっていません/);
  assert.throws(() => ctx.setup(), /版がそろっていません/);
});

test('Version.gs がないときも、setup はわかりやすいエラーで止まる', () => {
  const { files, html } = currentProject();
  delete files['Version.gs'];
  const ctx = loadGas(files, html);
  assert.throws(() => ctx.setup(), /Version\.gs がありません/);
});
