/**
 * 友だち追加後の最初のやりとり。
 * トークでお名前の「姓」だけを聞き、続きの項目（名を含む）は登録フォーム（LIFF）で入力してもらう。
 * フォームを開くと、ここで聞いた姓が入力済みになる（Api.gs の apiMe_）。
 *
 * やりとりの状態はシート「登録途中」に保存する。フォームから登録すると削除されるので、
 * このシートに残っている人は「お名前だけ答えてフォームを送信していない人」になる。
 *
 * chatPrompt_ / chatAnswer_ はシートに触れないので、tests/chat.test.js で動作を確認できる。
 */

var CHAT_CANCEL = 'やめる';

/** 質問の順番。最後の 'form' はフォームの入力待ち */
var CHAT_STEPS = {
  lastName: { label: '姓', next: 'form', question: 'はじめに、お名前の「姓」（苗字）を漢字で送ってください。\n例：山田' },
  // 以前は姓のあとに名も聞いていた（その途中の人のために残す。名は今はフォームで入力）
  firstName: { label: '名', next: 'form', question: '続いて、お名前の「名」（下の名前）を漢字で送ってください。\n例：花子' },
  form: { label: 'フォーム入力待ち' }
};

function formButton_(d) {
  return buttonMessage_(
    [d.lastName, d.firstName].filter(Boolean).join(' ') + ' さん、ありがとうございます！\n' +
    '続き（下のお名前・連絡先・住所・面接の希望日時など）は、こちらのフォームからご入力ください（約2分）。',
    '続きを入力する',
    registerUrl_()
  );
}

/** トークでお名前を聞いている途中か（false ならフォームの入力待ち） */
function chatAsking_(state) {
  return state.step !== 'form';
}

function chatNewState_(today) {
  return { step: 'lastName', data: {}, startedAt: today ? today.getTime() : Date.now() };
}

function chatPrompt_(state) {
  if (chatAsking_(state)) return [textMessage_(CHAT_STEPS[state.step].question)];
  return [formButton_(state.data)];
}

/**
 * 回答を1つ処理する。
 * @return {{state, messages, cancelled}}
 */
function chatAnswer_(state, input) {
  var text = String(input.text || '').trim();

  if (text === CHAT_CANCEL) {
    return { cancelled: true, messages: [textMessage_('登録を中断しました。\nもう一度始めるときは「登録」と送ってください。')] };
  }
  if (!chatAsking_(state)) {
    // お名前は回答済み：フォームのボタンを送り直す
    return { state: state, messages: chatPrompt_(state) };
  }

  // 姓の質問に「山田 花子」とフルネームが送られた場合は、姓と名に分けて受け取る
  var parts = text.split(/[\s　]+/);
  var answers = {};
  if (state.step === 'lastName' && parts.length === 2) {
    answers.lastName = parts[0];
    answers.firstName = parts[1];
  } else {
    answers[state.step] = parts.join('');
  }

  var v = new Validator_(answers);
  var keys = Object.keys(answers);
  for (var i = 0; i < keys.length; i++) {
    var value = v.text(keys[i], { max: 20 });
    if (v.errors[keys[i]]) {
      return { state: state, messages: [textMessage_(CHAT_STEPS[keys[i]].label + 'を' + v.errors[keys[i]])].concat(chatPrompt_(state)) };
    }
    state.data[keys[i]] = value;
    state.step = CHAT_STEPS[keys[i]].next;
  }
  return { state: state, messages: chatPrompt_(state) };
}

// ---- シートへの保存 ----

function loadChat_(userId) {
  var rec = readRecord_(CHAT_SHEET, userId);
  if (!rec || !rec.state) return null;
  try {
    var state = JSON.parse(rec.state);
    // 以前の形式のデータなどは使わない（最初からやり直してもらう）
    return CHAT_STEPS[state.step] ? state : null;
  } catch (err) {
    return null;
  }
}

function saveChat_(userId, state) {
  var fields = {
    question: CHAT_STEPS[state.step].label,
    state: JSON.stringify(state),
    startedAt: Utilities.formatDate(new Date(state.startedAt), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss'),
    updatedAt: now_()
  };
  // setup を実行し直す前（列がない）でも友だち追加のやりとりが止まらないよう、列があるときだけ書く
  var header = headerMap_(sheet_(CHAT_SHEET));
  // 返事があったら、リマインドは数え直す（また1日後・3日後に送る）
  if (header['リマインド回数'] !== undefined) {
    fields.remindCount = 0;
    fields.remindedAt = '';
  }
  if (header['氏名'] !== undefined) fields.name = chatName_(state);
  if (header['LINE表示名'] !== undefined) {
    // LINE表示名は最初の1回だけ取得して、やりとりの状態に覚えておく
    if (state.lineName === undefined) {
      state.lineName = lineDisplayName_(userId);
      fields.state = JSON.stringify(state);
    }
    fields.lineName = state.lineName;
  }
  writeRecord_(CHAT_SHEET, userId, fields);
}

/** LINE の表示名。取れなくても（ブロック中・通信エラーなど）登録のやりとりは止めない */
function lineDisplayName_(userId) {
  try {
    var profile = getLineProfile_(userId);
    return (profile && profile.displayName) || '';
  } catch (err) {
    console.warn('profile failed', err);
    return '';
  }
}

/** トークで答えたお名前（姓だけ答えた段階なら姓のみ） */
function chatName_(state) {
  var d = (state && state.data) || {};
  return [d.lastName, d.firstName].filter(Boolean).join(' ');
}

/**
 * setup から呼ぶ：「氏名」「LINE表示名」の列を LINEユーザーID のすぐ右に追加し、今いる人の分を埋める。
 */
function migrateChatSheet_(ss) {
  var sh = ss.getSheetByName(CHAT_SHEET);
  if (!sh || sh.getLastColumn() < 1) return;
  var header = headerMap_(sh);
  if (header['LINEユーザーID'] === undefined) return;
  ['LINE表示名', '氏名'].forEach(function (label) {
    if (headerMap_(sh)[label] !== undefined) return;
    var idCol = headerMap_(sh)['LINEユーザーID'] + 1;
    sh.insertColumnAfter(idCol);
    sh.getRange(1, idCol + 1).setValue(label);
  });
  header = headerMap_(sh);
  var last = sh.getLastRow();
  if (last < 2) return;
  var values = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  values.forEach(function (row, i) {
    var userId = row[header['LINEユーザーID']];
    if (!userId) return;
    var state = {};
    try { state = JSON.parse(row[header['回答内容（システム用）']] || '{}'); } catch (e) { /* 読めなければ空 */ }
    if (!row[header['氏名']]) sh.getRange(i + 2, header['氏名'] + 1).setValue(chatName_(state));
    if (!row[header['LINE表示名']]) {
      var lineName = lineDisplayName_(userId);
      if (lineName) sh.getRange(i + 2, header['LINE表示名'] + 1).setValue(lineName);
    }
  });
}

// ---- 登録途中の人へのリマインド ----

/** 最後のやりとりから何時間後に送るか（1回目・2回目）。全部送ったら、それ以上は送らない */
var CHAT_REMIND_AFTER_HOURS = [24, 72];
/** 送る時間帯（この時刻から、この時刻の前まで。夜中や早朝には送らない） */
var CHAT_REMIND_HOURS = [10, 20];

/** 「yyyy/MM/dd HH:mm:ss」（now_ の形式）や Date → Date */
function chatTime_(s) {
  if (Object.prototype.toString.call(s) === '[object Date]') return isNaN(s.getTime()) ? null : s;
  var m = /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || '').trim());
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
}

/** シート「登録途中」の行に、今リマインドを送るか */
function chatReminderDue_(rec, now) {
  if (!rec.userId || !rec.state) return false;
  var count = parseInt(rec.remindCount, 10) || 0;
  if (count >= CHAT_REMIND_AFTER_HOURS.length) return false;
  var last = chatTime_(rec.updatedAt);
  if (!last) return false;
  if (now.getHours() < CHAT_REMIND_HOURS[0] || now.getHours() >= CHAT_REMIND_HOURS[1]) return false;
  return now.getTime() >= last.getTime() + CHAT_REMIND_AFTER_HOURS[count] * 3600000;
}

/** リマインドのメッセージ。フォームの入力待ちならボタン、お名前の途中なら続きの質問 */
function chatReminderMessages_(state) {
  if (!chatAsking_(state)) {
    var d = state.data || {};
    var name = [d.lastName, d.firstName].filter(Boolean).join(' ');
    return [buttonMessage_(
      (name ? name + ' さん\n' : '') + 'スタッフ登録の途中です。あと少しで完了します（約2分）。\n下のボタンから、続きをご入力ください。',
      '続きを入力する',
      registerUrl_()
    )];
  }
  return [textMessage_('スタッフ登録の途中です。あと少しで完了します。\n' +
    '登録をやめる場合は「' + CHAT_CANCEL + '」と送ってください。')].concat(chatPrompt_(state));
}

/**
 * リマインドを送る（1分ごとの runScheduler から。force なら時間を待たずに全員へ：メニューから）。
 * @return {number} 送った人数
 */
function sendChatReminders_(now, force) {
  var sh = spreadsheet_().getSheetByName(CHAT_SHEET);
  if (!sh || sh.getLastRow() < 2) return 0;
  var header = headerMap_(sh);
  // setup を実行し直していない（列がない）と送った回数を残せず、1分ごとに送り続けてしまうため送らない
  if (header['リマインド回数'] === undefined || header['リマインド送信日時'] === undefined) return 0;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var sent = 0;
  rows.forEach(function (values) {
    var rec = rowToRecord_(CHAT_SHEET, header, values);
    if (!rec.userId) return;
    if (force) {
      // メニューから送るとき：1時間以内に送った人には送らない（押し間違いで2回送らないように）
      var prev = chatTime_(rec.remindedAt);
      if (prev && now - prev < 3600000) return;
    } else if (!chatReminderDue_(rec, now)) {
      return;
    }
    try {
      var state = JSON.parse(rec.state);
      if (!CHAT_STEPS[state.step]) return;
      var ok = pushMessage_(rec.userId, chatReminderMessages_(state));
      // 送れなかったときも回数は進める（1分ごとに送り直し続けないように）
      writeRecord_(CHAT_SHEET, rec.userId, { remindCount: (parseInt(rec.remindCount, 10) || 0) + 1, remindedAt: now_() });
      if (ok) sent++;
      else logError_('登録途中のリマインド', rec.userId, new Error(lastLineError_ || 'LINE への送信に失敗しました'));
    } catch (err) {
      logError_('登録途中のリマインド', rec.userId, err);
    }
  });
  return sent;
}

/** メニュー「登録途中の人にリマインドを今すぐ送る」 */
function sendChatRemindersNow() {
  var ui = SpreadsheetApp.getUi();
  var sh = sheet_(CHAT_SHEET);
  var n = Math.max(0, lastDataRow_(sh, headerMap_(sh)) - 1);
  if (!n) return ui.alert('登録途中の人はいません。');
  var answer = ui.alert('登録途中の人にリマインドを送る',
    'シート「登録途中」の ' + n + ' 人に、登録の続きをお願いするメッセージを今すぐ送ります（1時間以内に送った人を除く）。よろしいですか？',
    ui.ButtonSet.OK_CANCEL);
  if (answer !== ui.Button.OK) return;
  ui.alert(sendChatReminders_(new Date(), true) + ' 人に送りました。「リマインド送信日時」の列で確認できます。');
}

