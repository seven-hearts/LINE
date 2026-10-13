/**
 * セブンハーツ スタッフ登録ツール（Google Apps Script）
 *
 * - LINE公式アカウントの Webhook（友だち追加後、トークで質問してスタッフ登録・キーワード応答）
 * - LIFF フォームからの登録内容の変更・書類提出 API
 * - スプレッドシートでステータスを「採用」にすると書類提出の案内を自動送信
 * - 毎月25日に「稼働可」のスタッフへ翌月のシフト提出フォームを送り、勤務エリアごとに集計（Shift.gs）
 *
 * 設定値はすべて「プロジェクトの設定 > スクリプト プロパティ」に保存します（README参照）。
 */

/** 個人情報の取り扱いページ（liff/privacy.html）。別のページを使う場合はスクリプト プロパティ PRIVACY_POLICY_URL で上書き */
var DEFAULT_PRIVACY_POLICY_URL = 'https://seven-hearts.github.io/LINE/liff/privacy.html';

/** 案件の読み取りに使う Claude のモデル。スクリプト プロパティ CLAUDE_MODEL で変更できる */
var DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
/** 案件の読み取りに使う Gemini のモデル（最新の Flash を指す名前）。スクリプト プロパティ GEMINI_MODEL で変更できる */
var DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';
/** 予備のモデル（軽量版。混雑しにくく、無料枠も別に数えられる）。スクリプト プロパティ GEMINI_FALLBACK_MODELS で変更できる */
var DEFAULT_GEMINI_FALLBACK_MODELS = ['gemini-flash-lite-latest'];

function getConfig_() {
  var p = PropertiesService.getScriptProperties().getProperties();
  return {
    channelAccessToken: p.CHANNEL_ACCESS_TOKEN,
    loginChannelId: p.LOGIN_CHANNEL_ID,
    liffId: p.LIFF_ID,
    webhookToken: p.WEBHOOK_TOKEN,
    spreadsheetId: p.SPREADSHEET_ID,
    driveFolderId: p.DRIVE_FOLDER_ID,
    adminEmail: p.ADMIN_EMAIL || '',
    privacyPolicyUrl: p.PRIVACY_POLICY_URL || DEFAULT_PRIVACY_POLICY_URL,
    callUrl: (p.CALL_URL || '').trim(),
    // 面接を登録する Google カレンダー（空ならスクリプトを実行する人のメインのカレンダー、off なら登録しない）
    calendarId: (p.CALENDAR_ID || '').trim(),
    interviewMinutes: /^\d+$/.test((p.INTERVIEW_MINUTES || '').trim()) ? +p.INTERVIEW_MINUTES.trim() : 30,
    anthropicApiKey: (p.ANTHROPIC_API_KEY || '').trim(),
    claudeModel: (p.CLAUDE_MODEL || '').trim() || DEFAULT_CLAUDE_MODEL,
    geminiApiKey: (p.GEMINI_API_KEY || '').trim(),
    geminiModel: (p.GEMINI_MODEL || '').trim() || DEFAULT_GEMINI_MODEL,
    // Gemini が混み合っているときなどに切り替える予備のモデル（カンマ区切り。off なら切り替えない）
    geminiFallbackModels: geminiFallbackModels_(p.GEMINI_FALLBACK_MODELS),
    // 読み取りに使う AI。AI_PROVIDER（gemini / claude）がなければ、APIキーが入っているほうを使う
    aiProvider: aiProvider_(p),
    // 入金予定月 = 売上計上月の何か月後か（取引先ごとに違う場合はシートで直してください）
    paymentMonthsAfter: /^\d+$/.test((p.PAYMENT_MONTHS_AFTER || '').trim()) ? +p.PAYMENT_MONTHS_AFTER.trim() : 1
  };
}

function geminiFallbackModels_(v) {
  v = (v || '').trim();
  if (v.toLowerCase() === 'off') return [];
  if (!v) return DEFAULT_GEMINI_FALLBACK_MODELS.slice();
  return v.split(',').map(function (m) { return m.trim(); }).filter(Boolean);
}

function aiProvider_(p) {
  var v = (p.AI_PROVIDER || '').trim().toLowerCase();
  if (v === 'gemini' || v === 'claude') return v;
  if ((p.GEMINI_API_KEY || '').trim()) return 'gemini';
  return 'claude';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * LINE の Webhook（URL に ?token=... 付き）と、LIFF フォームからの API の両方を受ける。
 * Apps Script ではリクエストヘッダー（署名）を読めないため、Webhook は URL のトークンで本人確認する。
 */
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: '不正なリクエストです' });
  }

  if (e.parameter && e.parameter.token !== undefined) {
    if (!getConfig_().webhookToken || e.parameter.token !== getConfig_().webhookToken) {
      return json_({ ok: false });
    }
    handleWebhook_(body);
    return json_({ ok: true });
  }

  return json_(handleApi_(body));
}

/**
 * コードの版。コードを変えるたびに更新する。
 * checkSettings がウェブアプリ（デプロイ済み）の版と比べて、デプロイし忘れを見つける。
 */
var APP_VERSION = '2026-10-13.9';

function doGet() {
  return json_({ ok: true, service: 'sevenhearts-staff-registration', version: APP_VERSION });
}

/** 新しい登録・書類提出を管理者にメールで知らせる（個人情報は本文に含めない） */
function notifyAdmin_(subject, name) {
  var to = getConfig_().adminEmail;
  if (!to) return;
  try {
    MailApp.sendEmail(to, '[セブンハーツ] ' + subject + '：' + name,
      name + ' さんの' + subject + 'がありました。\n内容はスプレッドシートで確認してください。\n' + spreadsheet_().getUrl());
  } catch (err) {
    console.error('notifyAdmin failed', err);
  }
}

/**
 * 初回セットアップ。Apps Script エディタで一度だけ実行してください（何度実行しても安全です）。
 * - シートの作成と見出しの設定
 * - 提出書類を保存する Google ドライブのフォルダの作成
 * - ステータス変更を検知するトリガーの登録
 * - Google カレンダーの権限の確認（面接日時を登録するため）
 */
function setup() {
  var props = PropertiesService.getScriptProperties();

  var ss = props.getProperty('SPREADSHEET_ID')
    ? SpreadsheetApp.openById(props.getProperty('SPREADSHEET_ID'))
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('スプレッドシートから「拡張機能 > Apps Script」で開いたプロジェクトで実行するか、SPREADSHEET_ID を設定してください');
  props.setProperty('SPREADSHEET_ID', ss.getId());

  var reg = ensureSheet_(ss, REG_SHEET);
  ensureSheet_(ss, ONB_SHEET);
  ensureSheet_(ss, CHAT_SHEET);
  ensureSheet_(ss, SHIFT_SHEET);
  ensureSheet_(ss, LOG_SHEET);
  setupJobSheets_(ss);

  var statusCol = headerMap_(reg)['ステータス'] + 1;
  var values = Object.keys(STATUS).map(function (k) { return STATUS[k]; });
  reg.getRange(2, statusCol, reg.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build()
  );

  if (!props.getProperty('DRIVE_FOLDER_ID')) {
    var folder = DriveApp.createFolder('セブンハーツ_スタッフ提出書類');
    props.setProperty('DRIVE_FOLDER_ID', folder.getId());
  }

  if (!props.getProperty('WEBHOOK_TOKEN')) {
    props.setProperty('WEBHOOK_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  }

  // 「候補に送る（第1〜第4希望）」はチェックボックス。
  // insertCheckboxes は空の行にも「FALSE」を書き込み、シートの最終行が下に伸びてしまうため、
  // 入力規則（チェックボックス）だけを付ける（空のセルはチェックなしとして表示される）
  var regHeader = headerMap_(reg);
  var checkbox = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  INTERVIEW_KEYS.forEach(function (k, i) {
    var col = regHeader[labelOf_(REG_SHEET, 'offer' + (i + 1))] + 1;
    reg.getRange(2, col, reg.getMaxRows() - 1, 1).setDataValidation(checkbox);
  });
  clearEmptyRows_(reg);

  var handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  if (handlers.indexOf('onStatusEdit') < 0) ScriptApp.newTrigger('onStatusEdit').forSpreadsheet(ss).onEdit().create();
  // リマインド・通話ボタン・不採用通知・シフト提出の案内を時刻どおりに送るため、1分ごとに確認する
  if (handlers.indexOf('runScheduler') < 0) ScriptApp.newTrigger('runScheduler').timeBased().everyMinutes(1).create();

  // カレンダーの権限をここで許可してもらう（許可がないと、1分ごとの自動処理でカレンダーに登録できない）
  if (getConfig_().calendarId.toLowerCase() !== 'off') interviewCalendar_();

  console.log('セットアップ完了');
  console.log('Webhook URL: <ウェブアプリのURL>?token=' + props.getProperty('WEBHOOK_TOKEN'));
}

/**
 * インストール型トリガー（setup で登録）。「スタッフ登録」シートでステータスを変えたときの処理。
 * - 書類通過 → 面接候補を送って「面接日程調整中」に
 * - 面接確定（管理者が手入力した場合）→ 確定の連絡と LINEコールの使い方を送る
 * - 書類落選 → すぐに不採用通知を送る
 * - 不採用 → 変更時刻を記録（通知は runScheduler が翌日の午前10時に送る）
 * - 採用 → 書類提出の案内を送って「書類依頼済」に
 * シート「案件応募」の「状態」を変えたときは onApplyEdit_（JobsApp.gs）で確定・見送りの連絡を送る。
 */
function onStatusEdit(e) {
  var sh = e.range.getSheet();
  if (sh.getName() === APPLY_SHEET) return onApplyEdit_(e);
  if (sh.getName() === JOB_SHEET) return onJobSheetEdit_(e);
  if (sh.getName() !== REG_SHEET) return;
  var header = headerMap_(sh);
  var statusCol = header['ステータス'] + 1;
  if (e.range.getColumn() > statusCol || e.range.getLastColumn() < statusCol) return;

  var firstRow = Math.max(e.range.getRow(), 2);
  var lastRow = e.range.getLastRow();
  if (lastRow < firstRow) return;
  var rows = sh.getRange(firstRow, 1, lastRow - firstRow + 1, sh.getLastColumn()).getValues();

  rows.forEach(function (values) {
    var rec = rowToRecord_(REG_SHEET, header, values);
    if (!rec.userId) return;
    try {
      writeRecord_(REG_SHEET, rec.userId, { statusChangedAt: now_(), rejectNotifiedAt: '', updatedAt: now_() });
      switch (rec.status) {
        case STATUS.DOC_PASSED:
          sendInterviewOffer_(rec);
          break;
        case STATUS.DOC_FAILED:
          // すぐに送る。送れなかった場合も runScheduler が1分以内に送り直す
          runAction_(rec, 'docReject', '');
          break;
        case STATUS.INTERVIEW_FIXED:
          sendInterviewFixedByAdmin_(rec);
          break;
        case STATUS.HIRED:
          var sent = pushMessage_(rec.userId, [
            textMessage_(fullName_(rec) + ' さん\n\n選考の結果、セブンハーツのスタッフとして採用となりました！\n\n' +
              'お仕事を始めていただくために、下のボタンから書類をご提出ください。'),
            onboardingButton_()
          ]);
          if (sent) setStatus_(rec.userId, STATUS.DOC_REQUESTED);
          break;
      }
    } catch (err) {
      console.error('onStatusEdit failed', rec.userId, err && err.stack || err);
      logError_('ステータス変更：' + rec.status, rec.userId, err);
    }
  });
}
