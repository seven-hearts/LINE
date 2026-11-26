/**
 * Apps Script 上のファイルの版がそろっているかの検査。
 *
 * 変更したファイルだけを貼り直すと、ほかのファイルが古いまま残り、
 * 「○○ is not defined（ReferenceError）」などのわかりにくいエラーになる。
 * これを防ぐため、gas/ の全ファイルの末尾に「版の印」を付けている（npm run stamp:gas が自動で付ける）。
 * - setup は、最初にここで検査し、そろっていなければ何もせずに止まる
 * - checkSettings も同じ検査の結果を表示する
 * - エディタで checkGasFiles を実行すると、検査だけを行える
 *
 * 直し方：clasp で全ファイルをまとめて反映する（README「コードを Apps Script に反映する」）。
 */

// ---- ここから自動生成（npm run stamp:gas）。手で変えないでください ----
var GAS_BUILD = 'ea9ce1accc54';
var GAS_EXPECTED_SCRIPTS_ = ["Api.gs","Chat.gs","Code.gs","Diagnostics.gs","Freee.gs","Interview.gs","Jobs.gs","JobsApp.gs","Line.gs","Manual.gs","Options.gs","RichMenu.gs","Sheet.gs","Shift.gs","Validation.gs","Version.gs","Webhook.gs"];
var GAS_EXPECTED_HTML_ = ["DetailSend","FreeeInvoice","JobImport","JobSend","ManualApply"];
// ---- ここまで自動生成 ----

/**
 * 各ファイルの版を調べる。
 * @return {{build: string, ok: string[], problems: string[]}} problems が空なら、すべてそろっている
 */
function gasFileStatus_() {
  var builds = (typeof GAS_FILE_BUILDS_ === 'object' && GAS_FILE_BUILDS_) || {};
  var ok = [];
  var problems = [];

  GAS_EXPECTED_SCRIPTS_.forEach(function (name) {
    var b = builds[name];
    if (!b) problems.push(name + '：ファイルがないか、版の印がない古いファイルです');
    else if (b !== GAS_BUILD) problems.push(name + '：版が違います（このファイル：' + b + '／Version.gs：' + GAS_BUILD + '）');
    else ok.push(name);
  });

  GAS_EXPECTED_HTML_.forEach(function (name) {
    var raw;
    try {
      raw = HtmlService.createTemplateFromFile(name).getRawContent();
    } catch (err) {
      problems.push(name + '（HTML）：ファイルがありません');
      return;
    }
    var m = /<!-- gas-build: (\S+) -->\s*$/.exec(raw);
    if (!m) problems.push(name + '（HTML）：版の印がない古いファイルです');
    else if (m[1] !== GAS_BUILD) problems.push(name + '（HTML）：版が違います（このファイル：' + m[1] + '／Version.gs：' + GAS_BUILD + '）');
    else ok.push(name + '（HTML）');
  });

  // 今の版にはない（削除・改名された）ファイルが残っている
  Object.keys(builds).forEach(function (name) {
    if (GAS_EXPECTED_SCRIPTS_.indexOf(name) === -1) {
      problems.push(name + '：今の版にはないファイルです。Apps Script から削除してください');
    }
  });

  return { build: GAS_BUILD, ok: ok, problems: problems };
}

/** 版がそろっていなければ、直し方を書いたエラーで止める（setup の最初に呼ぶ） */
function assertGasFilesMatch_() {
  var st = gasFileStatus_();
  if (!st.problems.length) return st;
  throw new Error('Apps Script のファイルの版がそろっていません（版 ' + st.build + ' にそろえる必要があります）。\n・' +
    st.problems.join('\n・') + '\n' +
    'gas/ の全ファイルをまとめて反映してから、もう一度実行してください（README「コードを Apps Script に反映する」）。');
}

/** エディタから実行する：ファイルの版がそろっているかを実行ログに表示する */
function checkGasFiles() {
  var st = gasFileStatus_();
  if (!st.problems.length) {
    console.log('✅ 全' + st.ok.length + 'ファイルの版がそろっています（版 ' + st.build + '）');
  } else {
    console.log('❌ ファイルの版がそろっていません（版 ' + st.build + '）\n・' + st.problems.join('\n・') +
      '\ngas/ の全ファイルをまとめて反映してください（README「コードを Apps Script に反映する」）');
  }
  return st;
}

// 版の印（npm run stamp:gas で自動更新。手で変えないでください）
var GAS_FILE_BUILDS_ = (typeof GAS_FILE_BUILDS_ === 'object' && GAS_FILE_BUILDS_) || {}; GAS_FILE_BUILDS_['Version.gs'] = 'ea9ce1accc54';
