// freee の請求書（gas/Freee.gs）の計算を Node で検証する: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
for (const f of ['Options.gs', 'Validation.gs', 'Line.gs', 'Sheet.gs', 'Interview.gs', 'Jobs.gs', 'Freee.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
}
const plain = (x) => JSON.parse(JSON.stringify(x));

const row = (o) => Object.assign({
  client: '株式会社テスト', title: '展示会運営', role: 'ST', date: '2026/10/08', start: '08:30', end: '17:30',
  breakHours: 1, unit: '時給', unitPrice: 1600, headcount: 3, transport: 660, meal: '', notes: '',
  invoice: '未', salesMonth: '2026/10', slotId: 'A-1', freeeInvoice: '', _row: 2
}, o);

test('時給：単価 × 時間（休憩を含む）× 人数、交通費は別の行', () => {
  const [inv] = plain(ctx.buildInvoices_([row()], '2026/10', {}));
  assert.deepStrictEqual(inv.problems, []);
  assert.strictEqual(inv.lines.length, 2);
  assert.strictEqual(inv.lines[0].description, '10/8(木) 展示会運営 08:30〜17:30（9時間×3名）');
  assert.strictEqual(inv.lines[0].quantity, 27);
  assert.strictEqual(inv.lines[0].unit_price, 1600);
  assert.strictEqual(inv.lines[1].description, '10/8(木) 交通費（3名）');
  assert.strictEqual(inv.subtotal, 1600 * 27 + 660 * 3);
  assert.strictEqual(inv.tax, Math.floor(inv.subtotal / 10));
  assert.strictEqual(inv.total, inv.subtotal + inv.tax);
});

test('日給・食費・時間保証・ポジション', () => {
  const lines = (o) => plain(ctx.invoiceRowLines_(row(o))).lines;
  const daily = lines({ unit: '日給', unitPrice: 12000, transport: '', meal: 1000, role: 'D' });
  assert.deepStrictEqual(daily.map((l) => [l.description, l.quantity, l.unit_price]), [
    ['10/8(木) 展示会運営（D）', 3, 12000],
    ['10/8(木) 食費（3名）', 3, 1000]
  ]);
  const guaranteed = lines({ start: '08:30', end: '12:30', notes: '5時間保証', transport: '' });
  assert.strictEqual(guaranteed[0].quantity, 15);
  assert.strictEqual(lines({ start: '18:00', end: '0:30', transport: '', headcount: 2 })[0].quantity, 13); // 日をまたぐ
});

test('足りない情報は推測せず、作成できないようにする', () => {
  const [inv] = plain(ctx.buildInvoices_([row({ unitPrice: '', headcount: '' })], '2026/10', {}));
  assert.strictEqual(inv.lines.length, 0);
  assert.match(inv.problems[0], /2行目 10\/8\(木\) 展示会運営：人数・単価が入っていません/);
  const [noClient] = plain(ctx.buildInvoices_([row({ client: '' })], '2026/10', {}));
  assert.strictEqual(noClient.client, '（取引先名なし）');
  assert.match(noClient.problems[0], /取引先名が入っていません/);
});

test('取引先ごとにまとめ、対象の月・「未」の行だけ。支払期日は翌々月末（Switch は翌月末）', () => {
  const rows = [
    row({ _row: 2 }),
    row({ _row: 3, client: '株式会社Ｓｗｉｔｃｈ', date: '2026/10/20' }),
    row({ _row: 4, date: '2026/10/01' }),
    row({ _row: 5, salesMonth: '2026/11', date: '2026/11/01' }),
    row({ _row: 6, invoice: '発行済' }),
    row({ _row: 7, freeeInvoice: '123' }),
    row({ _row: 8, client: '株式会社 Switch', date: '2026/10/21' })
  ];
  const invs = plain(ctx.buildInvoices_(rows, '2026/10', {}));
  assert.deepStrictEqual(invs.map((i) => [i.client, i.rows, i.billingDate, i.paymentDate]), [
    ['株式会社テスト', [2, 4], '2026-10-31', '2026-12-31'],
    ['株式会社Ｓｗｉｔｃｈ', [3, 8], '2026-10-31', '2026-11-30']
  ]);
  assert.deepStrictEqual(invs[0].lines.map((l) => l.sales_date), ['2026-10-01', '2026-10-01', '2026-10-08', '2026-10-08']);
  assert.strictEqual(invs[0].subject, '2026年10月分 展示会運営');
  assert.strictEqual(plain(ctx.buildInvoices_([row({ salesMonth: '2026/12', date: '2026/12/01' })], '2026/12', {}))[0].paymentDate, '2027-02-28');
});

test('同じ取引先でもタイトルが違えば別の請求書', () => {
  const invs = plain(ctx.buildInvoices_([
    row({ _row: 2 }), row({ _row: 3, title: '物産展' }), row({ _row: 4, date: '2026/10/09' }), row({ _row: 5, title: '' })
  ], '2026/10', {}));
  assert.deepStrictEqual(invs.map((i) => [i.client, i.title, i.rows, i.subject]), [
    ['株式会社テスト', '展示会運営', [2, 4], '2026年10月分 展示会運営'],
    ['株式会社テスト', '物産展', [3], '2026年10月分 物産展'],
    ['株式会社テスト', '', [5], '2026年10月分 イベント運営業務']
  ]);
  assert.strictEqual(new Set(invs.map((i) => i.key)).size, 3);
});

test('入金予定月（取り込み時）も取引先ごとの支払期日に合わせる', () => {
  assert.strictEqual(ctx.paymentMonthsFor_('株式会社Switch'), 1);
  assert.strictEqual(ctx.paymentMonthsFor_('株式会社テスト'), 2);
  assert.strictEqual(ctx.paymentMonthsFor_('株式会社テスト', 3), 3);
  assert.strictEqual(ctx.paymentMonthsFor_('株式会社switch', 3), 1);
});

test('案件応募の実際の勤務時間（休憩を含む）と人数で請求する', () => {
  const w = (name, actualStart, actualEnd) => ({ name, actualStart, actualEnd });
  // 全員同じ時間
  let [inv] = plain(ctx.buildInvoices_([row()], '2026/10', { 'A-1': [w('山田', '8:30', '18:00'), w('佐藤', '8:30', '18:00')] }));
  assert.strictEqual(inv.lines[0].description, '10/8(木) 展示会運営 08:30〜18:00（9.5時間×2名）');
  assert.strictEqual(inv.lines[0].quantity, 19);
  assert.strictEqual(inv.lines[1].description, '10/8(木) 交通費（2名）');
  assert.match(inv.warnings[0], /出勤（確定）の2名で計算しています（案件一覧の人数は3名）/);
  // 人によって違う・未入力の人は予定の時間（08:30〜17:30 = 9時間）
  [inv] = plain(ctx.buildInvoices_([row()], '2026/10', { 'A-1': [w('山田', '8:30', '18:00'), w('佐藤', '9:00', '17:00'), w('鈴木', '', '')] }));
  assert.deepStrictEqual(inv.lines.map((l) => [l.description, l.quantity]), [
    ['10/8(木) 展示会運営 08:30〜17:30（9時間×1名）', 9],
    ['10/8(木) 展示会運営 08:30〜18:00（9.5時間×1名）', 9.5],
    ['10/8(木) 展示会運営 09:00〜17:00（8時間×1名）', 8],
    ['10/8(木) 交通費（3名）', 3]
  ]);
  assert.deepStrictEqual(inv.warnings, ['2行目 10/8(木) 展示会運営：勤務開始・終了時間が未入力のため予定の時間で計算：鈴木']);
  [inv] = plain(ctx.buildInvoices_([row({ transport: '' })], '2026/10', { 'A-1': [w('山田', '9:00', '17:00'), w('佐藤', '8:30', '18:00'), w('鈴木', '09:00', '17:00')] }));
  assert.deepStrictEqual(inv.lines.map((l) => l.description), [
    '10/8(木) 展示会運営 08:30〜18:00（9.5時間×1名）',
    '10/8(木) 展示会運営 09:00〜17:00（8時間×2名）'
  ]);
  // 時間保証は1人ずつ
  [inv] = plain(ctx.buildInvoices_([row({ notes: '5時間保証', headcount: 1 })], '2026/10', { 'A-1': [w('山田', '9:00', '12:00')] }));
  assert.strictEqual(inv.lines[0].quantity, 5);
  // 日給は出勤した人数
  [inv] = plain(ctx.buildInvoices_([row({ unit: '日給', unitPrice: 12000, transport: '' })], '2026/10', { 'A-1': [w('山田', '', ''), w('佐藤', '', '')] }));
  assert.deepStrictEqual(inv.lines.map((l) => [l.quantity, l.unit_price]), [[2, 12000]]);
  // 全員欠勤なら請求しない。確定した人がいない枠は、シートの人数と予定の時間
  [inv] = plain(ctx.buildInvoices_([row()], '2026/10', { 'A-1': [] }));
  assert.strictEqual(inv.lines.length, 0);
  [inv] = plain(ctx.buildInvoices_([row()], '2026/10', { 'B-1': [w('山田', '8:30', '18:00')] }));
  assert.strictEqual(inv.lines[0].quantity, 27);
  assert.deepStrictEqual(inv.warnings, []);
});

test('freee に送る形（税抜・外税・御中）と、取引先の照合', () => {
  const [inv] = ctx.buildInvoices_([row()], '2026/10', {});
  const body = plain(ctx.invoiceRequest_(inv, 99, 5));
  assert.strictEqual(body.company_id, 99);
  assert.strictEqual(body.partner_id, 5);
  assert.strictEqual(body.tax_entry_method, 'out');
  assert.strictEqual(body.partner_title, '御中');
  assert.strictEqual(body.payment_date, '2026-12-31');
  assert.deepStrictEqual(body.lines[0], {
    type: 'item', description: '10/8(木) 展示会運営 08:30〜17:30（9時間×3名）', sales_date: '2026-10-08',
    quantity: 27, unit: '時間', unit_price: '1600', tax_rate: 10
  });
  const partners = [{ id: 1, name: '株式会社テスト' }, { id: 2, name: 'Switch', long_name: '株式会社Switch' }];
  assert.strictEqual(ctx.findPartner_(partners, '株式会社 テスト').id, 1);
  assert.strictEqual(ctx.findPartner_(partners, '株式会社Switch').id, 2);
  assert.throws(() => ctx.findPartner_(partners, '株式会社ほか'), /見つかりません/);
  assert.match(ctx.freeeErrorText_(400, { errors: [{ messages: ['請求書番号は必須です'] }] }), /請求書番号は必須です/);
});

test('売上ダッシュボード：取引先ごと・月ごとの売上と延べ人数、請求の状況', () => {
  const rows = [
    row({ client: 'A社', salesMonth: '2026/10', sales: 100000, headcount: 3, invoice: '入金済' }),
    row({ client: 'A社', salesMonth: '2026/11', sales: '50,000', headcount: 2, invoice: '' }),
    row({ client: 'B社', salesMonth: '', date: '2026/11/20', sales: 200000, headcount: 5, invoice: '発行済' }),
    row({ client: 'B社', salesMonth: '2026/12', sales: 30000, headcount: 1 }),         // 先の月（予定）
    row({ client: '', salesMonth: '2026/11', sales: 1000, headcount: 1 }),            // 取引先なし
    row({ client: 'A社', salesMonth: '2026/11', sales: '', headcount: 4 }),            // 売上が空欄
    row({ client: 'C社', salesMonth: '2025/11', sales: 999999, headcount: 9 }),       // 12か月より前は含めない
    row({ client: 'C社', salesMonth: '2027/06', sales: 999999, headcount: 9 })        // 7か月以上先も含めない
  ];
  const d = plain(ctx.salesDashboard_(rows, '2026/11'));
  assert.strictEqual(d.months.length, 13); // 2025/12〜2026/12
  assert.strictEqual(d.months[0], '2025/12');
  assert.strictEqual(d.months[12], '2026/12');
  assert.deepStrictEqual(d.clients.map((c) => [c.name, c.total, c.peopleTotal]), [
    ['B社', 230000, 6], ['A社', 150000, 9], ['（取引先なし）', 1000, 1]
  ]);
  const i = (ym) => d.months.indexOf(ym);
  assert.strictEqual(d.clients[1].sales[i('2026/10')], 100000);
  assert.strictEqual(d.clients[1].sales[i('2026/11')], 50000);
  assert.strictEqual(d.monthTotal[i('2026/11')], 251000);
  assert.strictEqual(d.grand, 381000);
  assert.strictEqual(d.missing[i('2026/11')], 1);
  assert.strictEqual(d.invoice['入金済'][i('2026/10')], 100000);
  assert.strictEqual(d.invoice['発行済'][i('2026/11')], 200000);
  assert.strictEqual(d.invoice['未'][i('2026/11')], 51000);

  const t = plain(ctx.salesDashboardRows_(ctx.salesDashboard_(rows, '2026/11'), '2026/11/06 06:00'));
  assert.strictEqual(t.width, 13 + 3);
  const head = t.rows[t.heads[0]];
  assert.deepStrictEqual([head[0], head[1], head[13], head[14], head[15]], ['取引先', '25/12', '26/12', '合計', '構成比']);
  const b = t.rows.find((r) => r[0] === 'B社');
  assert.strictEqual(b[14], 230000);
  assert.ok(Math.abs(b[15] - 230000 / 381000) < 1e-9);
  assert.ok(t.rows.some((r) => /売上が空欄の行/.test(r[0])));
  assert.ok(t.rows.every((r) => r.length === t.width));
  // 前月比（10月 100,000 → 11月 251,000）
  const mom = t.rows.find((r) => r[0] === '前月比');
  assert.ok(Math.abs(mom[1 + i('2026/11')] - 1.51) < 1e-9);
});
