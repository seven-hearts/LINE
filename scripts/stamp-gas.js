// gas/ の全ファイルに「版の印」を付ける: npm run stamp:gas
//
// Apps Script に古いファイルが混ざっていないか（変更したファイルだけ貼り直して、他が古いまま、など）を
// setup / checkSettings / checkGasFiles で見つけるための仕組み。
// - gas/ の全ファイルの中身から版（GAS_BUILD）を計算し、各 .gs の末尾と各 .html の末尾に印として書き込む
// - gas/Version.gs に「あるべきファイルの一覧」と「あるべき版」を書き込む
// Apps Script 側では、各ファイルの印が Version.gs の版と同じかを比べる。
//
// gas/ のファイルを変えたら必ず実行する（ずれていると npm test が失敗する）。npm run gas:push は自動で実行する。
// node scripts/stamp-gas.js --check : 書き込まずに、印が最新かだけを確かめる（ずれていれば終了コード 1）
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const GAS_DIR = path.join(__dirname, '..', 'gas');
const VERSION_FILE = 'Version.gs';

// .gs の末尾に付ける印（この2行）
const GS_MARK_COMMENT = '// 版の印（npm run stamp:gas で自動更新。手で変えないでください）';
const GS_MARK_RE = /\n*\/\/ 版の印（npm run stamp:gas[^\n]*\nvar GAS_FILE_BUILDS_ = [^\n]*\n*$/;
// .html の末尾に付ける印
const HTML_MARK_RE = /\n*<!-- gas-build: [^\n]*-->\n*$/;
// Version.gs の自動生成部分
const GEN_BEGIN = '// ---- ここから自動生成（npm run stamp:gas）。手で変えないでください ----';
const GEN_END = '// ---- ここまで自動生成 ----';
const GEN_RE = new RegExp(escapeRe(GEN_BEGIN) + '[\\s\\S]*?' + escapeRe(GEN_END));

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 印の対象ファイル（appsscript.json は JSON なので印を付けられない。版の計算には含める） */
function listFiles() {
  return fs.readdirSync(GAS_DIR)
    .filter((f) => /\.(gs|html)$/.test(f))
    .sort();
}

/** 印と自動生成部分を取り除いた中身（版の計算に使う） */
function strip(name, text) {
  let t = text.replace(/\r\n/g, '\n');
  if (name.endsWith('.html')) {
    t = t.replace(HTML_MARK_RE, '\n');
  } else {
    t = t.replace(GS_MARK_RE, '\n');
    if (name === VERSION_FILE) t = t.replace(GEN_RE, GEN_BEGIN + '\n' + GEN_END);
  }
  return t.replace(/\n*$/, '\n');
}

function computeBuild(files, read) {
  const h = crypto.createHash('sha256');
  const names = files.concat(['appsscript.json']);
  names.forEach((name) => {
    h.update(name + '\0');
    h.update(strip(name, read(name)) + '\0');
  });
  return h.digest('hex').slice(0, 12);
}

/** Apps Script 上のファイル名（.html は拡張子なし。.gs は拡張子付きで表示する） */
function scriptName(name) {
  return name.endsWith('.html') ? name.replace(/\.html$/, '') : name;
}

function stamp(name, text, build, files) {
  const base = strip(name, text).replace(/\n+$/, '');
  if (name.endsWith('.html')) return base + '\n<!-- gas-build: ' + build + ' -->\n';
  let body = base;
  if (name === VERSION_FILE) {
    const gs = files.filter((f) => f.endsWith('.gs'));
    const html = files.filter((f) => f.endsWith('.html')).map(scriptName);
    const gen = [
      GEN_BEGIN,
      "var GAS_BUILD = '" + build + "';",
      'var GAS_EXPECTED_SCRIPTS_ = ' + JSON.stringify(gs) + ';',
      'var GAS_EXPECTED_HTML_ = ' + JSON.stringify(html) + ';',
      GEN_END
    ].join('\n');
    if (!GEN_RE.test(body)) throw new Error(VERSION_FILE + ' に自動生成部分の目印がありません');
    body = body.replace(GEN_RE, gen);
  }
  return body + '\n\n' + GS_MARK_COMMENT + '\n' +
    "var GAS_FILE_BUILDS_ = (typeof GAS_FILE_BUILDS_ === 'object' && GAS_FILE_BUILDS_) || {}; " +
    "GAS_FILE_BUILDS_['" + name + "'] = '" + build + "';\n";
}

/** gas/ の全ファイルについて、印を付けたあとの中身を返す */
function render(read) {
  read = read || ((name) => fs.readFileSync(path.join(GAS_DIR, name), 'utf8'));
  const files = listFiles();
  const build = computeBuild(files, read);
  const out = {};
  files.forEach((name) => { out[name] = stamp(name, read(name), build, files); });
  return { build, files: out };
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  const { build, files } = render();
  const changed = Object.keys(files).filter((name) =>
    fs.readFileSync(path.join(GAS_DIR, name), 'utf8') !== files[name]);
  if (check) {
    if (changed.length) {
      console.error('版の印が古いファイルがあります。npm run stamp:gas を実行してください：' + changed.join(', '));
      process.exit(1);
    }
    console.log('版の印は最新です（' + build + '）');
  } else {
    changed.forEach((name) => fs.writeFileSync(path.join(GAS_DIR, name), files[name]));
    console.log('版 ' + build + '（' + Object.keys(files).length + 'ファイル、更新 ' + changed.length + '）');
  }
}

module.exports = { render, listFiles, GAS_DIR };
