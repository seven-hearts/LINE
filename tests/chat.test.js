// 友だち追加後のトークでのやりとり（gas/Chat.gs）を Node で検証する: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
for (const f of ['Options.gs', 'Validation.gs', 'Line.gs', 'Chat.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
}
vm.runInContext("getConfig_ = function () { return { liffId: '2011864173-MxilvLoL' }; };", ctx);

const answer = (state, text) => ctx.chatAnswer_(state, { text });

function run(texts) {
  let state = ctx.chatNewState_();
  let res;
  for (const t of texts) {
    res = answer(state, t);
    if (res.cancelled) break;
    state = res.state;
  }
  return { res, state };
}

test('最初の質問は姓', () => {
  const m = ctx.chatPrompt_(ctx.chatNewState_());
  assert.match(m[0].text, /「姓」/);
});

test('姓→名の順に聞き、答えるとフォームのボタンが届く', () => {
  let { res, state } = run(['山田']);
  assert.strictEqual(state.step, 'firstName');
  assert.match(res.messages[0].text, /「名」/);

  ({ res, state } = run(['山田', '花子']));
  assert.strictEqual(state.step, 'form');
  assert.strictEqual(state.data.lastName, '山田');
  assert.strictEqual(state.data.firstName, '花子');
  const m = res.messages[0];
  assert.strictEqual(m.type, 'template');
  assert.match(m.template.text, /山田 花子 さん/);
  assert.ok(m.template.text.length <= 160);
  assert.strictEqual(m.template.actions[0].uri, 'https://liff.line.me/2011864173-MxilvLoL');
  assert.ok(m.template.actions[0].label.length <= 20);
});

test('姓の質問にフルネームが送られたら姓と名に分ける', () => {
  const { state } = run(['山田　花子']);
  assert.strictEqual(state.step, 'form');
  assert.strictEqual(state.data.lastName, '山田');
  assert.strictEqual(state.data.firstName, '花子');
});

test('空・長すぎる回答は聞き直す', () => {
  let { res, state } = run(['山田', ' ']);
  assert.strictEqual(state.step, 'firstName');
  assert.match(res.messages[0].text, /名を入力してください/);
  ({ res, state } = run(['あ'.repeat(21)]));
  assert.strictEqual(state.step, 'lastName');
  assert.match(res.messages[0].text, /姓を20文字以内/);
});

test('フォーム入力待ちのときはボタンを送り直す', () => {
  const { res, state } = run(['山田', '花子', '登録']);
  assert.strictEqual(state.step, 'form');
  assert.strictEqual(res.messages[0].type, 'template');
});

test('「やめる」で中断できる', () => {
  assert.ok(run(['やめる']).res.cancelled);
  assert.ok(run(['山田', 'やめる']).res.cancelled);
});

// ---- 登録途中の人へのリマインド ----

test('リマインド：最後のやりとりから1日後と3日後、10〜20時のあいだに送る（2回まで）', () => {
  const t = (d, h, m) => new Date(2026, 9, d, h, m || 0);
  const rec = (o) => Object.assign({ userId: 'U1', state: '{"step":"form"}', updatedAt: '2026/10/13 15:00:00', remindCount: '' }, o);
  const due = (o, now) => ctx.chatReminderDue_(rec(o), now);
  assert.strictEqual(due({}, t(14, 14, 59)), false);
  assert.strictEqual(due({}, t(14, 15, 0)), true);
  assert.strictEqual(due({ remindCount: 1 }, t(14, 15, 0)), false);
  assert.strictEqual(due({ remindCount: 1 }, t(16, 15, 0)), true);
  assert.strictEqual(due({ remindCount: 2 }, t(20, 15, 0)), false);
  // 夜（20時以降）と朝（10時前）は送らない → 次の日の10時
  const late = { updatedAt: '2026/10/13 22:30:00' };
  assert.strictEqual(due(late, t(14, 22, 30)), false);
  assert.strictEqual(due(late, t(15, 9, 59)), false);
  assert.strictEqual(due(late, t(15, 10, 0)), true);
  assert.strictEqual(due({ state: '' }, t(20, 12)), false);
});

test('リマインドの文面：フォーム入力待ちはボタン、お名前の途中は続きの質問', () => {
  const form = ctx.chatReminderMessages_({ step: 'form', data: { lastName: '山田', firstName: '花子' } });
  assert.strictEqual(form.length, 1);
  assert.strictEqual(form[0].type, 'template');
  assert.match(form[0].template.text, /^山田 花子 さん\nスタッフ登録の途中です。あと少しで完了します（約2分）。/);
  assert.ok(form[0].template.text.length <= 160);
  assert.strictEqual(form[0].template.actions[0].label, '続きを入力する');
  assert.match(form[0].template.actions[0].uri, /^https:\/\/liff\.line\.me\//);
  const asking = ctx.chatReminderMessages_({ step: 'firstName', data: { lastName: '山田' } });
  assert.match(asking[0].text, /登録をやめる場合は「やめる」/);
  assert.match(asking[1].text, /「名」/);
});

test('リマインドを送る：送った回数を記録し、返事があったら数え直す', () => {
  const c = vm.createContext({});
  for (const f of ['Options.gs', 'Validation.gs', 'Line.gs', 'Sheet.gs', 'Chat.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), c, { filename: f });
  }
  const header = c.COLUMNS[c.CHAT_SHEET].map((x) => x[1]);
  const db = {
    U1: { userId: 'U1', question: 'フォーム入力待ち', state: '{"step":"form","data":{"lastName":"山田","firstName":"花子"}}', updatedAt: '2026/10/13 15:00:00', remindCount: '' },
    U2: { userId: 'U2', question: '名', state: '{"step":"firstName","data":{"lastName":"佐藤"}}', updatedAt: '2026/10/14 14:00:00', remindCount: '' }
  };
  const pushes = [];
  Object.assign(c, { __db: db, __header: header, __pushes: pushes, __now: '2026/10/14 15:00:00' });
  vm.runInContext(`
    getConfig_ = function () { return { liffId: '2011864173-MxilvLoL' }; };
    spreadsheet_ = function () { return { getSheetByName: function () {
      var ids = Object.keys(__db);
      var rows = [__header].concat(ids.map(function (id) { return COLUMNS[CHAT_SHEET].map(function (x) { var v = __db[id][x[0]]; return v === undefined ? '' : v; }); }));
      return { getLastRow: function () { return rows.length; }, getLastColumn: function () { return __header.length; },
        getRange: function (r, col, nr, nc) { return { getValues: function () { return rows.slice(r - 1, r - 1 + nr).map(function (row) { return row.slice(col - 1, col - 1 + nc); }); } }; } };
    } }; };
    headerMap_ = function () { var m = {}; __header.forEach(function (h, i) { m[h] = i; }); return m; };
    sheet_ = function () { return {}; };
    writeRecord_ = function (sheet, id, f) { Object.assign(__db[id], f); };
    pushMessage_ = function (id, m) { __pushes.push([id, m]); return {}; };
    logError_ = function () {};
    now_ = function () { return __now; };
    Utilities = { formatDate: function () { return '2026/10/13 10:00:00'; } };
  `, c);

  assert.strictEqual(c.sendChatReminders_(new Date(2026, 9, 14, 15, 0), false), 1);
  assert.deepStrictEqual(pushes.map((p) => p[0]), ['U1']);
  assert.strictEqual(db.U1.remindCount, 1);
  assert.strictEqual(db.U1.remindedAt, '2026/10/14 15:00:00');
  assert.strictEqual(c.sendChatReminders_(new Date(2026, 9, 14, 15, 1), false), 0); // 2回は送らない

  // メニューから今すぐ：全員に（1時間以内に送った人は除く）
  assert.strictEqual(c.sendChatReminders_(new Date(2026, 9, 14, 15, 30), true), 1);
  assert.deepStrictEqual(pushes.map((p) => p[0]), ['U1', 'U2']);

  // 返事があった（お名前を答えた）→ 回数が0に戻る
  c.__now = '2026/10/14 16:00:00';
  c.saveChat_('U2', { step: 'form', data: { lastName: '佐藤', firstName: '太郎' }, startedAt: Date.now() });
  assert.strictEqual(db.U2.remindCount, 0);
  assert.strictEqual(db.U2.remindedAt, '');

  // 列がない（setup 前）：リマインドの列には書かず、やりとりは止めない
  vm.runInContext("headerMap_ = function () { return { 'LINEユーザーID': 0 }; };", c);
  db.U2.remindCount = 5;
  c.saveChat_('U2', { step: 'form', data: {}, startedAt: Date.now() });
  assert.strictEqual(db.U2.remindCount, 5);
  assert.strictEqual(c.sendChatReminders_(new Date(2026, 9, 20, 15, 0), false), 0);
});
