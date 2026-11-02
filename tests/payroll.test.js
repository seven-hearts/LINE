// 給与振込（gas/Payroll.gs）の所得税と振込ファイルを Node で検証する: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
for (const f of ['Options.gs', 'Validation.gs', 'Line.gs', 'Sheet.gs', 'Interview.gs', 'Shift.gs', 'Jobs.gs', 'Payroll.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
}
const plain = (x) => JSON.parse(JSON.stringify(x));

test('所得税：令和8年分 日額表の丙欄', () => {
  const t = ctx.heiTax_;
  // 9,800円未満は0円
  assert.strictEqual(t(0), 0);
  assert.strictEqual(t(9799), 0);
  // 表の行（以上〜未満）
  assert.strictEqual(t(9800), 1);
  assert.strictEqual(t(9899), 1);
  assert.strictEqual(t(9900), 5);
  assert.strictEqual(t(12000), 79);
  assert.strictEqual(t(15000), 193);
  assert.strictEqual(t(19500), 378);
  assert.strictEqual(t(19600), 386);
  assert.strictEqual(t(23999), 738);
  // 24,000円以上は率で計算（1円未満切り捨て）
  assert.strictEqual(t(24000), 746);
  assert.strictEqual(t(25000), 746 + 102);          // 1,000 × 10.21% = 102.1
  assert.strictEqual(t(26500), 1001);
  assert.strictEqual(t(30000), 1001 + 714);         // 3,500 × 20.42% = 714.7
  assert.strictEqual(t(32500), 2226);
  assert.strictEqual(t(40000), 2226 + 1914);        // 7,500 × 25.525% = 1914.375
  assert.strictEqual(t(57500), 8608);
  assert.strictEqual(t(100000), 8608 + 14319);      // 42,500 × 33.693% = 14319.525
  assert.strictEqual(t(116500), 28486);
  assert.strictEqual(t(200000), 28486 + 34101);     // 83,500 × 40.84% = 34101.4
  // 率の区切りで税額がつながっている
  for (const b of plain(ctx.HEI_BRACKETS).filter((x) => x.from > 24000)) assert.ok(Math.abs(t(b.from - 1) - b.base) <= 2, String(b.from)); // 国税庁の表の端数で最大2円の差
  // 表は100円ごとに増えていく
  const table = plain(ctx.HEI_TABLE);
  assert.strictEqual(table.length, (24000 - 9800) / 100);
  for (let i = 1; i < table.length; i++) assert.ok(table[i] > table[i - 1]);
});

test('口座名義を全銀フォーマットの半角カナに', () => {
  const k = ctx.zenginKana_;
  assert.strictEqual(k('ヤマダ　ハナコ'), 'ﾔﾏﾀﾞ ﾊﾅｺ');
  assert.strictEqual(k('じゃぱね たろう'), 'ｼﾞﾔﾊﾟﾈ ﾀﾛｳ');   // ひらがな・小さい字
  assert.strictEqual(k('ﾆｯﾎﾟﾝ・センター'), 'ﾆﾂﾎﾟﾝ.ｾﾝﾀ-');    // 半角カナ・中黒・長音
  assert.strictEqual(k('セブンハーツ'), 'ｾﾌﾞﾝﾊ-ﾂ');
  assert.strictEqual(k('カ）ヤマダ'), 'ｶ)ﾔﾏﾀﾞ');
  assert.strictEqual(k('ｓｍｉｔｈ ジョン'), 'SMITH ｼﾞﾖﾝ');
  assert.deepStrictEqual(plain(ctx.zenginBadChars_(k('ABC＆!'))), ['&', '!']);
  assert.deepStrictEqual(plain(ctx.zenginBadChars_(k('ﾔﾏﾀﾞ ﾊﾅｺ'))), []);
});

const onb = (o) => Object.assign({
  userId: 'U1', name: '山田 花子', bankName: 'みずほ銀行', bankCode: '0001', branchName: '新宿支店', branchCode: '021',
  accountType: '普通', accountNumber: '1234567', accountHolder: 'ヤマダ ハナコ'
}, o);
const app = (o) => Object.assign({
  status: '確定', workStatus: '出勤', userId: 'U1', name: '山田 花子', title: '展示会運営', date: '2026/10/08',
  pay: 12000, allowance: '', fare: 1060, paidOn: '', _row: 2
}, o);

test('振込額：日ごとに丙欄で所得税、交通費は非課税で足す', () => {
  const apps = [
    app({ date: '2026/10/08', pay: 12000, allowance: 500, fare: 1060, _row: 2 }),  // 課税 12,500 → 98円
    app({ date: '2026/10/09', pay: '9,000', fare: '', _row: 3 }),                  // 課税 9,000 → 0円
    app({ date: '2026/10/31', pay: 26000, fare: 880, _row: 4 }),                   // 課税 26,000 → 746 + 204 = 950円
    app({ date: '2026/11/01', pay: 12000, _row: 5 }),                              // 期間外
    app({ date: '2026/10/10', status: '見送り', _row: 6 }),                         // 確定でない
    app({ date: '2026/10/11', workStatus: '無断欠勤', pay: 0, _row: 7 }),           // 欠勤
    app({ date: '2026/10/12', paidOn: '2026/10/25', _row: 8 }),                    // 振込済み
    app({ userId: 'U2', name: '佐藤 太郎', date: '2026/10/15', pay: 8000, fare: 500, _row: 9 })
  ];
  const list = plain(ctx.buildPayroll_(apps, { U1: onb(), U2: onb({ userId: 'U2', name: '佐藤 太郎', accountHolder: 'サトウ タロウ' }) }, '2026/10/01', '2026/10/31', false));
  assert.deepStrictEqual(list.map((p) => p.name), ['佐藤 太郎', '山田 花子']);
  const p = list[1];
  assert.deepStrictEqual(p.days.map((d) => [d.date, d.taxable, d.tax, d.fare]), [
    ['2026/10/08', 12500, 98, 1060], ['2026/10/09', 9000, 0, 0], ['2026/10/31', 26000, 950, 880]
  ]);
  assert.strictEqual(p.pay, 47000);
  assert.strictEqual(p.allowance, 500);
  assert.strictEqual(p.taxable, 47500);
  assert.strictEqual(p.tax, 1048);
  assert.strictEqual(p.fare, 1940);
  assert.strictEqual(p.net, 47500 - 1048 + 1940);
  assert.deepStrictEqual(p.problems, []);
  assert.deepStrictEqual(p.warnings, ['2026/10/09 展示会運営：交通費（往復）が空です（0円で計算します）']);
  assert.deepStrictEqual(p.account, {
    bankCode: '0001', branchCode: '021', accountType: '1', accountNumber: '1234567', holder: 'ﾔﾏﾀﾞ ﾊﾅｺ',
    bankName: 'みずほ銀行', branchName: '新宿支店', problems: []
  });
  // 振込済みの行も含める（作り直し）
  const again = plain(ctx.buildPayroll_(apps, { U1: onb(), U2: onb() }, '2026/10/01', '2026/10/31', true));
  assert.strictEqual(again.find((x) => x.userId === 'U1').workDays, 4);
});

test('振込額：同じ日に2件あれば合計で所得税を計算する', () => {
  const [p] = plain(ctx.buildPayroll_([
    app({ pay: 6000, _row: 2, fare: 500 }), app({ pay: 6000, _row: 3, fare: 500 })
  ], { U1: onb() }, '2026/10/01', '2026/10/31'));
  assert.strictEqual(p.days.length, 1);
  assert.strictEqual(p.days[0].taxable, 12000);
  assert.strictEqual(p.tax, 79);
  assert.strictEqual(p.warnings.length, 1);
});

test('振込できない人：口座がない・給与額がない・名義の文字', () => {
  const run = (a, o) => plain(ctx.buildPayroll_([app(a)], o === undefined ? { U1: onb() } : o, '2026/10/01', '2026/10/31'))[0];
  assert.deepStrictEqual(run({ userId: '', name: '電話の人' }, {}).problems, ['「労務情報」がありません（書類が未提出か、LINE 未登録の人です）']);
  assert.match(run({ pay: '' }).problems.join('\n'), /給与額がありません/);
  assert.match(run({ fare: '電車' }).problems.join('\n'), /数字ではありません/);
  assert.match(run({}, { U1: onb({ bankCode: '' }) }).problems.join('\n'), /銀行コード/);
  assert.match(run({}, { U1: onb({ accountHolder: 'ヤマダ＆ハナコ' }) }).problems.join('\n'), /使えない文字.*&/);
  assert.match(run({}, { U1: onb({ accountHolder: 'ア'.repeat(31) }) }).problems.join('\n'), /30文字/);
  assert.match(run({ pay: 0, fare: 0 }).problems.join('\n'), /0円以下/);
});

test('WEB総振の全銀フォーマット（CSV）', () => {
  const src = plain(ctx.payrollSource_({ requesterName: 'セブンハーツ', branchCode: '003', accountNumber: '9002433' }));
  assert.deepStrictEqual(src.problems, []);
  const people = plain(ctx.buildPayroll_([
    app({ pay: 12000, fare: 1060 }),
    app({ userId: 'U2', name: '佐藤', pay: 8000, fare: 500 })
  ], { U1: onb(), U2: onb({ userId: 'U2', bankCode: '33', branchCode: '1', accountNumber: '42', accountHolder: 'サトウ タロウ' }) }, '2026/10/01', '2026/10/31'));
  const csv = ctx.zenginCsv_(src, '2026/11/25', people);
  assert.strictEqual(csv,
    '1,21,0,,ｾﾌﾞﾝﾊ-ﾂ,1125,0033,,003,,1,9002433,,\r\n' +
    '2,0033,,001,,,1,0000042,ｻﾄｳ ﾀﾛｳ,8500,0,,,,,,\r\n' +
    '2,0001,,021,,,1,1234567,ﾔﾏﾀﾞ ﾊﾅｺ,12981,0,,,,,,\r\n' +
    '8,2,21481,,\r\n' +
    '9,,\r\n');
  // Shift_JIS で1バイトになる文字だけ（半角英数字・半角カナ）
  assert.ok(/^[\x20-\x7e\r\nｦ-ﾟ]*$/.test(csv));
  // 振込元の確認
  assert.deepStrictEqual(plain(ctx.payrollSource_({ requesterName: '', branchCode: '3', accountNumber: '' })).problems, [
    '振込依頼人名を入れてください', '振込元の支店番号（3桁）を入れてください', '振込元の口座番号（7桁以内）を入れてください'
  ]);
});

test('振込日：過ぎた日・土日祝は不可', () => {
  const today = new Date(2026, 10, 2);
  assert.strictEqual(ctx.payDateProblem_('2026/11/25', today), '');
  assert.strictEqual(ctx.payDateProblem_('2026/11/02', today), '');
  assert.match(ctx.payDateProblem_('2026/11/01', today), /過ぎて/);
  assert.match(ctx.payDateProblem_('2026/11/28', today), /土日祝/);  // 土曜
  assert.match(ctx.payDateProblem_('2026/11/23', today), /土日祝/);  // 勤労感謝の日
  assert.match(ctx.payDateProblem_('', today), /選んで/);
});
