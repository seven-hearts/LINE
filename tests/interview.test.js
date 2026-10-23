// 書類選考〜面接の自動送信（gas/Interview.gs）の判定と文面を Node で検証する: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
for (const f of ['Options.gs', 'Validation.gs', 'Line.gs', 'Sheet.gs', 'Interview.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
}
const S = ctx.STATUS;
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi || 0);
const rec = (o) => Object.assign({ userId: 'U1', lastName: '山田', firstName: '花子' }, o);
const actions = (r, now) => Array.from(ctx.scheduledActions_(rec(r), now));

test('書類落選はすぐに通知（送信済みなら送らない）', () => {
  const r = { status: S.DOC_FAILED, statusChangedAt: '2026/10/05 15:00:00' };
  assert.deepStrictEqual(actions(r, at(2026, 10, 5, 15, 0)), ['docReject']);
  assert.deepStrictEqual(actions(Object.assign({ rejectNotifiedAt: '2026/10/05 15:00:01' }, r), at(2026, 10, 5, 15, 1)), []);
});

test('面接後の不採用は、変更した時刻にかかわらず翌日10時に通知（文面は丁寧なもの）', () => {
  const morning = { status: S.REJECTED, statusChangedAt: '2026/10/05 08:00:00' };
  assert.deepStrictEqual(actions(morning, at(2026, 10, 5, 10, 0)), []);
  assert.deepStrictEqual(actions(morning, at(2026, 10, 6, 9, 59)), []);
  assert.deepStrictEqual(actions(morning, at(2026, 10, 6, 10, 0)), ['interviewReject']);
  const evening = { status: S.REJECTED, statusChangedAt: '2026/10/05 18:00:00' };
  assert.deepStrictEqual(actions(evening, at(2026, 10, 6, 10, 0)), ['interviewReject']);
  assert.match(ctx.interviewRejectText_(rec({})), /慎重に選考を重ねました結果/);
  const doc = ctx.docRejectText_(rec({}));
  assert.match(doc, /書類選考の結果、誠に残念ながら、今回は不採用となりました/);
  assert.ok(doc.length < 200);
});

test('面接確定：当日9時にリマインド、時刻になったら通話ボタン', () => {
  const r = { status: S.INTERVIEW_FIXED, interviewAt: '2026/10/12(月) 14:00' };
  assert.deepStrictEqual(actions(r, at(2026, 10, 11, 20, 0)), []);
  assert.deepStrictEqual(actions(r, at(2026, 10, 12, 8, 59)), []);
  assert.deepStrictEqual(actions(r, at(2026, 10, 12, 9, 0)), ['reminder']);
  assert.deepStrictEqual(actions(Object.assign({ reminderSentAt: 'x' }, r), at(2026, 10, 12, 13, 59)), []);
  assert.deepStrictEqual(actions(Object.assign({ reminderSentAt: 'x' }, r), at(2026, 10, 12, 14, 0)), ['call']);
  assert.deepStrictEqual(actions(Object.assign({ reminderSentAt: 'x', callSentAt: 'x' }, r), at(2026, 10, 12, 14, 1)), []);
  // 1時間以上過ぎたら送らない（トリガー停止後の再開などで古い案内を送らないため）
  assert.deepStrictEqual(actions(Object.assign({ reminderSentAt: 'x' }, r), at(2026, 10, 12, 15, 1)), []);
});

test('管理者が手入力した面接日時（年なし・秒なし）も読める', () => {
  const r = { status: S.INTERVIEW_FIXED, interviewAt: '2026/10/12 14:00', reminderSentAt: 'x' };
  assert.deepStrictEqual(actions(r, at(2026, 10, 12, 14, 0)), ['call']);
});

test('ほかのステータスでは何も送らない', () => {
  for (const status of [S.PRE, S.DOC_PASSED, S.INTERVIEW_OFFERED, S.RESCHEDULE, S.HIRED]) {
    assert.deepStrictEqual(actions({ status, interviewAt: '2026/10/12(月) 14:00', statusChangedAt: '2026/10/01 08:00:00' }, at(2026, 10, 12, 14, 0)), [], status);
  }
});

test('面接候補：チェックがなければ未来の希望すべて、あればチェックした希望だけ', () => {
  const base = {
    interview1: '2026/10/04(日) 10:00', // 過去
    interview2: '2026/10/12(月) 14:00',
    interview3: '2026/10/13(火) 10:00',
    interview4: ''
  };
  const now = at(2026, 10, 5, 12, 0);
  assert.deepStrictEqual(Array.from(ctx.offerSlots_(rec(base), now)), ['2026/10/12(月) 14:00', '2026/10/13(火) 10:00']);
  assert.deepStrictEqual(Array.from(ctx.offerSlots_(rec(Object.assign({ offer3: true }, base)), now)), ['2026/10/13(火) 10:00']);
  assert.deepStrictEqual(Array.from(ctx.offerSlots_(rec(Object.assign({ offer2: 'TRUE', offer3: 'FALSE' }, base)), now)), ['2026/10/12(月) 14:00']);
});

test('面接候補のメッセージ：日時ボタン＋「どれも都合が合わない」', () => {
  const m = ctx.offerMessage_(rec({}), ['2026/10/12(月) 14:00', '2026/10/13(火) 10:00']);
  assert.strictEqual(m.type, 'flex');
  const buttons = m.contents.footer.contents;
  assert.strictEqual(buttons.length, 3);
  assert.strictEqual(buttons[0].action.label, '10/12(月) 14:00');
  assert.strictEqual(decodeURIComponent(buttons[0].action.data.split('t=')[1]), '2026/10/12(月) 14:00');
  assert.strictEqual(buttons[2].action.data, 'iv=none');
  buttons.forEach((b) => {
    assert.ok(b.action.label.length <= 40);
    assert.ok(b.action.data.length <= 300);
  });
});

test('通話の案内：URLがあればボタン、なければトーク画面の通話ボタンを案内', () => {
  const withUrl = ctx.callMessages_(rec({}), 'https://line.me/R/call/xxx');
  assert.strictEqual(withUrl[0].template.actions[0].uri, 'https://line.me/R/call/xxx');
  assert.ok(withUrl[0].template.text.length <= 160);
  const without = ctx.callMessages_(rec({}), '');
  assert.match(without[0].text, /通話）ボタン/);
});

test('通しの流れ：書類通過→候補送信→応募者が選択→面接確定', () => {
  const db = {};
  const sent = [];
  vm.runInContext(`
    readRecord_ = function (sheet, id) { return __db[id] ? Object.assign({}, __db[id]) : null; };
    writeRecord_ = function (sheet, id, f) { __db[id] = Object.assign(__db[id] || {}, f); };
    pushMessage_ = function (id, m) { __sent.push(['push', m]); return {}; };
    replyMessage_ = function (t, m) { __sent.push(['reply', m]); return {}; };
    notifyAdmin_ = function () {};
    interviewMethod_ = function () { return 'line'; };
    now_ = function () { return '2026/10/05 12:00:00'; };
    Utilities = { formatDate: function () { return '10/5 12:00'; } };
  `, Object.assign(ctx, { __db: db, __sent: sent }));

  db.U1 = rec({ status: S.DOC_PASSED, interview1: '2099/01/10(土) 14:00', interview2: '2099/01/11(日) 10:00' });
  ctx.sendInterviewOffer_(db.U1);
  assert.strictEqual(db.U1.status, S.INTERVIEW_OFFERED);
  assert.strictEqual(sent[0][1][0].type, 'flex');

  ctx.onInterviewPostback_({ replyToken: 'r' }, 'U1', { iv: 'pick', t: '2099/01/11(日) 10:00' });
  assert.strictEqual(db.U1.status, S.INTERVIEW_FIXED);
  assert.strictEqual(db.U1.interviewAt, '2099/01/11(日) 10:00');
  const reply = sent[1];
  assert.strictEqual(reply[0], 'reply');
  assert.match(reply[1][0].text, /面接の日時が決まりました/);
  assert.match(reply[1][1].text, /LINEのビデオ通話で行います/);

  // 確定後にもう一度押しても変わらない
  ctx.onInterviewPostback_({ replyToken: 'r' }, 'U1', { iv: 'pick', t: '2099/01/10(土) 14:00' });
  assert.strictEqual(db.U1.interviewAt, '2099/01/11(日) 10:00');

  // 「どれも都合が合わない」
  db.U2 = rec({ userId: 'U2', status: S.INTERVIEW_OFFERED, interview1: '2099/01/10(土) 14:00' });
  ctx.onInterviewPostback_({ replyToken: 'r' }, 'U2', { iv: 'none' });
  assert.strictEqual(db.U2.status, S.RESCHEDULE);

  // 希望日時がすべて過ぎていたら送らずに「日程再調整」＋管理メモ
  db.U3 = rec({ userId: 'U3', status: S.DOC_PASSED, interview1: '2020/01/10(金) 14:00' });
  const before = sent.length;
  ctx.sendInterviewOffer_(db.U3);
  assert.strictEqual(sent.length, before);
  assert.strictEqual(db.U3.status, S.RESCHEDULE);
  assert.match(db.U3.adminMemo, /送れる面接候補がありません/);
});

test('空の行に FALSE が残っていても、新しい登録はデータのすぐ下に追加される', () => {
  // 「スタッフ登録」シートを模擬：見出し＋1人分＋空の行（候補チェック欄に FALSE）が 1000 行目まで
  const header = ctx.COLUMNS[ctx.REG_SHEET].map((c) => c[1]);
  const offerCol = header.indexOf('候補に送る（第1希望）');
  const rows = [header, header.map((h, i) => (i === 0 ? 'U_existing' : ''))];
  while (rows.length < 1000) rows.push(header.map((h, i) => (i === offerCol ? false : '')));
  const sheet = {
    getLastRow: () => rows.length,
    getLastColumn: () => header.length,
    getRange: (r, c, nr, nc) => ({
      getValues: () => rows.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)),
      setValues: (vals) => vals.forEach((v, k) => { rows[r - 1 + k] = v.slice(); }),
      clearContent: () => { for (let k = 0; k < nr; k++) rows[r - 1 + k] = rows[r - 1 + k].map(() => ''); }
    })
  };
  // 前のテストで差し替えた書き込み処理を、本物（Sheet.gs）に戻してから試す
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', 'Sheet.gs'), 'utf8'), ctx);
  vm.runInContext('sheet_ = function () { return __sheet; }; LockService = { getScriptLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; } };',
    Object.assign(ctx, { __sheet: sheet }));
  ctx.writeRecord_(ctx.REG_SHEET, 'U_new', { lastName: '新規' });
  assert.strictEqual(rows[2][0], 'U_new');
  assert.strictEqual(rows[2][header.indexOf('姓')], '新規');

  ctx.clearEmptyRows_(sheet);
  assert.ok(rows.slice(3).every((row) => row.every((v) => v === '')));
});

test('ステータス変更日時がセルで日付形式になっていても通知を送る', () => {
  const r = { status: S.REJECTED, statusChangedAt: new Date(2026, 9, 5, 15, 0) };
  assert.deepStrictEqual(actions(r, at(2026, 10, 6, 10, 0)), ['interviewReject']);
  const f = { status: S.INTERVIEW_FIXED, interviewAt: new Date(2026, 9, 12, 14, 0), reminderSentAt: 'x' };
  assert.deepStrictEqual(actions(f, at(2026, 10, 12, 14, 0)), ['call']);
});

// ---- Google カレンダー ----

test('カレンダーの予定をどうするか', () => {
  const now = at(2026, 10, 7, 12, 0);
  const cal = (r) => ctx.calendarAction_(rec(r), now);
  const fixed = { status: S.INTERVIEW_FIXED, interviewAt: '2026/10/12(月) 14:00' };
  assert.strictEqual(cal(fixed), 'create');
  assert.strictEqual(cal(Object.assign({ calendarEventId: 'E1', calendarAt: '2026/10/12(月) 14:00' }, fixed)), '');
  // シートで日時を直した（書き方が違っても同じ日時なら何もしない）
  assert.strictEqual(cal(Object.assign({ calendarEventId: 'E1', calendarAt: '2026/10/12(月) 14:00' }, fixed, { interviewAt: '2026/10/12 14:00' })), '');
  assert.strictEqual(cal(Object.assign({ calendarEventId: 'E1', calendarAt: '2026/10/12(月) 14:00' }, fixed, { interviewAt: '2026/10/13 15:30' })), 'update');
  assert.strictEqual(cal({ status: S.INTERVIEW_FIXED, interviewAt: '' }), '');
  assert.strictEqual(cal({ status: S.INTERVIEW_FIXED, interviewAt: '', calendarEventId: 'E1', calendarAt: '2026/10/12(月) 14:00' }), 'delete');
  // 日程再調整・面接前の不採用 → 消す
  assert.strictEqual(cal({ status: S.RESCHEDULE, interviewAt: '2026/10/12(月) 14:00', calendarEventId: 'E1', calendarAt: '2026/10/12(月) 14:00' }), 'delete');
  assert.strictEqual(cal({ status: S.REJECTED, calendarEventId: 'E1', calendarAt: '2026/10/12(月) 14:00' }), 'delete');
  // 面接が済んだあと（採用・不採用など）→ 記録として残す
  assert.strictEqual(cal({ status: S.HIRED, calendarEventId: 'E1', calendarAt: '2026/10/05(月) 14:00' }), '');
  assert.strictEqual(cal({ status: S.REJECTED, calendarEventId: 'E1', calendarAt: '2026/10/05(月) 14:00' }), '');
  assert.strictEqual(cal({ status: S.PRE }), '');
});

test('カレンダーの予定の中身', () => {
  const r = rec({ lastNameKana: 'ヤマダ', firstNameKana: 'ハナコ', age: 22, phone: '090-1234-5678', areas: '大阪、兵庫' });
  assert.strictEqual(ctx.calendarTitle_(r), '面接（LINEビデオ通話）山田 花子 さん');
  const d = ctx.calendarDescription_(r, 'https://docs.google.com/x');
  assert.match(d, /氏名：山田 花子（ヤマダ ハナコ）/);
  assert.match(d, /電話番号：090-1234-5678/);
  assert.match(d, /登録内容：https:\/\/docs\.google\.com\/x/);
});

test('1分ごとの自動処理で、カレンダーに登録・移動・削除する', () => {
  const c = vm.createContext({});
  for (const f of ['Options.gs', 'Validation.gs', 'Line.gs', 'Sheet.gs', 'Interview.gs', 'Code.gs', 'Shift.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), c, { filename: f });
  }
  const header = c.COLUMNS[c.REG_SHEET].map((x) => x[1]);
  const db = {};
  const events = {};
  let nextId = 1;
  const errors = [];
  const cacheStore = {};
  const makeEvent = (id) => ({
    getId: () => id,
    setTime: (s, e) => { events[id].start = s; events[id].end = e; },
    setTitle: (t) => { events[id].title = t; },
    setDescription: (t) => { events[id].description = t; },
    addPopupReminder: (m) => { events[id].reminder = m; },
    deleteEvent: () => { delete events[id]; }
  });
  const calendar = {
    createEvent: (title, start, end, opt) => { const id = 'E' + nextId++; events[id] = { title, start, end, description: opt.description }; return makeEvent(id); },
    getEventById: (id) => (events[id] ? makeEvent(id) : null)
  };
  let props = {};
  Object.assign(c, {
    __db: db, __header: header, __cal: calendar, __errors: errors,
    // この確認は LINEコール（Google Meet は下の別の確認）
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => Object.assign({ INTERVIEW_METHOD: 'line' }, props), getProperty: (k) => props[k] || null }) },
    CalendarApp: { getDefaultCalendar: () => calendar, getCalendarById: () => null },
    CacheService: { getScriptCache: () => ({ get: (k) => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; } }) }
  });
  vm.runInContext(`
    sheet_ = function () {
      var ids = Object.keys(__db);
      var rows = [__header].concat(ids.map(function (id) { return __header.map(function (h, i) {
        var key = COLUMNS[REG_SHEET][i][0]; return __db[id][key] === undefined ? '' : __db[id][key]; }); }));
      return { getLastRow: function () { return rows.length; }, getLastColumn: function () { return __header.length; },
        getRange: function (r, col, nr, nc) { return { getValues: function () {
          return rows.slice(r - 1, r - 1 + nr).map(function (row) { return row.slice(col - 1, col - 1 + nc); }); } }; } };
    };
    writeRecord_ = function (sheet, id, f) { __db[id] = Object.assign(__db[id] || {}, f); };
    spreadsheet_ = function () { return { getUrl: function () { return 'https://sheet'; } }; };
    pushMessage_ = function () { return {}; };
    logError_ = function (kind, id, err) { __errors.push(kind + ' ' + err.message); };
    runJobScheduler_ = function () {};
    sendChatReminders_ = function () { return 0; };
  `, c);

  db.U1 = rec({ status: S.INTERVIEW_FIXED, interviewAt: '2099/01/11(日) 10:00' });
  db.U2 = rec({ userId: 'U2', status: S.PRE });
  c.runScheduler();
  assert.deepStrictEqual(Object.keys(events), ['E1']);
  assert.strictEqual(events.E1.title, '面接（LINEビデオ通話）山田 花子 さん');
  assert.deepStrictEqual([events.E1.start.getHours(), events.E1.end.getHours(), events.E1.end.getMinutes()], [10, 10, 30]);
  assert.strictEqual(events.E1.reminder, 10);
  assert.strictEqual(db.U1.calendarEventId, 'E1');
  assert.strictEqual(db.U1.calendarAt, '2099/01/11(日) 10:00');

  // もう一度動いても増えない
  c.runScheduler();
  assert.deepStrictEqual(Object.keys(events), ['E1']);

  // 担当者がシートで日時を変えた → 予定を動かす（面接時間は INTERVIEW_MINUTES）
  props = { INTERVIEW_MINUTES: '45' };
  db.U1.interviewAt = '2099/01/12 15:00';
  c.runScheduler();
  assert.deepStrictEqual(Object.keys(events), ['E1']);
  assert.deepStrictEqual([events.E1.start.getDate(), events.E1.start.getHours(), events.E1.end.getMinutes()], [12, 15, 45]);
  assert.strictEqual(db.U1.calendarAt, '2099/01/12(月) 15:00');

  // カレンダーで予定を手で消していた → 作り直す
  delete events.E1;
  db.U1.interviewAt = '2099/01/13 15:00';
  c.runScheduler();
  assert.deepStrictEqual(Object.keys(events), ['E2']);
  assert.strictEqual(db.U1.calendarEventId, 'E2');

  // 日程再調整 → 予定を消す
  db.U1.status = S.RESCHEDULE;
  c.runScheduler();
  assert.deepStrictEqual(Object.keys(events), []);
  assert.strictEqual(db.U1.calendarEventId, '');

  // CALENDAR_ID が off なら登録しない／見つからないカレンダーならエラーを1回だけ記録して1時間止める
  db.U1.status = S.INTERVIEW_FIXED;
  props = { CALENDAR_ID: 'off' };
  c.runScheduler();
  assert.deepStrictEqual(Object.keys(events), []);
  props = { CALENDAR_ID: 'nothing@group.calendar.google.com' };
  c.runScheduler();
  c.runScheduler();
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /カレンダー「nothing@group\.calendar\.google\.com」が見つからない/);
  assert.deepStrictEqual(errors.filter((e) => !/カレンダー/.test(e)), []);
});

test('面接の案内：ビデオ通話・20〜30分程度（ボタンの本文は LINE の上限160文字以内）', () => {
  const r = rec({ interviewAt: '2026/10/12(月) 14:00' });
  const texts = [ctx.callGuideText_(), ctx.fixedText_(r, '2026/10/12(月) 14:00'), ctx.reminderText_(r),
    JSON.stringify(ctx.offerMessage_(r, ['2026/10/12(月) 14:00'])), ctx.calendarDescription_(r, '')];
  texts.forEach((t) => {
    assert.match(t, /ビデオ通話/);
    assert.match(t, /20〜30分程度/);
    assert.doesNotMatch(t, /10〜15分|音声通話・|LINEコール/);
  });
  const withUrl = ctx.callMessages_(r, 'https://line.me/R/call/x');
  assert.strictEqual(withUrl[0].template.actions[0].label, '📹 ビデオ通話する');
  assert.match(withUrl[0].template.text, /「ビデオ通話」で発信/);
  assert.ok(withUrl[0].template.text.length <= 160);
  assert.match(ctx.callMessages_(r, '')[0].text, /「ビデオ通話」で発信/);
});

test('Google Meet の文面：参加用ボタン（URLがなければ担当者から送ると伝える）', () => {
  const r = rec({ interviewAt: '2026/10/12(月) 14:00', meetUrl: 'https://meet.google.com/abc-defg-hij' });
  const texts = [ctx.callGuideText_('meet'), ctx.fixedText_(r, '2026/10/12(月) 14:00', 'meet'), ctx.reminderText_(r, 'meet'),
    JSON.stringify(ctx.offerMessage_(r, ['2026/10/12(月) 14:00'], 'meet')), ctx.calendarDescription_(r, '', 'meet')];
  texts.forEach((t) => {
    assert.match(t, /Google Meet/);
    assert.match(t, /20〜30分程度/);
    assert.doesNotMatch(t, /LINEコール|発信/);
  });
  assert.match(ctx.callGuideText_('meet'), /Googleアカウントがなくても参加できます/);
  assert.match(ctx.callGuideText_('meet'), /参加をリクエスト/);
  assert.strictEqual(ctx.calendarTitle_(r, 'meet'), '面接（Google Meet）山田 花子 さん');
  assert.match(ctx.calendarDescription_(r, '', 'meet'), /「承認」してください/);

  const call = ctx.callMessages_(r, 'https://line.me/R/call/x', 'meet');
  assert.strictEqual(call[0].template.actions[0].uri, 'https://meet.google.com/abc-defg-hij');
  assert.strictEqual(call[0].template.actions[0].label, 'Google Meet に参加する');
  assert.ok(call[0].template.text.length <= 160, call[0].template.text.length);
  const noUrl = ctx.callMessages_(rec({}), '', 'meet');
  assert.strictEqual(noUrl[0].type, 'text');
  assert.match(noUrl[0].text, /参加用のURLを担当者から/);

  const reminder = ctx.reminderMessages_(r, 'meet');
  assert.strictEqual(reminder.length, 2);
  assert.strictEqual(reminder[1].template.actions[0].uri, 'https://meet.google.com/abc-defg-hij');
  assert.strictEqual(ctx.reminderMessages_(r, 'line').length, 1); // LINEコールではボタンなし
});

test('Google Meet：当日のリマインドはURLができてから、面接の時刻の案内はURLがなくても送る', () => {
  const r = { status: S.INTERVIEW_FIXED, interviewAt: '2026/10/12(月) 14:00' };
  assert.deepStrictEqual(actions(r, at(2026, 10, 12, 9, 0)), ['reminder']); // LINEコール（method なし）
  assert.deepStrictEqual(Array.from(ctx.scheduledActions_(rec(r), at(2026, 10, 12, 9, 0), 'meet')), []);
  const withUrl = Object.assign({ meetUrl: 'https://meet.google.com/x' }, r);
  assert.deepStrictEqual(Array.from(ctx.scheduledActions_(rec(withUrl), at(2026, 10, 12, 9, 0), 'meet')), ['reminder']);
  assert.deepStrictEqual(Array.from(ctx.scheduledActions_(rec(Object.assign({ reminderSentAt: 'x' }, r)), at(2026, 10, 12, 14, 0), 'meet')), ['call']);
});

test('1分ごとの自動処理で、カレンダーの予定に Google Meet を付ける', () => {
  const c = vm.createContext({});
  for (const f of ['Options.gs', 'Validation.gs', 'Line.gs', 'Sheet.gs', 'Interview.gs', 'Code.gs', 'Shift.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), c, { filename: f });
  }
  const header = c.COLUMNS[c.REG_SHEET].map((x) => x[1]);
  const db = {};
  const events = {};
  let nextId = 1;
  const errors = [];
  const pushed = [];
  const admin = [];
  const cacheStore = {};
  const makeEvent = (id) => ({
    getId: () => id + '@google.com',
    setTime: (s, e) => { events[id].start = s; events[id].end = e; },
    setTitle: (t) => { events[id].title = t; },
    setDescription: (t) => { events[id].description = t; },
    addPopupReminder: () => {},
    deleteEvent: () => { delete events[id]; }
  });
  const calendar = {
    getId: () => 'me@example.com',
    createEvent: (title) => { const id = 'E' + nextId++; events[id] = { title }; return makeEvent(id); },
    getEventById: (id) => (events[id.split('@')[0]] ? makeEvent(id.split('@')[0]) : null)
  };
  // Calendar API（高度なサービス）：会議の作成を頼むと最初は pending、次に読むと URL ができている
  const AdvancedCalendar = {
    Events: {
      get: (calId, id) => {
        assert.strictEqual(calId, 'me@example.com');
        const e = events[id];
        if (e.conf === 'pending') { e.conf = 'ready'; return { conferenceData: { createRequest: { status: { statusCode: 'pending' } } } }; }
        return e.conf === 'ready' ? { hangoutLink: 'https://meet.google.com/' + id } : {};
      },
      patch: (body, calId, id, opt) => {
        assert.strictEqual(opt.conferenceDataVersion, 1);
        assert.strictEqual(body.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
        events[id].conf = 'pending';
        events[id].patches = (events[id].patches || 0) + 1;
        return {};
      }
    }
  };
  Object.assign(c, {
    __db: db, __header: header, __errors: errors, __pushed: pushed, __admin: admin,
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({}), getProperty: () => null }) },
    CalendarApp: { getDefaultCalendar: () => calendar },
    CacheService: { getScriptCache: () => ({ get: (k) => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; } }) },
    Utilities: { getUuid: () => 'uuid', formatDate: () => '' }
  });
  vm.runInContext(`
    sheet_ = function () {
      var ids = Object.keys(__db);
      var rows = [__header].concat(ids.map(function (id) { return __header.map(function (h, i) {
        var key = COLUMNS[REG_SHEET][i][0]; return __db[id][key] === undefined ? '' : __db[id][key]; }); }));
      return { getLastRow: function () { return rows.length; }, getLastColumn: function () { return __header.length; },
        getRange: function (r, col, nr, nc) { return { getValues: function () {
          return rows.slice(r - 1, r - 1 + nr).map(function (row) { return row.slice(col - 1, col - 1 + nc); }); } }; } };
    };
    writeRecord_ = function (sheet, id, f) { __db[id] = Object.assign(__db[id] || {}, f); };
    spreadsheet_ = function () { return { getUrl: function () { return 'https://sheet'; } }; };
    pushMessage_ = function (id, m) { __pushed.push(m); return {}; };
    notifyAdmin_ = function (s) { __admin.push(s); };
    now_ = function () { return 'now'; };
    logError_ = function (kind, id, err) { __errors.push(kind + ' ' + err.message); };
    runJobScheduler_ = function () {};
    sendChatReminders_ = function () { return 0; };
  `, c);

  // Calendar API が追加されていない → エラーを記録し、10分は同じエラーを出さない
  db.U1 = rec({ status: S.INTERVIEW_FIXED, interviewAt: '2099/01/11(日) 10:00' });
  c.runScheduler();
  c.runScheduler();
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /Google Calendar API（高度なサービス）が追加されていません/);
  assert.strictEqual(db.U1.calendarEventId, 'E1@google.com');
  assert.strictEqual(events.E1.title, '面接（Google Meet）山田 花子 さん');

  // 追加したら：会議を頼む（pending）→ 次の回に URL を書く。頼むのは1回だけ
  c.Calendar = AdvancedCalendar;
  delete cacheStore['meet:U1'];
  c.runScheduler(); // 会議を頼む
  assert.strictEqual(db.U1.meetUrl || '', '');
  c.runScheduler(); // まだ作成中（頼み直さない）
  assert.strictEqual(db.U1.meetUrl || '', '');
  assert.strictEqual(events.E1.patches, 1);
  c.runScheduler(); // できた
  assert.strictEqual(db.U1.meetUrl, 'https://meet.google.com/E1');
  c.runScheduler();
  assert.strictEqual(events.E1.patches, 1);

  // 日程再調整で予定を消したら URL も消す
  db.U1.status = S.RESCHEDULE;
  c.runScheduler();
  assert.strictEqual(db.U1.meetUrl, '');
  assert.deepStrictEqual(Object.keys(events), []);

  // 面接の時刻：URLがあれば参加ボタン。URLがなければ待ってもらう連絡＋担当者にメール
  db.U2 = rec({ userId: 'U2', status: S.INTERVIEW_FIXED, interviewAt: '2000/01/01 10:00', reminderSentAt: 'x',
    calendarEventId: 'gone', calendarAt: '2000/01/01(土) 10:00', meetUrl: 'https://meet.google.com/u2' });
  const realNow = Date;
  c.Date = class extends realNow { constructor(...a) { super(...(a.length ? a : [2000, 0, 1, 10, 5])); } };
  delete db.U1;
  c.runScheduler();
  assert.strictEqual(pushed.length, 1);
  assert.strictEqual(pushed[0][0].template.actions[0].uri, 'https://meet.google.com/u2');
  db.U2.callSentAt = '';
  db.U2.meetUrl = '';
  cacheStore['meet:U2'] = '1';
  c.runScheduler();
  assert.match(pushed[1][0].text, /参加用のURLを担当者から/);
  assert.strictEqual(admin.length, 1);
});

test('Google Meet の案内：iPhone はアプリなしで参加でき、Android はアプリを入れてもらう', () => {
  const r = rec({ interviewAt: '2026/10/12(月) 14:00', meetUrl: 'https://meet.google.com/abc-defg-hij' });
  const guide = ctx.callGuideText_('meet');
  assert.match(guide, /iPhone の方：準備は不要です。ボタンを押すと、アプリがなくてもそのまま参加できます/);
  assert.match(guide, /Android の方：「Google Meet」アプリ（無料）を、前日までに入れておいてください/);
  assert.match(guide, /Googleアカウントがなくても参加できます/);
  assert.match(ctx.reminderText_(r, 'meet'), /Android の方で「Google Meet」アプリをまだ入れていない方は/);
  const btn = ctx.reminderMessages_(r, 'meet')[1];
  assert.match(btn.template.text, /Android の方は「Google Meet」アプリが必要です/);
  assert.ok(btn.template.text.length <= 160);
  assert.doesNotMatch(guide, /スマホに「Google Meet」アプリを入れておいてください/);
});

test('スタッフ登録：書類落選・不採用・退会の行をグレーにする（setup を何度実行しても1つだけ）', () => {
  assert.strictEqual(ctx.inactiveRowFormula_('K'), '=OR($K2="書類落選",$K2="不採用",$K2="選考辞退",$K2="退会")');
  const other = { getBooleanCondition: () => ({ getCriteriaValues: () => ['=$A2=""'] }) };
  const old = { getBooleanCondition: () => ({ getCriteriaValues: () => ['=OR($J2="不採用",$J2="退会")'] }) };
  let saved = null;
  const built = {};
  const builder = {
    whenFormulaSatisfied: (f) => { built.formula = f; return builder; },
    setBackground: (c) => { built.bg = c; return builder; },
    setFontColor: () => builder,
    setRanges: (r) => { built.ranges = r; return builder; },
    build: () => ({ built: true })
  };
  vm.runInContext('SpreadsheetApp = __sa;', Object.assign(ctx, { __sa: { newConditionalFormatRule: () => builder } }));
  const sheet = {
    getRange: (r, c, nr, nc) => ({ getA1Notation: () => 'K1', r, c, nr, nc }),
    getConditionalFormatRules: () => [other, old],
    setConditionalFormatRules: (rules) => { saved = rules; },
    getMaxRows: () => 1000,
    getMaxColumns: () => 30
  };
  ctx.grayOutInactiveRows_(sheet, 11);
  assert.strictEqual(saved.length, 2);
  assert.strictEqual(saved[0], other);
  assert.strictEqual(built.formula, '=OR($K2="書類落選",$K2="不採用",$K2="選考辞退",$K2="退会")');
  assert.strictEqual(built.bg, '#e0e0e0');
  assert.deepStrictEqual([built.ranges[0].r, built.ranges[0].c, built.ranges[0].nr, built.ranges[0].nc], [2, 1, 999, 30]);
});

test('書類未提出の人へのリマインド：案内から1日後・3日後、その1日後に担当者へ', () => {
  const c = vm.createContext({ PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ LIFF_ID: 'L' }), getProperty: () => '' }) } });
  for (const f of ['Options.gs', 'Validation.gs', 'Line.gs', 'Sheet.gs', 'Chat.gs', 'Interview.gs', 'Code.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), c, { filename: f });
  }
  const rec = (o) => Object.assign({ userId: 'U1', status: '書類依頼済', statusChangedAt: '2026/10/20 15:00:00', docRemindCount: '' }, o);
  const at = (d, h, m) => new Date(2026, 9, d, h, m || 0);
  const act = (o, now) => c.docReminderAction_(rec(o), now);
  assert.strictEqual(act({}, at(21, 14, 59)), '');
  assert.strictEqual(act({}, at(21, 15)), 'remind');           // 1日後
  assert.strictEqual(act({}, at(21, 20)), '');                 // 20時以降は送らない
  assert.strictEqual(act({ docRemindCount: 1 }, at(22, 15)), '');
  assert.strictEqual(act({ docRemindCount: 1 }, at(23, 15)), 'remind'); // 3日後
  assert.strictEqual(act({ docRemindCount: 2 }, at(23, 16)), '');
  assert.strictEqual(act({ docRemindCount: 2 }, at(24, 15)), 'alert');  // 4日後に担当者へ
  assert.strictEqual(act({ docRemindCount: 3 }, at(30, 15)), '');
  // 夜に採用した人は、翌々日ではなく翌日の朝10時から送る
  assert.strictEqual(act({ statusChangedAt: '2026/10/20 22:00:00' }, at(21, 21)), '');
  assert.strictEqual(act({ statusChangedAt: '2026/10/20 22:00:00' }, at(22, 10)), 'remind');
  // ずっと前から書類依頼済の人：続けては送らず、1日ずつあける
  const old = { statusChangedAt: '2026/09/01 12:00:00' };
  assert.strictEqual(act(old, at(21, 12)), 'remind');
  assert.strictEqual(act(Object.assign({}, old, { docRemindCount: 1, docRemindedAt: '2026/10/21 12:00:00' }), at(21, 12, 1)), '');
  assert.strictEqual(act(Object.assign({}, old, { docRemindCount: 1, docRemindedAt: '2026/10/21 12:00:00' }), at(22, 12)), 'remind');
  assert.strictEqual(act(Object.assign({}, old, { docRemindCount: 2, docRemindedAt: '2026/10/22 12:00:00' }), at(23, 12)), 'alert');
  assert.strictEqual(act({ status: '書類提出済' }, at(25, 12)), '');
  assert.strictEqual(act({ blocked: 'ブロック中' }, at(25, 12)), '');
  const msgs = c.docReminderMessages_({ lastName: '山田', firstName: '花子' });
  assert.match(msgs[0].text, /^山田 花子 さん\n\n書類のご提出がまだのようです/);
  assert.strictEqual(msgs[1].type, 'template');
});

test('稼働可にしたら案内を1回だけ送る', () => {
  const c = vm.createContext({});
  for (const f of ['Options.gs', 'Validation.gs', 'Line.gs', 'Sheet.gs', 'Interview.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), c, { filename: f });
  }
  const pushes = [], writes = [];
  c.pushMessage_ = (to, msgs) => { pushes.push([to, msgs]); return true; };
  c.writeRecord_ = (sheet, id, f) => writes.push([id, f]);
  c.now_ = () => '2026/10/20 12:00:00';
  const header = { '稼働可の案内の送信日時': 50 };
  c.sendActiveNotice_({ userId: 'U1' }, header);
  assert.strictEqual(pushes.length, 1);
  assert.strictEqual(pushes[0][1][0].text, '提出書類の確認が終わりました。\n\n今後はこちらのLINEにてお仕事を配信いたします。\n\nご希望の案件があれば日程をクリックの上、ご応募お願いします。');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(writes[0])), ['U1', { activeNotifiedAt: '2026/10/20 12:00:00' }]);
  c.sendActiveNotice_({ userId: 'U1', activeNotifiedAt: '2026/10/20 12:00:00' }, header); // 送信済み
  c.sendActiveNotice_({ userId: 'U2', blocked: 'ブロック中' }, header);
  c.sendActiveNotice_({ userId: 'U3' }, {}); // setup 前（列がない）
  assert.strictEqual(pushes.length, 1);
});

test('選考辞退：面接の予定はカレンダーから消し、通知は送らない', () => {
  const now = new Date(2026, 9, 23, 12, 0);
  const rec = { userId: 'U1', status: '選考辞退', calendarEventId: 'ev1', calendarAt: '2026/10/25 14:00', interviewAt: '2026/10/25 14:00', statusChangedAt: '2026/10/23 11:00:00' };
  assert.strictEqual(ctx.calendarAction_(rec, now), 'delete');
  assert.deepStrictEqual(Array.from(ctx.scheduledActions_(rec, new Date(2026, 9, 25, 14, 0), 'meet')), []);
  assert.ok(Object.values(ctx.STATUS).includes('選考辞退'));
});
