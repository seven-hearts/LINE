/**
 * 給与振込（PayPay銀行 WEB総振）。
 *
 * 「案件応募」で確定し、実際に働いた分（給与額＋手当）から所得税を日ごとに計算し、
 * 交通費（非課税）を足した振込額で、WEB総振に取り込むファイル（全銀フォーマット CSV）を作る。
 *
 * - 所得税：国税庁「給与所得の源泉徴収税額表（令和8年分）」日額表の丙欄（日雇賃金）
 *   https://www.nta.go.jp/publication/pamph/gensen/zeigakuhyo2026/01.htm
 * - 振込ファイル：PayPay銀行「WEB総振（総合振込）振込データの項目説明」（2025年3月6日改定）の「全銀フォーマット（CSV）」
 *   https://www.paypay-bank.co.jp/business/payment/transfer-all/guide/data.pdf
 */

// ---- 所得税（日額表・丙欄） ----

/** 税額表の年分（毎年1月に国税庁の新しい表と見比べ、変わっていればここと下の表を直す） */
var HEI_TABLE_YEAR = 2026;
/** 丙欄の表の範囲：9,800円以上 24,000円未満を100円刻み（これ未満は0円） */
var HEI_TABLE_FROM = 9800;
var HEI_TABLE_STEP = 100;
/** 9,800円〜23,900円の各行（その金額以上・100円上未満）の丙欄の税額 */
var HEI_TABLE = [
  1, 5, 8, 12, 15, 19, 22, 26, 29, 33,
  36, 40, 43, 47, 51, 55, 58, 62, 65, 69,
  72, 76, 79, 83, 86, 90, 93, 98, 101, 105,
  108, 112, 115, 119, 122, 126, 129, 133, 136, 140,
  144, 149, 153, 157, 161, 165, 169, 173, 177, 181,
  185, 189, 193, 198, 202, 206, 210, 214, 218, 222,
  226, 230, 234, 238, 242, 247, 251, 255, 259, 263,
  267, 271, 275, 279, 283, 287, 292, 296, 300, 304,
  308, 312, 316, 320, 324, 328, 332, 336, 341, 345,
  349, 353, 357, 361, 365, 369, 373, 378, 386, 395,
  403, 411, 419, 427, 435, 444, 452, 460, 468, 476,
  484, 493, 501, 509, 517, 525, 533, 542, 550, 558,
  566, 574, 582, 591, 599, 607, 615, 623, 631, 640,
  648, 656, 664, 672, 681, 689, 697, 705, 713, 721,
  730, 738
];
/**
 * 24,000円以上：その金額の場合の税額に、超える金額の率（％）を足す（1円未満は切り捨て）。
 * 率は千分の1％まであるので、10万倍した整数で計算する（小数の誤差で1円ずれないように）。
 */
var HEI_BRACKETS = [
  { from: 116500, base: 28486, rate: 40840 },  // 40.84％
  { from: 57500, base: 8608, rate: 33693 },    // 33.693％
  { from: 32500, base: 2226, rate: 25525 },    // 25.525％
  { from: 26500, base: 1001, rate: 20420 },    // 20.42％
  { from: 24000, base: 746, rate: 10210 }      // 10.21％
];

/** その日の給与（社会保険料等の控除後。交通費は含めない）→ 丙欄の所得税 */
function heiTax_(amount) {
  amount = Math.floor(Math.max(0, +amount || 0));
  for (var i = 0; i < HEI_BRACKETS.length; i++) {
    var b = HEI_BRACKETS[i];
    if (amount >= b.from) return b.base + Math.floor((amount - b.from) * b.rate / 100000);
  }
  if (amount < HEI_TABLE_FROM) return 0;
  return HEI_TABLE[Math.floor((amount - HEI_TABLE_FROM) / HEI_TABLE_STEP)];
}

// ---- 全銀フォーマットの文字（半角カナ） ----

var HALF_KANA_ = {
  'ア': 'ｱ', 'イ': 'ｲ', 'ウ': 'ｳ', 'エ': 'ｴ', 'オ': 'ｵ', 'カ': 'ｶ', 'キ': 'ｷ', 'ク': 'ｸ', 'ケ': 'ｹ', 'コ': 'ｺ',
  'サ': 'ｻ', 'シ': 'ｼ', 'ス': 'ｽ', 'セ': 'ｾ', 'ソ': 'ｿ', 'タ': 'ﾀ', 'チ': 'ﾁ', 'ツ': 'ﾂ', 'テ': 'ﾃ', 'ト': 'ﾄ',
  'ナ': 'ﾅ', 'ニ': 'ﾆ', 'ヌ': 'ﾇ', 'ネ': 'ﾈ', 'ノ': 'ﾉ', 'ハ': 'ﾊ', 'ヒ': 'ﾋ', 'フ': 'ﾌ', 'ヘ': 'ﾍ', 'ホ': 'ﾎ',
  'マ': 'ﾏ', 'ミ': 'ﾐ', 'ム': 'ﾑ', 'メ': 'ﾒ', 'モ': 'ﾓ', 'ヤ': 'ﾔ', 'ユ': 'ﾕ', 'ヨ': 'ﾖ',
  'ラ': 'ﾗ', 'リ': 'ﾘ', 'ル': 'ﾙ', 'レ': 'ﾚ', 'ロ': 'ﾛ', 'ワ': 'ﾜ', 'ヲ': 'ｦ', 'ン': 'ﾝ',
  'ガ': 'ｶﾞ', 'ギ': 'ｷﾞ', 'グ': 'ｸﾞ', 'ゲ': 'ｹﾞ', 'ゴ': 'ｺﾞ', 'ザ': 'ｻﾞ', 'ジ': 'ｼﾞ', 'ズ': 'ｽﾞ', 'ゼ': 'ｾﾞ', 'ゾ': 'ｿﾞ',
  'ダ': 'ﾀﾞ', 'ヂ': 'ﾁﾞ', 'ヅ': 'ﾂﾞ', 'デ': 'ﾃﾞ', 'ド': 'ﾄﾞ', 'バ': 'ﾊﾞ', 'ビ': 'ﾋﾞ', 'ブ': 'ﾌﾞ', 'ベ': 'ﾍﾞ', 'ボ': 'ﾎﾞ',
  'パ': 'ﾊﾟ', 'ピ': 'ﾋﾟ', 'プ': 'ﾌﾟ', 'ペ': 'ﾍﾟ', 'ポ': 'ﾎﾟ', 'ヴ': 'ｳﾞ',
  // 小さい字は使えないので大きい字にする（例：ｼﾞﾕｸ）
  'ァ': 'ｱ', 'ィ': 'ｲ', 'ゥ': 'ｳ', 'ェ': 'ｴ', 'ォ': 'ｵ', 'ッ': 'ﾂ', 'ャ': 'ﾔ', 'ュ': 'ﾕ', 'ョ': 'ﾖ', 'ヮ': 'ﾜ', 'ヵ': 'ｶ', 'ヶ': 'ｹ',
  'ヰ': 'ｲ', 'ヱ': 'ｴ',
  // 長音はハイフン、中黒はピリオドに
  'ー': '-', '－': '-', '‐': '-', '―': '-', '−': '-', '・': '.', '･': '.',
  '「': '｢', '」': '｣', '¥': '\\'
};
/** WEB総振で使える文字（半角の数字・英大文字・カナ・濁点・スペースと ¥ , . ｢ ｣ ( ) - /） */
var ZENGIN_CHARS_RE = /^[0-9A-Zｱ-ﾝｦﾞﾟ \\,.｢｣()\-\/]*$/;

/** 口座名義などを、全銀フォーマットの半角カナにする（ひらがな・全角英数字・小さい字・長音も直す） */
function zenginKana_(s) {
  s = toKatakana_(str_(s)).replace(/\s+/g, ' ').trim();
  // 半角カナは toKatakana_（NFKC）でいったん全角になる
  return s.split('').map(function (c) { return HALF_KANA_[c] || c; }).join('').toUpperCase();
}

/** 使えない文字（あれば） */
function zenginBadChars_(s) {
  var bad = {};
  String(s).split('').forEach(function (c) { if (!ZENGIN_CHARS_RE.test(c)) bad[c] = true; });
  return Object.keys(bad);
}

var ACCOUNT_TYPE_CODES = { '普通': '1', '当座': '2', '貯蓄': '4' };
var PAYPAY_BANK_CODE = '0033';
var ZENGIN_NAME_MAX = 30;      // 受取人名
var ZENGIN_REQUESTER_MAX = 40; // 振込依頼人名

// ---- 振込額の計算 ----

/** 「2026/10/08」→ 数字で比べられる「20261008」（不正なら ''） */
function dayKey_(v) {
  var d = parseYmd_(v);
  return d ? String(d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()) : '';
}

/**
 * 振込の対象にする「案件応募」の行：状態が「確定」、欠勤でない、日程が from〜to（「2026/10/01」など）。
 * includePaid でなければ、給与振込日が入っている行（振込データを作った行）は除く。
 */
function payrollTargetRows_(apps, from, to, includePaid) {
  var f = dayKey_(from), t = dayKey_(to);
  return apps.filter(function (a) {
    if (a.status !== APPLY_STATUS.CONFIRMED) return false;
    if (ABSENT_STATUSES.indexOf(a.workStatus) >= 0) return false;
    var k = dayKey_(a.date);
    if (!k || k < f || k > t) return false;
    return includePaid || !str_(a.paidOn);
  });
}

/** 「労務情報」の1行 → 振込先（足りないところは problems に） */
function payrollAccount_(onb) {
  var problems = [];
  if (!onb) return { problems: ['「労務情報」がありません（書類が未提出か、LINE 未登録の人です）'] };
  var bankCode = str_(onb.bankCode).replace(/\D/g, '');
  var branchCode = str_(onb.branchCode).replace(/\D/g, '');
  var number = str_(onb.accountNumber).replace(/\D/g, '');
  var type = ACCOUNT_TYPE_CODES[str_(onb.accountType)];
  var holder = zenginKana_(onb.accountHolder);
  if (!/^\d{1,4}$/.test(bankCode)) problems.push('「労務情報」の銀行コード（4桁）が入っていません');
  if (!/^\d{1,3}$/.test(branchCode)) problems.push('「労務情報」の支店番号（3桁）が入っていません');
  if (!/^\d{1,7}$/.test(number)) problems.push('「労務情報」の口座番号（7桁以内）が正しくありません');
  if (!type) problems.push('「労務情報」の口座種別が「普通」「当座」「貯蓄」ではありません');
  if (!holder) problems.push('「労務情報」の口座名義（カナ）が入っていません');
  else {
    var bad = zenginBadChars_(holder);
    if (bad.length) problems.push('口座名義に振込で使えない文字があります：' + bad.join(' ') + '（本人に正しいカナの口座名義を確認してください）');
    if (holder.length > ZENGIN_NAME_MAX) problems.push('口座名義が' + ZENGIN_NAME_MAX + '文字（半角・濁点も1文字）を超えています：' + holder);
  }
  return {
    bankCode: ('0000' + bankCode).slice(-4), branchCode: ('000' + branchCode).slice(-3), accountType: type,
    accountNumber: ('0000000' + number).slice(-7), holder: holder,
    bankName: str_(onb.bankName), branchName: str_(onb.branchName), problems: problems
  };
}

/**
 * 1人分の振込額。rows は「案件応募」の行（_row 付き）、onb は「労務情報」の行。
 * 所得税は日ごと（その日の給与額＋手当）に丙欄で計算する。交通費は非課税で、税の計算に含めない。
 */
function payrollPerson_(rows, onb) {
  var problems = [], warnings = [];
  var days = {}, order = [];
  rows.forEach(function (a) {
    var pay = toNum_(a.pay);
    var allowance = str_(a.allowance) === '' ? 0 : toNum_(a.allowance);
    var fare = str_(a.fare) === '' ? 0 : toNum_(a.fare);
    if (pay !== null) pay = Math.round(pay);
    if (allowance !== null) allowance = Math.round(allowance);
    if (fare !== null) fare = Math.round(fare);
    var label = ymd_(parseYmd_(a.date)) + ' ' + str_(a.title);
    if (pay === null) problems.push(label + '：給与額がありません（「案件応募」に勤務開始・終了時間を入れてください）');
    if (allowance === null) problems.push(label + '：手当「' + str_(a.allowance) + '」が数字ではありません');
    if (fare === null) problems.push(label + '：交通費（往復）「' + str_(a.fare) + '」が数字ではありません（「1,200」のように金額だけにしてください）');
    if (str_(a.fare) === '') warnings.push(label + '：交通費（往復）が空です（0円で計算します）');
    var k = dayKey_(a.date);
    if (!days[k]) { days[k] = { date: ymd_(parseYmd_(a.date)), rows: [], pay: 0, allowance: 0, fare: 0 }; order.push(k); }
    var d = days[k];
    d.rows.push(a);
    d.pay += pay || 0;
    d.allowance += allowance || 0;
    d.fare += fare || 0;
  });
  order.sort();
  var total = { pay: 0, allowance: 0, taxable: 0, tax: 0, fare: 0 };
  var dayList = order.map(function (k) {
    var d = days[k];
    d.taxable = d.pay + d.allowance;
    d.tax = heiTax_(d.taxable);
    if (d.rows.length > 1) warnings.push(d.date + '：同じ日に' + d.rows.length + '件あります（合計した金額で所得税を計算します）');
    total.pay += d.pay; total.allowance += d.allowance; total.taxable += d.taxable; total.tax += d.tax; total.fare += d.fare;
    return d;
  });
  var account = payrollAccount_(onb);
  problems = problems.concat(account.problems);
  var net = total.taxable - total.tax + total.fare;
  if (net <= 0) problems.push('振込額が0円以下です');
  return {
    days: dayList, workDays: dayList.length, pay: total.pay, allowance: total.allowance, taxable: total.taxable,
    tax: total.tax, fare: total.fare, net: net, account: account, problems: problems, warnings: warnings
  };
}

/**
 * 振込の一覧。apps は「案件応募」の行（_row 付き）、onbByUser は LINEユーザーID → 「労務情報」の行。
 * 人ごと（LINEユーザーID。LINE 未登録の人は氏名）にまとめる。
 */
function buildPayroll_(apps, onbByUser, from, to, includePaid) {
  var groups = {}, keys = [];
  payrollTargetRows_(apps, from, to, includePaid).forEach(function (a) {
    var key = str_(a.userId) || 'name:' + str_(a.name);
    if (!groups[key]) { groups[key] = { userId: str_(a.userId), name: str_(a.name), rows: [] }; keys.push(key); }
    groups[key].rows.push(a);
  });
  return keys.map(function (key) {
    var g = groups[key];
    var p = payrollPerson_(g.rows, g.userId ? onbByUser[g.userId] : null);
    p.key = key;
    p.userId = g.userId;
    p.name = g.name || (g.userId && onbByUser[g.userId] && onbByUser[g.userId].name) || '';
    p.rows = g.rows;
    return p;
  }).sort(function (a, b) { return a.name.localeCompare(b.name, 'ja'); });
}

/** 振込元（PayPay銀行の口座）。設定が足りなければ problems に */
function payrollSource_(src) {
  var problems = [];
  var name = zenginKana_(src.requesterName);
  var branch = str_(src.branchCode).replace(/\D/g, '');
  var number = str_(src.accountNumber).replace(/\D/g, '');
  if (!name) problems.push('振込依頼人名を入れてください');
  else {
    var bad = zenginBadChars_(name);
    if (bad.length) problems.push('振込依頼人名に使えない文字があります：' + bad.join(' '));
    if (name.length > ZENGIN_REQUESTER_MAX) problems.push('振込依頼人名は' + ZENGIN_REQUESTER_MAX + '文字（半角）以内にしてください');
  }
  if (!/^\d{3}$/.test(branch)) problems.push('振込元の支店番号（3桁）を入れてください');
  if (!/^\d{1,7}$/.test(number)) problems.push('振込元の口座番号（7桁以内）を入れてください');
  return { requesterName: name, branchCode: branch, accountNumber: ('0000000' + number).slice(-7), problems: problems };
}

/**
 * WEB総振に取り込む「全銀フォーマット（CSV）」の中身（改行は CRLF。Shift_JIS にするのは呼ぶ側）。
 * ヘッダー・データ・トレーラー・エンドの4種類。振込依頼人コードは WEB総振では使わないので空。
 * 振込元の預金種目は普通預金（1）。新規コードは「0」。
 */
function zenginCsv_(source, payDate, people) {
  var d = parseYmd_(payDate);
  var mmdd = pad2_(d.getMonth() + 1) + pad2_(d.getDate());
  var lines = [];
  lines.push(['1', '21', '0', '', source.requesterName, mmdd, PAYPAY_BANK_CODE, '', source.branchCode, '', '1', source.accountNumber, '', ''].join(','));
  var total = 0;
  people.forEach(function (p) {
    var a = p.account;
    lines.push(['2', a.bankCode, '', a.branchCode, '', '', a.accountType, a.accountNumber, a.holder, String(p.net), '0', '', '', '', '', '', ''].join(','));
    total += p.net;
  });
  lines.push(['8', String(people.length), String(total), '', ''].join(','));
  lines.push(['9', '', ''].join(','));
  return lines.join('\r\n') + '\r\n';
}

/** 振込日の確認（過ぎた日・土日祝は不可） */
function payDateProblem_(payDate, today) {
  var d = parseYmd_(payDate);
  if (!d) return '振込日を選んでください';
  if (d < startOfDay_(today)) return '振込日が過ぎています';
  if (isOffDay_(d)) return '振込日が土日祝です（銀行の営業日を選んでください）';
  return '';
}

// ---- 画面（PayrollDialog.html）から呼ぶ ----

function showPayroll() {
  jobSheets_();
  ensurePayrollColumns_();
  var html = HtmlService.createHtmlOutputFromFile('PayrollDialog').setWidth(960).setHeight(780);
  SpreadsheetApp.getUi().showModalDialog(html, '給与の振込データを作る（PayPay銀行 WEB総振）');
}

/** 「案件応募」に「所得税（丙欄）」「給与振込日」の列がなければ足す */
function ensurePayrollColumns_() {
  var ss = spreadsheet_();
  var sh = ss.getSheetByName(APPLY_SHEET);
  var h = headerMap_(sh);
  if (h['所得税（丙欄）'] === undefined || h['給与振込日'] === undefined) {
    migrateApplyColumns_(sh);
    ensureSheet_(ss, APPLY_SHEET);
    reorderColumns_(sh, APPLY_SHEET);
  }
}

function payrollProps_() {
  return PropertiesService.getScriptProperties();
}

function payrollInit() {
  var p = payrollProps_();
  var now = new Date();
  var first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var last = new Date(now.getFullYear(), now.getMonth(), 0);
  return {
    from: ymd_(first), to: ymd_(last),
    requesterName: p.getProperty('PAYROLL_REQUESTER_NAME') || 'セブンハーツ',
    branchCode: p.getProperty('PAYROLL_BRANCH_CODE') || '',
    accountNumber: p.getProperty('PAYROLL_ACCOUNT_NUMBER') || '',
    taxYear: HEI_TABLE_YEAR, thisYear: now.getFullYear()
  };
}

function payrollData_(req) {
  var from = parseYmd_(req && req.from), to = parseYmd_(req && req.to);
  if (!from || !to) throw new UserError('対象の勤務日（いつから・いつまで）を入れてください');
  if (from > to) throw new UserError('対象の勤務日の「いつから」が「いつまで」より後になっています');
  var apps = readAll_(APPLY_SHEET).map(function (x) { x.rec._row = x.row; return x.rec; });
  var onbByUser = {};
  readAll_(ONB_SHEET).forEach(function (x) { if (x.rec.userId) onbByUser[x.rec.userId] = x.rec; });
  return buildPayroll_(apps, onbByUser, ymd_(from), ymd_(to), !!req.includePaid);
}

function personView_(p) {
  return {
    key: p.key, name: p.name, workDays: p.workDays, pay: p.pay, allowance: p.allowance, taxable: p.taxable, tax: p.tax,
    fare: p.fare, net: p.net, problems: p.problems, warnings: p.warnings,
    account: !p.account.bankCode ? null : {
      bank: p.account.bankName + '（' + p.account.bankCode + '）', branch: p.account.branchName + '（' + p.account.branchCode + '）',
      type: p.account.accountType, number: p.account.accountNumber, holder: p.account.holder
    },
    days: p.days.map(function (d) { return { date: d.date, titles: d.rows.map(function (a) { return str_(a.title); }).join('、'), taxable: d.taxable, tax: d.tax, fare: d.fare }; }),
    paid: p.rows.filter(function (a) { return str_(a.paidOn); }).map(function (a) { return ymd_(parseYmd_(a.date)) + '（振込日 ' + str_(a.paidOn) + '）'; })
  };
}

/** 確認（シートは変えない） */
function payrollPreview(req) {
  return payrollData_(req).map(personView_);
}

/**
 * 選んだ人の振込データを作る。シートを読み直して計算し、
 * 「案件応募」に所得税と給与振込日を、シート「給与振込」に1人1行を記録して、Shift_JIS の CSV を返す。
 */
function payrollCreate(req) {
  var source = payrollSource_(req || {});
  var dateProblem = payDateProblem_(req && req.payDate, new Date());
  if (dateProblem) source.problems.unshift(dateProblem);
  if (source.problems.length) throw new UserError(source.problems.join('\n'));
  var chosen = {};
  (req.keys || []).forEach(function (k) { chosen[k] = true; });
  return withLock_(function () {
    ensurePayrollColumns_();
    var props = payrollProps_();
    props.setProperty('PAYROLL_REQUESTER_NAME', str_(req.requesterName));
    props.setProperty('PAYROLL_BRANCH_CODE', source.branchCode);
    props.setProperty('PAYROLL_ACCOUNT_NUMBER', str_(req.accountNumber).replace(/\D/g, ''));

    var people = payrollData_(req).filter(function (p) { return chosen[p.key]; });
    var ng = people.filter(function (p) { return p.problems.length; });
    if (ng.length) throw new UserError('直すところがある人が含まれています。もう一度「内容を確認」を押してください：\n' + ng.map(function (p) { return p.name; }).join('、'));
    if (!people.length) throw new UserError('振り込む人がいません。もう一度「内容を確認」を押してください');

    var payDate = ymd_(parseYmd_(req.payDate));
    var period = ymd_(parseYmd_(req.from)) + '〜' + ymd_(parseYmd_(req.to));
    var createdAt = now_();
    people.forEach(function (p) {
      p.days.forEach(function (d) {
        d.rows.forEach(function (a, i) {
          // 同じ日に2件あるときは、その日の所得税を1件目に入れる
          updateCells_(APPLY_SHEET, a._row, { incomeTax: i === 0 ? d.tax : 0, paidOn: payDate });
        });
      });
    });
    if (!spreadsheet_().getSheetByName(PAYROLL_SHEET)) ensureSheet_(spreadsheet_(), PAYROLL_SHEET);
    appendRecords_(PAYROLL_SHEET, people.map(function (p) {
      return {
        createdAt: createdAt, payDate: payDate, period: period, name: p.name, userId: p.userId, workDays: p.workDays,
        pay: p.pay, allowance: p.allowance, taxable: p.taxable, tax: p.tax, fare: p.fare, net: p.net,
        bankCode: p.account.bankCode, branchCode: p.account.branchCode, accountType: p.account.accountType,
        accountNumber: p.account.accountNumber, holder: p.account.holder,
        detail: p.days.map(function (d) { return d.date + ' 課税' + d.taxable + '円 税' + d.tax + '円 交通費' + d.fare + '円'; }).join(' / ')
      };
    }));

    var csv = zenginCsv_(source, payDate, people);
    var blob = Utilities.newBlob('').setDataFromString(csv, 'Shift_JIS');
    var total = people.reduce(function (s, p) { return s + p.net; }, 0);
    return {
      fileName: 'WEB総振_給与_' + payDate.replace(/\//g, '') + '.csv',
      base64: Utilities.base64Encode(blob.getBytes()),
      count: people.length, total: total, payDate: payDate
    };
  });
}
