/**
 * スプレッドシートの読み書き。
 * 列は見出し（1行目）の名前で探すため、管理用の列を追加したり並べ替えたりしても動作します。
 * 見出しの文字は変更しないでください。
 */

var REG_SHEET = 'スタッフ登録';
var ONB_SHEET = '労務情報';
var CHAT_SHEET = '登録途中'; // チャットで回答中の人（途中でやめた人もここに残る）
var SHIFT_SHEET = 'シフト提出'; // 毎月のシフト（出勤できる日）。1人1か月1行
var LOG_SHEET = 'エラーログ'; // フォーム・LINE・自動送信で起きたエラー（新しいものが下）
var LOG_MAX_ROWS = 1000;
var JOB_SHEET = '案件一覧';   // お客様からの案件（Jobs.gs）
var APPLY_SHEET = '案件応募'; // LINE で配信した案件への応募
var IMPORT_SHEET = '案件取込履歴';
var PARTNER_SHEET = '取引先一覧'; // freee の取引先（「案件一覧」の取引先名の選択肢。freee から読み込む）
var MANUAL_LOG_SHEET = 'マニュアル閲覧';     // スタッフマニュアルを開いた・章を読み終えた記録（Manual.gs）
var MANUAL_SUMMARY_SHEET = 'マニュアル集計'; // 閲覧数のまとめ（毎朝とメニューから作り直す）
var RICHMENU_SHEET = 'リッチメニュー設定';    // スタッフ用リッチメニューの画像とボタン（RichMenu.gs）

var STATUS = {
  PRE: '仮登録',                    // フォーム送信済み。書類選考待ち
  DOC_PASSED: '書類通過',            // 管理者が設定 → 面接候補日を自動送信して「面接日程調整中」に
  DOC_FAILED: '書類落選',            // 管理者が設定 → すぐに不採用通知を自動送信
  INTERVIEW_OFFERED: '面接日程調整中', // 候補日を送信済み。応募者の選択待ち
  RESCHEDULE: '日程再調整',          // 応募者が「どれも都合が合わない」を選択。担当者が個別に調整
  INTERVIEW_FIXED: '面接確定',        // 日時決定。当日9時にリマインド、時刻に通話ボタンを自動送信
  HIRED: '採用',                    // 管理者が設定 → 書類提出の案内を自動送信
  DOC_REQUESTED: '書類依頼済',        // 案内を送信済み
  DOC_SUBMITTED: '書類提出済',        // 書類フォーム送信済み。管理者が内容を確認
  ACTIVE: '稼働可',                  // 確認完了。シフトに入れる状態
  REJECTED: '不採用',                // 面接後に管理者が設定 → 翌日の午前10時に不採用通知を自動送信
  LEFT: '退会'
};

/** 書類提出フォームを使える状態 */
var ONBOARDING_ALLOWED = [STATUS.HIRED, STATUS.DOC_REQUESTED, STATUS.DOC_SUBMITTED];

var COLUMNS = {};

COLUMNS[REG_SHEET] = [
  ['userId', 'LINEユーザーID'],
  ['status', 'ステータス'],
  ['lineName', 'LINE表示名'],
  ['source', '登録方法'],
  ['registeredAt', '初回登録日時'],
  ['updatedAt', '最終更新日時'],
  ['lastName', '姓'],
  ['firstName', '名'],
  ['lastNameKana', 'セイ'],
  ['firstNameKana', 'メイ'],
  ['birthDate', '生年月日'],
  ['age', '年齢（登録時）'],
  ['ageNote', '年齢による制限'],
  ['gender', '性別'],
  ['phone', '電話番号'],
  ['email', 'メールアドレス'],
  ['postalCode', '郵便番号'],
  ['prefecture', '都道府県'],
  ['city', '市区町村・番地'],
  ['building', '建物名・部屋番号'],
  ['nearestStation', '最寄り駅'],
  ['occupation', '職業区分'],
  ['weekdays', '勤務可能曜日'],
  ['areas', '希望エリア'],
  ['driverLicense', '普通自動車免許'],
  ['languages', '語学'],
  ['height', '身長(cm)'],
  ['clothingSize', '服のサイズ'],
  ['shoeSize', '靴のサイズ(cm)'],
  ['hairColor', '髪色'],
  ['clothes', 'お持ちの服装'],
  ['interview1', '希望面接日時（第1希望）'],
  ['interview2', '希望面接日時（第2希望）'],
  ['interview3', '希望面接日時（第3希望）'],
  ['interview4', '希望面接日時（第4希望）'],
  ['offer1', '候補に送る（第1希望）'],
  ['offer2', '候補に送る（第2希望）'],
  ['offer3', '候補に送る（第3希望）'],
  ['offer4', '候補に送る（第4希望）'],
  ['interviewAt', '面接日時（確定）'],
  ['statusChangedAt', 'ステータス変更日時'],
  ['offerSentAt', '候補日の送信日時'],
  ['reminderSentAt', 'リマインド送信日時'],
  ['callSentAt', '通話案内の送信日時'],
  ['rejectNotifiedAt', '不採用通知の送信日時'],
  ['shiftRequestedMonth', 'シフト提出の案内（送信済みの月）'],
  ['calendarEventId', 'カレンダー予定ID'],
  ['calendarAt', 'カレンダーに登録した面接日時'],
  ['meetUrl', 'Google Meet URL'],
  ['note', '自己PR・備考'],
  ['referralSource', '当社を知ったきっかけ'],
  ['privacyConsentAt', '個人情報同意日時'],
  ['antisocialConsentAt', '反社会的勢力でない旨の表明日時'],
  ['blocked', 'LINEブロック'],
  ['adminMemo', '管理メモ']
];

COLUMNS[ONB_SHEET] = [
  ['userId', 'LINEユーザーID'],
  ['name', '氏名'],
  ['submittedAt', '初回提出日時'],
  ['updatedAt', '最終更新日時'],
  ['nationality', '国籍'],
  ['residenceStatus', '在留資格'],
  ['residenceExpiry', '在留期間の満了日'],
  ['workPermission', '資格外活動許可'],
  ['workCheck', '就労可否の確認事項'],
  ['residenceCardFront', '在留カード（表）'],
  ['residenceCardBack', '在留カード（裏）'],
  ['idType', '本人確認書類'],
  ['idFront', '本人確認書類（表）'],
  ['idBack', '本人確認書類（裏）'],
  ['facePhoto', '顔写真'],
  ['bankName', '銀行名'],
  ['branchName', '支店名'],
  ['accountType', '口座種別'],
  ['accountNumber', '口座番号'],
  ['accountHolder', '口座名義（カナ）'],
  ['emergencyName', '緊急連絡先 氏名'],
  ['emergencyRelation', '緊急連絡先 続柄'],
  ['emergencyPhone', '緊急連絡先 電話番号'],
  ['otherJob', '他社での勤務'],
  ['taxDeclarationElsewhere', '他社への扶養控除等申告書'],
  ['health', '健康上の配慮事項'],
  ['confidentialityConsentAt', '守秘義務同意日時'],
  ['verifiedBy', '書類確認者'],
  ['verifiedAt', '書類確認日']
];

COLUMNS[CHAT_SHEET] = [
  ['userId', 'LINEユーザーID'],
  ['name', '氏名'],             // トークで答えたお名前（答える前は空）
  ['lineName', 'LINE表示名'],   // 名前を答える前でも誰かわかるように
  ['question', '回答中の質問'],
  ['state', '回答内容（システム用）'],
  ['startedAt', '開始日時'],
  ['updatedAt', '最終更新日時'],
  ['remindCount', 'リマインド回数'],      // 返事があると 0 に戻る
  ['remindedAt', 'リマインド送信日時']
];

// 1〜31日の列には「○」（出勤できる）か「×」（出勤できない）が入る
COLUMNS[SHIFT_SHEET] = [
  ['userId', 'LINEユーザーID'],
  ['month', '対象月'],
  ['name', '氏名'],
  ['areas', '希望エリア（提出時）'],
  ['availableDays', '出勤可能日数'],
  ['submittedAt', '初回提出日時'],
  ['updatedAt', '最終更新日時'],
  ['note', '備考']
];
for (var shiftDay_ = 1; shiftDay_ <= 31; shiftDay_++) COLUMNS[SHIFT_SHEET].push(['d' + shiftDay_, shiftDay_ + '日']);

// 「案件一覧」の列。前半21列はこれまで使っていた案件表と同じ並び。
COLUMNS[JOB_SHEET] = [
  ['client', '取引先名'],
  ['title', 'タイトル'],
  ['place', '場所'],
  ['work', '仕事内容'],
  ['role', 'ポジション'], // D / AD / ST
  ['date', '日程'],
  ['start', '開始時間'],
  ['end', '終了時間'],
  ['weekday', '曜日'],
  ['breakHours', '休憩時間'],
  ['workHours', '実働時間'],
  ['dress', '服装'],
  ['belongings', '持ち物'],
  ['unit', '単位'],         // 時給 / 日給
  ['unitPrice', '単価'],
  ['sales', '売上'],
  ['transport', '交通費'],
  ['meal', '食費'],
  ['total', '総支払額'],
  ['invoice', '請求書'],
  ['salesMonth', '売上計上月'],
  ['paymentMonth', '入金予定月'],
  // ---- ここから追加の列 ----
  ['headcount', '人数'],
  ['conditions', '募集条件'],
  ['meetingTime', '集合時間'],
  ['meetingPlace', '集合場所'],
  ['address', '住所・アクセス'],
  ['contactName', '集合担当者名'],
  ['contactPhone', '集合担当連絡先'],
  ['notes', '備考'],
  ['staffPay', 'スタッフ向け給与'],
  ['staffTransport', 'スタッフ向け交通費'],
  ['detailImages', '詳細連絡の画像'], // Google ドライブのファイルID（カンマ区切り）
  ['recruit', '募集状況'],
  ['sentAt', '配信日時'],
  ['sentCount', '配信人数'],
  ['applied', '応募人数'],
  ['prefecture', '都道府県'],
  ['genderReq', '性別'],
  ['caseId', '案件ID'],
  ['slotId', '枠ID'],
  ['importId', '取込ID'],
  ['freeeInvoice', 'freee請求書番号'] // freee に請求書を作ると自動で入る（入っている行は二重に作らない）
];

COLUMNS[APPLY_SHEET] = [
  ['appliedAt', '応募日時'],
  ['status', '状態'],              // 応募・確定・見送り・辞退
  ['workStatus', '勤務ステータス'], // 詳細送付済〜出勤・欠勤など（Jobs.gs の WORK_STATUS）
  ['slotId', '枠ID'],
  ['caseId', '案件ID'],
  ['title', 'タイトル'],
  ['date', '日程'],          // 「案件一覧」と同じ（変えると自動で反映）
  ['start', '開始予定時間'], // 〃
  ['end', '終了予定時間'],   // 〃
  // ---- 実際の勤務と給与（担当者が入力。実働時間・給与額は自動で計算） ----
  ['actualStart', '勤務開始時間'],
  ['actualEnd', '勤務終了時間'],
  ['actualBreak', '休憩時間'],     // 時間（1、0.5 など）。「45分」「1:00」でも可
  ['actualHours', '実働時間'],     // 自動：勤務終了 − 勤務開始 − 休憩
  ['payUnit', '給与形態'],         // 時給・日給（応募時に「スタッフ向け給与」から入る）
  ['payRate', '単価'],             // 〃
  ['pay', '給与額'],               // 自動：時給は 単価 × 実働時間、日給は 単価
  ['name', '氏名'],
  ['phone', '電話番号'],
  ['userId', 'LINEユーザーID'],
  ['notifiedAt', '結果の通知日時'],
  ['detailSentAt', '詳細連絡日時'],
  ['fare', '交通費（往復）'],      // スタッフからの返信
  ['departure', '出発時間'],        // スタッフからの返信
  ['travelRepliedAt', '交通費・出発時間の返信日時'],
  ['departCheckSentAt', '出発確認の送信日時'],
  ['departAnswer', '出発確認の回答'],
  ['departAnsweredAt', '出発確認の回答日時'],
  ['departAlertAt', '担当者への通知日時'],
  ['endCheckSentAt', '終了確認の送信日時'],
  ['endReport', '終了報告（返信内容）'],
  ['endReportAt', '終了報告の日時'],
  ['adminMemo', '管理メモ']
];

COLUMNS[MANUAL_LOG_SHEET] = [
  ['at', '日時'],
  ['date', '日付'],
  ['visitor', '閲覧者ID'],      // 端末ごとの記号（LINE で開かなかった人も数えるため）
  ['userId', 'LINEユーザーID'],  // スタッフ用リッチメニュー（LIFF）から開いたときだけ入る
  ['name', '氏名'],
  ['event', '操作'],            // 開いた / 章を読み終えた
  ['chapter', '章'],
  ['title', '章の名前'],
  ['total', '全体の章の数'],
  ['from', '開いた場所']
];

COLUMNS[PARTNER_SHEET] = [
  ['name', '取引先名'],
  ['longName', '正式名称'],
  ['partnerId', 'freee取引先ID'],
  ['loadedAt', '読み込み日時']
];

COLUMNS[IMPORT_SHEET] = [
  ['importId', '取込ID'],
  ['at', '取込日時'],
  ['client', '取引先名'],
  ['cases', '案件数'],
  ['rows', '行数'],
  ['text', '原文']
];

/**
 * 書式なしテキストにする列（指定がないシートはすべての列）。
 * 日付・時刻は Sheets が自動で日時に変換すると読み戻すときにずれるため、文字のまま保存する。
 */
var TEXT_COLUMNS = {};
TEXT_COLUMNS[JOB_SHEET] = ['日程', '開始時間', '終了時間', '曜日', '売上計上月', '入金予定月', '集合時間', '集合担当者名', '集合担当連絡先', '詳細連絡の画像', '配信日時', '案件ID', '枠ID', '取込ID', 'freee請求書番号'];

var spreadsheetCache_ = null;

/** 1回の実行の中では、スプレッドシートを開くのは1回だけにする（開く処理は時間がかかる） */
COLUMNS[LOG_SHEET] = [
  ['at', '日時'],
  ['kind', '場所'],
  ['user', 'LINEユーザーID（末尾8桁）'],
  ['message', '内容']
];

/** エラーを「エラーログ」シートに残す（記録に失敗しても元の処理は止めない） */
function logError_(kind, userId, err) {
  try {
    var sh = spreadsheet_().getSheetByName(LOG_SHEET);
    if (!sh) return;
    var message = (err && err.message) || String(err);
    sh.appendRow([now_(), kind, userId ? String(userId).slice(-8) : '', message.slice(0, 500)]);
    if (sh.getLastRow() > LOG_MAX_ROWS + 100) sh.deleteRows(2, 100);
  } catch (e) {
    console.error('logError_ failed', e);
  }
}

function spreadsheet_() {
  if (!spreadsheetCache_) spreadsheetCache_ = SpreadsheetApp.openById(getConfig_().spreadsheetId);
  return spreadsheetCache_;
}

function sheet_(name) {
  var sh = spreadsheet_().getSheetByName(name);
  if (!sh) throw new Error('シート「' + name + '」がありません。setup を実行してください');
  return sh;
}

function now_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
}

function labelOf_(sheetName, key) {
  var cols = COLUMNS[sheetName];
  for (var i = 0; i < cols.length; i++) if (cols[i][0] === key) return cols[i][1];
  throw new Error('未定義の項目です: ' + key);
}

/** 見出し名 → 列番号(0始まり) */
function headerMap_(sh) {
  var map = {};
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  headers.forEach(function (h, i) { if (h) map[h] = i; });
  return map;
}

/** データが入っている最後の行（LINEユーザーIDの列で判定）。見出しだけなら 1 */
function lastDataRow_(sh, header) {
  var last = sh.getLastRow();
  if (last < 2) return 1;
  var ids = sh.getRange(2, header['LINEユーザーID'] + 1, last - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) {
    if (ids[i][0] !== '' && ids[i][0] !== null) return i + 2;
  }
  return 1;
}

/**
 * 最後のデータより下の行に残っている値（以前のチェックボックスの FALSE など）を消す。
 * 値が残っているとシートの最終行が下に伸び、確認しづらくなるため。
 */
function clearEmptyRows_(sh) {
  var last = sh.getLastRow();
  var lastData = lastDataRow_(sh, headerMap_(sh));
  if (last > lastData) sh.getRange(lastData + 1, 1, last - lastData, sh.getLastColumn()).clearContent();
}

function findRow_(sh, header, userId) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, header['LINEユーザーID'] + 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (ids[i][0] === userId) return i + 2;
  return -1;
}

function rowToRecord_(sheetName, header, values) {
  var rec = {};
  COLUMNS[sheetName].forEach(function (c) {
    var i = header[c[1]];
    if (i !== undefined) rec[c[0]] = values[i];
  });
  return rec;
}

/** userId の行を読み込む。なければ null */
function readRecord_(sheetName, userId) {
  var sh = sheet_(sheetName);
  var header = headerMap_(sh);
  var row = findRow_(sh, header, userId);
  if (row < 0) return null;
  return rowToRecord_(sheetName, header, sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0]);
}

/** 数式として解釈されないように（CSV/数式インジェクション対策） */
function cellValue_(v) {
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

/**
 * userId の行に fields を書き込む（なければ追加）。fields に含まれない列はそのまま残る。
 */
function writeRecord_(sheetName, userId, fields) {
  var lock = LockService.getScriptLock();
  // 同時に書き込みが重なったときは順番を待つ。待ちきれなければ、応募者にやり直してもらう
  if (!lock.tryLock(30000)) throw new UserError('ただいま混み合っています。少し時間をおいて、もう一度お試しください。');
  try {
    var sh = sheet_(sheetName);
    var header = headerMap_(sh);
    var width = sh.getLastColumn();
    var row = findRow_(sh, header, userId);
    var values = row > 0 ? sh.getRange(row, 1, 1, width).getValues()[0] : new Array(width).fill('');
    fields.userId = userId;
    Object.keys(fields).forEach(function (key) {
      var label = labelOf_(sheetName, key);
      var i = header[label];
      if (i === undefined) {
        console.error('シート「' + sheetName + '」に列「' + label + '」がありません。setup を実行してください');
        throw new UserError('システムの設定に不備があり、保存できませんでした。お手数ですが、トークで担当者にお知らせください。');
      }
      values[i] = cellValue_(fields[key]);
    });
    if (row < 0) row = lastDataRow_(sh, header) + 1;
    sh.getRange(row, 1, 1, width).setValues([values]);
  } finally {
    lock.releaseLock();
  }
}

function deleteRecord_(sheetName, userId) {
  var lock = LockService.getScriptLock();
  // 同時に書き込みが重なったときは順番を待つ。待ちきれなければ、応募者にやり直してもらう
  if (!lock.tryLock(30000)) throw new UserError('ただいま混み合っています。少し時間をおいて、もう一度お試しください。');
  try {
    var sh = sheet_(sheetName);
    var row = findRow_(sh, headerMap_(sh), userId);
    if (row > 0) sh.deleteRow(row);
  } finally {
    lock.releaseLock();
  }
}

function setStatus_(userId, status) {
  writeRecord_(REG_SHEET, userId, { status: status, updatedAt: now_() });
}

/** 「スタッフ登録」でグレーにするステータス（選考が終わった人・やめた人） */
var INACTIVE_STATUSES = [STATUS.DOC_FAILED, STATUS.REJECTED, STATUS.LEFT];

/** ステータス → 行をグレーにする条件付き書式の数式（2行目の形。シートが行ごとにずらして使う） */
function inactiveRowFormula_(statusColLetter) {
  return '=OR(' + INACTIVE_STATUSES.map(function (s) { return '$' + statusColLetter + '2="' + s + '"'; }).join(',') + ')';
}

/** 「スタッフ登録」で、書類落選・不採用・退会の人の行をグレーにする（条件付き書式。何度実行しても1つだけ） */
function grayOutInactiveRows_(sh, statusCol) {
  var letter = sh.getRange(1, statusCol).getA1Notation().replace(/\d+/g, '');
  var formula = inactiveRowFormula_(letter);
  var mine = function (rule) {
    var c = rule.getBooleanCondition();
    var v = c && c.getCriteriaValues();
    // 以前この関数が付けたもの（ステータスの列が変わっていても）を入れ替える
    return !!(v && v.length && String(v[0]).indexOf('"' + STATUS.LEFT + '"') >= 0 && String(v[0]).indexOf('=OR($') === 0);
  };
  var rules = sh.getConditionalFormatRules().filter(function (r) { return !mine(r); });
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(formula)
    .setBackground('#e0e0e0')
    .setFontColor('#757575')
    .setRanges([sh.getRange(2, 1, sh.getMaxRows() - 1, sh.getMaxColumns())])
    .build());
  sh.setConditionalFormatRules(rules);
}

/** シートの作成・見出し・書式を整える（何度実行しても安全） */
function ensureSheet_(ss, name) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var cols = COLUMNS[name];
  var existing = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
  var missing = cols.map(function (c) { return c[1]; }).filter(function (l) { return existing.indexOf(l) < 0; });
  if (missing.length) {
    var start = existing.filter(String).length + 1;
    if (sh.getMaxColumns() < start + missing.length - 1) {
      sh.insertColumnsAfter(sh.getMaxColumns(), start + missing.length - 1 - sh.getMaxColumns());
    }
    sh.getRange(1, start, 1, missing.length).setValues([missing]);
  }
  sh.setFrozenRows(1);
  sh.setFrozenColumns(2);
  sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold').setBackground('#f3e5f5');
  var textCols = TEXT_COLUMNS[name];
  if (textCols) {
    // 金額や時間を計算できるよう、日付・時刻・IDの列だけを書式なしテキストにする
    var header = headerMap_(sh);
    textCols.forEach(function (label) {
      sh.getRange(2, header[label] + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
    });
  } else {
    // 電話番号・口座番号の先頭の0が消えないよう、すべて書式なしテキストにする
    sh.getRange(2, 1, sh.getMaxRows() - 1, sh.getLastColumn()).setNumberFormat('@');
  }
  return sh;
}
