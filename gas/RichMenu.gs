/**
 * スタッフ用リッチメニュー（Messaging API で、スタッフにだけ表示するリッチメニュー）。
 *
 * - 友だち全員に出すリッチメニューは、これまでどおり LINE Official Account Manager で作る
 * - スタッフ用は、シート「リッチメニュー設定」に画像とボタンを入れて、
 *   メニュー「セブンハーツ > スタッフ用リッチメニューを作成・更新」で作る
 *   → ステータスが「採用」「書類依頼済」「書類提出済」「稼働可」の人に表示される（Manager のメニューより優先される）
 * - その後にステータスがスタッフに変わった人には自動で表示し、「不採用」「退会」などになった人からは外す（onStatusEdit）
 * - ボタンの「マニュアル」は LIFF の URL で開くので、だれが読んだかがシート「マニュアル閲覧」に残る
 *
 * richMenuSettings_・richMenuDefinition_・imageSize_・driveFileId_ はシートや LINE に触れないので、tests/manual.test.js で確認できる。
 */

var LINE_DATA_API = 'https://api-data.line.me/v2/bot';
var RICHMENU_PROPERTY = 'STAFF_RICHMENU_ID'; // 作ったリッチメニューのID（スクリプト プロパティ。自動で入る）
var RICHMENU_IMAGE_MAX_BYTES = 1024 * 1024;  // LINE の上限（1MB）
var RICHMENU_MAX_COLS = 4;
var RICHMENU_MAX_ROWS = 3;
var RICHMENU_BUTTON_HELP = '左上から右へ数え、1段目が終わったら2段目の左から続けます。' +
  '「マニュアル」＝スタッフマニュアルを開く／https:// で始まるURL＝そのページを開く／' +
  'それ以外の言葉＝その言葉をトークに送る（例：シフト、登録状況、書類、変更）／空欄＝押しても何もしない';

/** シート「リッチメニュー設定」の初めの内容：[項目, 値, 説明] */
var RICHMENU_DEFAULTS = [
  ['画像', '', 'リッチメニューの画像（PNG か JPEG、1MB以下）。Googleドライブに入れて、ファイルのURL（「リンクをコピー」で取れるもの）を貼ってください。大きさは 幅2500×高さ1686（大）か 幅2500×843（小）がおすすめです'],
  ['横のボタンの数', 3, '画像を横に何等分してボタンにするか（1〜' + RICHMENU_MAX_COLS + '）'],
  ['縦のボタンの数', 2, '画像を縦に何等分してボタンにするか（1〜' + RICHMENU_MAX_ROWS + '）'],
  ['メニューの文字', 'メニュー', 'トーク画面の下に出る、メニューを開閉する場所の文字（14文字以内）'],
  ['最初から開く', 'はい', '「はい」なら、トーク画面を開いたときにメニューが開いた状態になります'],
  ['ボタン1', 'マニュアル', RICHMENU_BUTTON_HELP],
  ['ボタン2', 'シフト', ''],
  ['ボタン3', '登録状況', ''],
  ['ボタン4', '変更', ''],
  ['ボタン5', '書類', ''],
  ['ボタン6', '', '']
];

/** スタッフ用リッチメニューを表示するステータス */
function staffMenuStatuses_() {
  return [STATUS.HIRED, STATUS.DOC_REQUESTED, STATUS.DOC_SUBMITTED, STATUS.ACTIVE];
}

function isStaffMenuTarget_(rec) {
  return !!rec && !!rec.userId && staffMenuStatuses_().indexOf(rec.status) >= 0;
}

// ---- 設定の読み取り（シートに触れない） ----

/** シートの行（[項目, 値, 説明]）→ { 項目: 値 }。文字の前後の空白は取る */
function richMenuSettings_(rows) {
  var s = {};
  rows.forEach(function (r) {
    var key = String(r[0] || '').trim();
    if (!key || key === '項目') return;
    s[key] = typeof r[1] === 'string' ? r[1].trim() : r[1];
  });
  return s;
}

/** Google ドライブのファイルのURL（またはファイルID）から、ファイルIDを取り出す */
function driveFileId_(text) {
  text = String(text || '').trim();
  var m = /\/d\/([a-zA-Z0-9_-]{20,})/.exec(text) || /[?&]id=([a-zA-Z0-9_-]{20,})/.exec(text) || /^([a-zA-Z0-9_-]{20,})$/.exec(text);
  return m ? m[1] : '';
}

/** PNG・JPEG の画像の大きさ { width, height }。読み取れなければ null（bytes は Apps Script の符号付きでもよい） */
function imageSize_(bytes) {
  function b(i) { return bytes[i] & 0xff; }
  if (bytes.length > 24 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) {
    return {
      width: ((b(16) << 24) | (b(17) << 16) | (b(18) << 8) | b(19)) >>> 0,
      height: ((b(20) << 24) | (b(21) << 16) | (b(22) << 8) | b(23)) >>> 0
    };
  }
  if (bytes.length > 4 && b(0) === 0xff && b(1) === 0xd8) {
    var i = 2;
    while (i + 9 < bytes.length) {
      if (b(i) !== 0xff) { i++; continue; }
      var marker = b(i + 1);
      if (marker === 0xff) { i++; continue; }
      var len = (b(i + 2) << 8) | b(i + 3);
      // SOF（画像の大きさが書かれている部分）。C4・C8・CC は別の情報
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (b(i + 5) << 8) | b(i + 6), width: (b(i + 7) << 8) | b(i + 8) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      i += 2 + len;
    }
  }
  return null;
}

/** ボタンの値 → LINE のアクション（空欄なら null） */
function richMenuAction_(value, manualUrl, label, errors) {
  value = String(value === undefined || value === null ? '' : value).trim();
  if (!value) return null;
  if (value === 'マニュアル') return { type: 'uri', label: 'マニュアル', uri: manualUrl };
  if (/^https?:\/\//i.test(value)) {
    if (!/^https:\/\/\S+$/.test(value) || value.length > 1000) {
      errors.push(label + '：URLは https:// で始まり、空白を含まない形にしてください（' + value + '）');
    }
    return { type: 'uri', label: label, uri: value };
  }
  if (value.length > 300) errors.push(label + '：送る言葉は300文字以内にしてください');
  return { type: 'message', label: value.slice(0, 20), text: value };
}

/**
 * 設定と画像の大きさから、LINE に送るリッチメニューを作る。
 * 画像を「横の数 × 縦の数」に等分し、左上から順にボタン1、ボタン2…とする。
 * @return {{menu: Object, buttons: string[], errors: string[], warnings: string[]}}
 */
function richMenuDefinition_(settings, size, manualUrl) {
  var errors = [];
  var warnings = [];
  var cols = Number(settings['横のボタンの数']);
  var rows = Number(settings['縦のボタンの数']);
  if (!isSmallInt_(cols, 1, RICHMENU_MAX_COLS)) errors.push('「横のボタンの数」は1〜' + RICHMENU_MAX_COLS + 'の数字にしてください');
  if (!isSmallInt_(rows, 1, RICHMENU_MAX_ROWS)) errors.push('「縦のボタンの数」は1〜' + RICHMENU_MAX_ROWS + 'の数字にしてください');
  var bar = String(settings['メニューの文字'] || '').trim() || 'メニュー';
  if (bar.length > 14) errors.push('「メニューの文字」は14文字以内にしてください（いま' + bar.length + '文字）');

  if (!size) {
    errors.push('画像の大きさを読み取れませんでした。PNG か JPEG の画像にしてください');
  } else {
    if (size.width < 800 || size.width > 2500) errors.push('画像の幅は800〜2500ピクセルにしてください（いま' + size.width + '）');
    if (size.height < 250) errors.push('画像の高さは250ピクセル以上にしてください（いま' + size.height + '）');
    if (size.width / size.height < 1.45) {
      errors.push('画像が縦に長すぎます（幅÷高さが1.45以上になるようにしてください。いま 幅' + size.width + '×高さ' + size.height + '）');
    }
  }
  if (errors.length) return { menu: null, buttons: [], errors: errors, warnings: warnings };

  var areas = [];
  var buttons = []; // 確認の画面に出す説明
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < cols; c++) {
      var n = r * cols + c + 1;
      var action = richMenuAction_(settings['ボタン' + n], manualUrl, 'ボタン' + n, errors);
      if (!action) continue;
      var x = Math.round(c * size.width / cols);
      var y = Math.round(r * size.height / rows);
      areas.push({
        bounds: {
          x: x,
          y: y,
          width: Math.round((c + 1) * size.width / cols) - x,
          height: Math.round((r + 1) * size.height / rows) - y
        },
        action: action
      });
      buttons.push('ボタン' + n + '：' + (action.type === 'message' ? '「' + action.text + '」と送る'
        : action.label === 'マニュアル' ? 'マニュアルを開く' : action.uri + ' を開く'));
    }
  }
  Object.keys(settings).forEach(function (k) {
    var m = /^ボタン(\d+)$/.exec(k);
    if (m && +m[1] > cols * rows && String(settings[k] || '').trim()) {
      warnings.push(k + 'は使われません（横' + cols + '×縦' + rows + '＝' + (cols * rows) + '個のボタンまでのため）');
    }
  });
  if (!areas.length) errors.push('ボタンが1つもありません。「ボタン1」などに「マニュアル」や送る言葉を入れてください');

  return {
    menu: {
      size: { width: size.width, height: size.height },
      selected: String(settings['最初から開く'] || '').trim() !== 'いいえ',
      name: 'スタッフ用',
      chatBarText: bar,
      areas: areas
    },
    buttons: buttons,
    errors: errors,
    warnings: warnings
  };
}

// ---- シートと LINE ----

/** シート「リッチメニュー設定」を用意する。新しく作ったら true */
function ensureRichMenuSheet_(ss) {
  if (ss.getSheetByName(RICHMENU_SHEET)) return false;
  var sh = ss.insertSheet(RICHMENU_SHEET);
  var values = [['項目', '値', '説明']].concat(RICHMENU_DEFAULTS);
  sh.getRange(1, 1, values.length, 3).setValues(values);
  sh.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#f3e5f5');
  sh.getRange(2, 1, values.length - 1, 1).setFontWeight('bold');
  sh.getRange(2, 3, values.length - 1, 1).setWrap(true).setFontColor('#6f625b');
  sh.setColumnWidth(1, 140);
  sh.setColumnWidth(2, 260);
  sh.setColumnWidth(3, 520);
  sh.setFrozenRows(1);
  var openRow = RICHMENU_DEFAULTS.map(function (r) { return r[0]; }).indexOf('最初から開く') + 2;
  sh.getRange(openRow, 2).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['はい', 'いいえ'], true).build());
  return true;
}

function staffRichMenuId_() {
  return PropertiesService.getScriptProperties().getProperty(RICHMENU_PROPERTY) || '';
}

/** ステータスが変わった人に、スタッフ用リッチメニューを付ける・外す（スタッフ用リッチメニューを作っていなければ何もしない） */
function syncStaffRichMenu_(rec) {
  var menuId = staffRichMenuId_();
  if (!menuId || !rec || !rec.userId) return;
  var path = '/user/' + encodeURIComponent(rec.userId) + '/richmenu';
  if (isStaffMenuTarget_(rec)) {
    if (!lineRequest_('post', path + '/' + encodeURIComponent(menuId))) {
      logError_('スタッフ用リッチメニュー', rec.userId, new Error('表示できませんでした：' + lastLineError_));
    }
  } else {
    lineRequest_('delete', path); // もともと付いていない人でも問題ない
  }
}

/** メニュー「スタッフ用リッチメニューを作成・更新」 */
function createStaffRichMenu() {
  var ui = SpreadsheetApp.getUi();
  var ss = spreadsheet_();
  if (ensureRichMenuSheet_(ss)) {
    ss.getSheetByName(RICHMENU_SHEET).activate();
    return ui.alert('シート「' + RICHMENU_SHEET + '」を作りました。\n「画像」に画像のURLを入れ、ボタンを確認してから、もう一度このメニューを選んでください。');
  }
  var settings = richMenuSettings_(ss.getSheetByName(RICHMENU_SHEET).getDataRange().getValues());

  var fileId = driveFileId_(settings['画像']);
  if (!fileId) return ui.alert('シート「' + RICHMENU_SHEET + '」の「画像」に、Googleドライブに入れた画像のURLを貼ってください。');
  var blob;
  try {
    blob = DriveApp.getFileById(fileId).getBlob();
  } catch (err) {
    return ui.alert('画像を開けませんでした。URLが正しいか、このスプレッドシートを使っているアカウントで開ける画像か確認してください。\n（' + err.message + '）');
  }
  var type = blob.getContentType();
  if (type !== 'image/png' && type !== 'image/jpeg') return ui.alert('画像は PNG か JPEG にしてください（いまの形式：' + type + '）。');
  var bytes = blob.getBytes();
  if (bytes.length > RICHMENU_IMAGE_MAX_BYTES) {
    return ui.alert('画像が大きすぎます（' + Math.round(bytes.length / 1024) + 'KB）。1MB（1024KB）以下にしてください。\n' +
      '画像を作ったアプリで JPEG（JPG）で保存し直すか、画質を少し下げると小さくなります。');
  }
  var def = richMenuDefinition_(settings, imageSize_(bytes), staffManualUrl_('staffmenu'));
  if (def.errors.length) return ui.alert('リッチメニューを作れませんでした', def.errors.join('\n'), ui.ButtonSet.OK);

  var statuses = staffMenuStatuses_();
  var targets = readAll_(REG_SHEET).map(function (x) { return x.rec; })
    .filter(function (r) { return isStaffMenuTarget_(r) && !r.blocked; })
    .map(function (r) { return r.userId; });
  var answer = ui.alert('スタッフ用リッチメニュー',
    'ステータスが「' + statuses.join('」「') + '」の ' + targets.length + '人に、このリッチメニューを表示します。\n' +
    '（あとからスタッフになった人にも、自動で表示されます）\n\n' +
    '・' + def.buttons.join('\n・') +
    (def.warnings.length ? '\n\n※ ' + def.warnings.join('\n※ ') : '') +
    '\n\nよろしいですか？', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;

  var created = lineRequest_('post', '/richmenu', def.menu);
  if (!created || !created.richMenuId) return ui.alert('リッチメニューを作れませんでした：' + lastLineError_);
  var menuId = created.richMenuId;
  var upload = UrlFetchApp.fetch(LINE_DATA_API + '/richmenu/' + encodeURIComponent(menuId) + '/content', {
    method: 'post',
    contentType: type,
    payload: blob,
    headers: { Authorization: 'Bearer ' + getConfig_().channelAccessToken },
    muteHttpExceptions: true
  });
  if (upload.getResponseCode() >= 300) {
    lineRequest_('delete', '/richmenu/' + encodeURIComponent(menuId));
    return ui.alert('画像を LINE に送れませんでした：' + lineErrorText_(upload.getResponseCode(), upload.getContentText()));
  }

  var failed = 0;
  for (var i = 0; i < targets.length; i += 500) {
    var chunk = targets.slice(i, i + 500);
    if (!lineRequest_('post', '/richmenu/bulk/link', { richMenuId: menuId, userIds: chunk })) failed += chunk.length;
  }

  // 前のスタッフ用リッチメニューを消す（付いていた人からは自動で外れる）
  var oldId = staffRichMenuId_();
  PropertiesService.getScriptProperties().setProperty(RICHMENU_PROPERTY, menuId);
  if (oldId && oldId !== menuId) lineRequest_('delete', '/richmenu/' + encodeURIComponent(oldId));

  ui.alert('スタッフ用リッチメニューを作りました',
    (targets.length - failed) + '人に表示しました（反映まで数分かかることがあります）。' +
    (failed ? '\n' + failed + '人には表示できませんでした：' + lastLineError_ : '') +
    '\n\nトーク画面に反映されないときは、トーク画面をいったん閉じて開き直してください。', ui.ButtonSet.OK);
}

/** メニュー「スタッフ用リッチメニューをやめる」 */
function removeStaffRichMenu() {
  var ui = SpreadsheetApp.getUi();
  var menuId = staffRichMenuId_();
  if (!menuId) return ui.alert('スタッフ用リッチメニューはまだ作っていません。');
  var answer = ui.alert('スタッフ用リッチメニューをやめる',
    'スタッフ用リッチメニューを削除します。スタッフにも、LINE Official Account Manager で作ったリッチメニュー（友だち全員用）が表示されるようになります。\nよろしいですか？',
    ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  if (!lineRequest_('delete', '/richmenu/' + encodeURIComponent(menuId)) && !/404/.test(lastLineError_)) {
    return ui.alert('削除できませんでした：' + lastLineError_);
  }
  PropertiesService.getScriptProperties().deleteProperty(RICHMENU_PROPERTY);
  ui.alert('スタッフ用リッチメニューを削除しました。');
}
