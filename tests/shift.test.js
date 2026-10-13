// シフト提出と集計（gas/Shift.gs）の判定・整形・集計を Node で検証する: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
for (const f of ['Options.gs', 'Validation.gs', 'Line.gs', 'Sheet.gs', 'Interview.gs', 'Shift.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
}
// LIFF のURLは設定（スクリプト プロパティ）から作るため、テストでは固定にする
ctx.getConfig_ = () => ({ liffId: '1234567890-AbCdEfGh' });
const S = ctx.STATUS;
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi || 0);
const plain = (o) => JSON.parse(JSON.stringify(o));

test('月の計算：25日以降は翌月、受け付けるのは今月と翌月', () => {
  assert.strictEqual(ctx.defaultShiftMonth_(at(2026, 10, 24, 23)), '2026-10');
  assert.strictEqual(ctx.defaultShiftMonth_(at(2026, 10, 25, 0)), '2026-11');
  assert.strictEqual(ctx.nextShiftMonth_(at(2026, 12, 25, 10)), '2027-01');
  assert.strictEqual(ctx.shiftMonthLabel_('2027-01'), '2027年1月');
  assert.deepStrictEqual(plain(ctx.parseShiftMonth_('2026年11月')), { year: 2026, month: 11 });
  assert.ok(ctx.shiftMonthAllowed_('2026-11', at(2026, 10, 25, 10)));
  assert.ok(ctx.shiftMonthAllowed_('2026-10', at(2026, 10, 25, 10)));
  assert.ok(!ctx.shiftMonthAllowed_('2026-12', at(2026, 10, 25, 10)));
  assert.ok(!ctx.shiftMonthAllowed_('2026-09', at(2026, 10, 25, 10)));
});

test('案内は25日10時以降、稼働可の人に翌月分を1回だけ', () => {
  const r = { userId: 'U1', status: S.ACTIVE };
  assert.strictEqual(ctx.shiftRequestDue_(r, at(2026, 10, 25, 9, 59)), false);
  assert.strictEqual(ctx.shiftRequestDue_(r, at(2026, 10, 25, 10, 0)), true);
  assert.strictEqual(ctx.shiftRequestDue_(r, at(2026, 10, 28, 8, 0)), true); // 25日より後に稼働可になった人
  assert.strictEqual(ctx.shiftRequestDue_(r, at(2026, 10, 24, 12, 0)), false);
  assert.strictEqual(ctx.shiftRequestDue_(Object.assign({ shiftRequestedMonth: '2026年11月' }, r), at(2026, 10, 25, 10, 1)), false);
  assert.strictEqual(ctx.shiftRequestDue_(Object.assign({ shiftRequestedMonth: '2026年10月' }, r), at(2026, 10, 25, 10, 1)), true);
  assert.strictEqual(ctx.shiftRequestDue_(Object.assign({ blocked: 'ブロック中' }, r), at(2026, 10, 25, 10, 0)), false);
  for (const status of [S.PRE, S.HIRED, S.DOC_SUBMITTED, S.REJECTED, S.LEFT]) {
    assert.strictEqual(ctx.shiftRequestDue_({ userId: 'U1', status }, at(2026, 10, 25, 10, 0)), false, status);
  }
});

test('案内のメッセージ：ボタンで翌月のフォームを開く（本文は160文字以内）', () => {
  const [m] = ctx.shiftRequestMessages_({ lastName: '山田', firstName: '花子' }, '2026-11');
  assert.strictEqual(m.type, 'template');
  assert.ok(m.template.text.length <= 160, m.template.text.length);
  assert.match(m.template.text, /2026年11月のシフト提出/);
  assert.strictEqual(m.template.actions[0].uri, 'https://liff.line.me/1234567890-AbCdEfGh/shift.html?month=2026-11');
});

test('入力の整形：その月の日数ぶん○×、過ぎた日は以前の値のまま', () => {
  const now = at(2026, 10, 26, 12);
  const r = ctx.normalizeShift_({ days: { 1: '○', 2: '×', 30: '○', 31: '○' }, note: ' 午後のみ ' }, '2026-11', now, null);
  assert.strictEqual(r.d1, '○');
  assert.strictEqual(r.d2, '×');
  assert.strictEqual(r.d3, '×');
  assert.strictEqual(r.d30, '○');
  assert.strictEqual(r.d31, ''); // 11月は30日まで
  assert.strictEqual(r.availableDays, 2);
  assert.strictEqual(r.note, '午後のみ');

  // 今月分を26日に変更：25日以前は変わらない
  const cur = ctx.normalizeShift_({ days: { 1: '×', 26: '○', 31: '○' } }, '2026-10', now, { d1: '○', d25: '×' });
  assert.strictEqual(cur.d1, '○');
  assert.strictEqual(cur.d25, '×');
  assert.strictEqual(cur.d2, '');
  assert.strictEqual(cur.d26, '○');
  assert.strictEqual(cur.d31, '○');
  assert.strictEqual(cur.availableDays, 3);
});

test('入力の整形：受付期間外の月・長すぎる備考はエラー', () => {
  assert.throws(() => ctx.normalizeShift_({ days: {} }, '2026-12', at(2026, 10, 26, 12), null), { name: 'UserError' });
  assert.throws(() => ctx.normalizeShift_({ days: {} }, 'x', at(2026, 10, 26, 12), null), { name: 'UserError' });
  assert.throws(() => ctx.normalizeShift_({ days: {}, note: 'あ'.repeat(301) }, '2026-11', at(2026, 10, 26, 12), null), { name: 'ValidationError' });
});

test('集計：日ごと・エリアごとの出勤可能な人数（複数エリアはそれぞれに数え、合計は実人数）', () => {
  const staff = [
    { userId: 'A', name: '山田 花子', areas: '大阪、京都' },
    { userId: 'B', name: '佐藤 太郎', areas: '大阪' },
    { userId: 'C', name: '鈴木 次郎', areas: '兵庫' },
    { userId: 'D', name: '田中 三郎', areas: '' }
  ];
  const shifts = {
    A: { d1: '○', d2: '○' },
    B: { d1: '○', d2: '×' },
    D: { d1: '○' }
  };
  const s = ctx.shiftSummary_(staff, shifts, '2026-11', ['大阪', '兵庫', '京都', '滋賀', '奈良', '和歌山']);
  assert.deepStrictEqual(plain(s.areas), ['大阪', '兵庫', '京都', '滋賀', '奈良', '和歌山', 'エリア未設定']);
  assert.deepStrictEqual(plain(s.areaStaff), { '大阪': 2, '京都': 1, '兵庫': 1, 'エリア未設定': 1 });
  assert.strictEqual(s.days.length, 30);
  assert.strictEqual(s.days[0].weekday, 0); // 2026/11/1 は日曜
  const d1 = s.days[0];
  assert.deepStrictEqual(plain(d1.names['大阪']), ['山田 花子', '佐藤 太郎']);
  assert.deepStrictEqual(plain(d1.names['京都']), ['山田 花子']);
  assert.deepStrictEqual(plain(d1.names['兵庫']), []);
  assert.deepStrictEqual(plain(d1.names['エリア未設定']), ['田中 三郎']);
  assert.strictEqual(d1.all.length, 3);
  assert.deepStrictEqual(plain(s.days[1].names['大阪']), ['山田 花子']);
  assert.strictEqual(s.days[2].all.length, 0);
  assert.deepStrictEqual(s.notSubmitted.map((x) => x.name), ['鈴木 次郎']);
  assert.strictEqual(s.submitted.length, 3);
});

const ymd = (d) => ctx.formatDate_(d);
const holidays = (y) => plain(ctx.holidaysOf_(y));

test('祝日：2026年（振替休日・国民の休日を含む）', () => {
  assert.deepStrictEqual(holidays(2026), {
    '2026-01-01': '元日', '2026-01-12': '成人の日', '2026-02-11': '建国記念の日', '2026-02-23': '天皇誕生日',
    '2026-03-20': '春分の日', '2026-04-29': '昭和の日', '2026-05-03': '憲法記念日', '2026-05-04': 'みどりの日',
    '2026-05-05': 'こどもの日', '2026-05-06': '振替休日', '2026-07-20': '海の日', '2026-08-11': '山の日',
    '2026-09-21': '敬老の日', '2026-09-22': '国民の休日', '2026-09-23': '秋分の日', '2026-10-12': 'スポーツの日',
    '2026-11-03': '文化の日', '2026-11-23': '勤労感謝の日'
  });
  const h27 = holidays(2027);
  assert.strictEqual(h27['2027-03-21'], '春分の日');
  assert.strictEqual(h27['2027-03-22'], '振替休日'); // 春分の日が日曜
  assert.strictEqual(h27['2027-09-23'], '秋分の日');
});

test('カレンダーの色：平日は白、土日祝はオレンジ、3連休以上は赤', () => {
  const nov = plain(ctx.monthCalendar_(2026, 11));
  const type = (cal, d) => cal[d - 1].type;
  assert.strictEqual(nov.length, 30);
  assert.strictEqual(type(nov, 1), 'off');      // 10/31(土)〜11/1(日) の2連休
  assert.strictEqual(type(nov, 2), 'weekday');
  assert.strictEqual(type(nov, 3), 'off');      // 文化の日（火）だけの休み
  assert.strictEqual(nov[2].holiday, '文化の日');
  assert.strictEqual(type(nov, 7), 'off');
  for (const d of [21, 22, 23]) assert.strictEqual(type(nov, d), 'long', '11/' + d); // 土日＋勤労感謝の日
  assert.strictEqual(type(nov, 24), 'weekday');

  const sep = plain(ctx.monthCalendar_(2026, 9));
  for (const d of [19, 20, 21, 22, 23]) assert.strictEqual(type(sep, d), 'long', '9/' + d); // シルバーウィーク5連休
  assert.strictEqual(type(sep, 24), 'weekday');

  // 月をまたぐ連休：2027/1/1(金)〜1/3(日)、2026/5/2(土)〜5/6(水)
  const jan = plain(ctx.monthCalendar_(2027, 1));
  for (const d of [1, 2, 3]) assert.strictEqual(type(jan, d), 'long', '1/' + d);
  const may = plain(ctx.monthCalendar_(2026, 5));
  for (const d of [2, 3, 4, 5, 6]) assert.strictEqual(type(may, d), 'long', '5/' + d);
  const apr = plain(ctx.monthCalendar_(2026, 4));
  assert.strictEqual(type(apr, 29), 'off'); // 昭和の日（水）
  assert.strictEqual(ymd(new Date(2026, 3, 29)), '2026-04-29');
});
