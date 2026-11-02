/**
 * 案件の取り込み（お客様から届いたテキスト → シート「案件一覧」）と、スタッフへの LINE 配信。
 *
 * このファイルの関数はシート・LINE・Claude に触れないので、tests/jobs.test.js で確認できる。
 * 実際の読み書きは JobsApp.gs、画面は JobImport.html / JobSend.html。
 *
 * 1行 = 1日（同じ日に時間帯が複数あるときは時間帯ごと）。売上などの計算列はこのファイルで計算する。
 */

var RECRUIT = { OPEN: '募集中', CLOSED: '募集終了' };
/** 「案件応募」の状態（B列）。担当者が設定する */
var APPLY_STATUS = {
  APPLIED: '応募',     // スタッフが応募ボタンを押した
  CONFIRMED: '確定',   // 担当者が設定 → 確定の連絡を自動送信
  DECLINED: '見送り',  // 担当者が設定 → お断りの連絡を自動送信
  CANCELLED: '辞退'
};

/** 「案件応募」で、実働時間・給与額の計算に使う列（ここを編集すると計算し直す） */
var PAY_INPUT_LABELS = ['勤務ステータス', '勤務開始時間', '勤務終了時間', '休憩時間', '給与形態', '単価'];
/** 実際の勤務・給与の列（「終了予定時間」の右に並べる） */
var APPLY_WORK_LABELS = ['勤務開始時間', '勤務終了時間', '休憩時間', '実働時間', '給与形態', '単価', '給与額', '手当', '所得税（丙欄）', '給与振込日'];

/** 「案件応募」の勤務ステータス（状態の隣の列）。確定した人の当日までの進み具合 */
var WORK_STATUS = {
  DETAIL_SENT: '詳細送付済',       // 詳細連絡を送ると自動
  DEPART_TIME_OK: '出発時間確認済', // スタッフから出発時間の返信が来ると自動
  DEPART_OK: '出発確認済',         // 出発確認に「はい」と答えると自動
  DEPART_CHECKING: '出発確認中',    // 出発時間に確認を送ると自動（10分返信がなければメール）
  ARRIVED: '出勤',                // ここから下は担当者が設定
  LATE: '遅刻',
  ABSENT_NOTICE: '連絡欠勤',
  ABSENT: '無断欠勤'
};

/** 以前の「状態」の値 → [状態, 勤務ステータス]（以前は勤務の進み具合も「状態」に入れていた） */
function applyStatusSplit_(v) {
  var works = Object.keys(WORK_STATUS).map(function (k) { return WORK_STATUS[k]; });
  return works.indexOf(v) >= 0 ? [APPLY_STATUS.CONFIRMED, v] : [v, ''];
}

/** 欠勤（終了確認を送らない） */
var ABSENT_STATUSES = [WORK_STATUS.ABSENT_NOTICE, WORK_STATUS.ABSENT];

/** 出発確認に返信がないとき、担当者にメールするまでの時間（分） */
var DEPART_ALERT_MINUTES = 10;
/** 出発時間を過ぎてもこの時間内なら出発確認を送る（自動処理が止まっていた場合など） */
var DEPART_CHECK_WINDOW_MINUTES = 60;
var INVOICE_OPTIONS = ['未', '発行済', '入金済'];
/** 支払期日（末締め）：売上計上月の何か月後の月末か。取引先ごとの例外はここに書く（取引先名はシートと同じ書き方） */
var PAYMENT_TERM_EXCEPTIONS = {
  '株式会社Switch': 1
};
/** 例外以外の取引先（翌々月末）。スクリプト プロパティ PAYMENT_MONTHS_AFTER で変更できる */
var DEFAULT_PAYMENT_MONTHS = 2;
/** ポジション（D：ディレクター／AD：アシスタントディレクター／ST：スタッフ） */
var ROLES = ['D', 'AD', 'ST'];
var DEFAULT_ROLE = 'ST';

var PAY_BASIS = ['拘束時間', '実働時間', '日給', '記載なし']; // 売上の計算に使う（シートには残さない）
var UNITS = ['時給', '日給'];
var GENDER_REQ = ['男女可', '男性のみ', '女性のみ', '記載なし'];

/** スタッフに案内する交通費（全額支給で統一） */
var STAFF_TRANSPORT = '全額支給';

/** 1つのバブルに並べる応募ボタンの数（多い日程は次のバブルに分ける） */
var SLOTS_PER_BUBBLE = 8;
var MAX_BUBBLES = 12;          // カルーセル1つあたり（LINE の上限）
var MAX_MESSAGES = 5;          // 1回の送信あたり（LINE の上限）
var MULTICAST_LIMIT = 500;     // 1回の一斉送信の宛先（LINE の上限）

// ---- Claude への指示 ----

function jobSystemPrompt_(today) {
  return 'あなたはイベントスタッフ派遣会社「セブンハーツ」の案件管理担当です。' +
    '取引先（お客様）からメールやLINEで届いた人員手配の依頼文を読み、案件表に入力する項目を取り出します。\n\n' +
    '今日は ' + ymd_(today) + '（' + WEEKDAYS_JA[today.getDay()] + '）です。年が書かれていない日付は、今日以降で最も近い年の日付にしてください。\n\n' +
    '守ること：\n' +
    '- 書かれていないことは推測で埋めず、空文字または null にする（休憩時間・人数・金額も同じ）\n' +
    '- 金額は円の数値だけにする（「¥1,600」→ 1600）\n' +
    '- 依頼文は複数のメッセージが混ざっていたり、案件の一覧と詳細が離れて書かれていたり、' +
    '服装などの続きが文の最後に書かれていたりします。対象の案件に関係する部分をすべて読んでまとめる\n' +
    '- 他の案件の情報を混ぜない';
}

/** 1回目：依頼文に含まれる案件を数える */
function jobListPrompt_() {
  return '上の依頼文に含まれる案件（イベント・現場ごと）を、書かれている順にすべて挙げてください。' +
    'label には、その案件だとわかる番号・名称・会場を依頼文の書き方のまま入れてください（例：「②パン祭り＠ららぽーとエキスポシティ」）。' +
    '同じイベントで日程が複数あっても1つの案件です。';
}

/** 2回目：案件ごとに詳しく読む */
function jobDetailPrompt_(label, all) {
  return '上の依頼文に含まれる案件は次のとおりです：\n' + all.map(function (l) { return '・' + l; }).join('\n') + '\n\n' +
    'このうち「' + label + '」の案件だけについて、項目を取り出してください。\n\n' + JOB_FIELD_RULES_;
}

/** Gemini 用：1回の問い合わせですべての案件を読む（無料枠は1日の回数が少ないため） */
function jobAllPrompt_() {
  return '上の依頼文に含まれる案件（イベント・現場ごと）を、書かれている順にすべて取り出して cases に入れてください。' +
    '同じイベントで日程が複数あっても1つの案件です。案件ごとに、次のとおり項目を入れてください。\n\n' + JOB_FIELD_RULES_;
}

var JOB_FIELD_RULES_ =
    '- shifts：勤務する日ごとに1つ。同じ日に時間帯が複数あれば時間帯ごとに分け、それぞれの人数を入れる。' +
    '「10/7〜9 各日8名」なら3日分それぞれ8名。日によって時間が違えばその日の時間を使う\n' +
    '- start / end：勤務時間（集合時間ではない）。「HH:MM」の24時間表記\n' +
    '- holiday：日付に「祝」と書かれていれば true\n' +
    '- position：仕事内容を短く（例：「案内業務」「イベント運営（受付・誘導・準備片付け）」）\n' +
    '- pay_basis：「拘束時間×¥1,600」なら「拘束時間」と unit_price 1600。日当なら「日給」\n' +
    '- min_hours：「5h保証」など最低保証時間があれば時間数\n' +
    '- transport_fee：1人あたりの交通費（往復の金額）。transport_note に区間など\n' +
    '- meal_fee：食費の金額。金額がなく「支給あり」「なし」などなら meal_note に入れる\n' +
    '- gender：性別の指定（「男女不問」「男女可能」は 男女可）。conditions には性別・年齢などの条件をそのまま\n' +
    '- notes：時間が前後する可能性など、上の項目に入らない注意事項（短く）\n' +
    '- client_name：依頼文に依頼元の会社名がはっきり書かれていれば。なければ空文字';

var NULLABLE_INT_ = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
var NULLABLE_NUM_ = { anyOf: [{ type: 'number' }, { type: 'null' }] };

function objectSchema_(props) {
  return { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false };
}

var JOB_LIST_SCHEMA = objectSchema_({
  cases: { type: 'array', items: objectSchema_({ label: { type: 'string' } }) }
});

var JOB_DETAIL_SCHEMA = objectSchema_({
  client_name: { type: 'string' },
  title: { type: 'string' },
  venue: { type: 'string' },
  prefecture: { type: 'string', description: '会場の都道府県（例：大阪府）。わからなければ空文字' },
  address_access: { type: 'string', description: '住所と最寄り駅からのアクセス' },
  position: { type: 'string' },
  conditions: { type: 'string' },
  gender: { type: 'string', enum: GENDER_REQ },
  dress: { type: 'string' },
  belongings: { type: 'string' },
  meeting_time: { type: 'string' },
  meeting_place: { type: 'string' },
  contact: { type: 'string', description: '現場の集合担当者・連絡先' },
  pay_basis: { type: 'string', enum: PAY_BASIS },
  unit_price: NULLABLE_INT_,
  min_hours: NULLABLE_NUM_,
  transport_fee: NULLABLE_INT_,
  transport_note: { type: 'string' },
  meal_fee: NULLABLE_INT_,
  meal_note: { type: 'string' },
  notes: { type: 'string' },
  shifts: {
    type: 'array',
    items: objectSchema_({
      date: { type: 'string', description: 'YYYY-MM-DD' },
      holiday: { type: 'boolean' },
      start: { type: 'string', description: 'HH:MM。不明なら空文字' },
      end: { type: 'string', description: 'HH:MM。不明なら空文字' },
      break_minutes: NULLABLE_INT_,
      headcount: NULLABLE_INT_,
      note: { type: 'string' }
    })
  }
});

var JOB_ALL_SCHEMA = objectSchema_({ cases: { type: 'array', items: JOB_DETAIL_SCHEMA } });

// ---- 日付と時間 ----

// WEEKDAYS_JA・pad2_ は Validation.gs のものを使う

function ymd_(d) {
  return d.getFullYear() + '/' + pad2_(d.getMonth() + 1) + '/' + pad2_(d.getDate());
}

/** 「2026-10-08」「2026/10/8」→ Date（不正なら null） */
function parseYmd_(s) {
  if (Object.prototype.toString.call(s) === '[object Date]') return isNaN(s.getTime()) ? null : s;
  var m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/.exec(String(s || '').trim());
  if (!m) return null;
  var d = new Date(+m[1], m[2] - 1, +m[3]);
  return d.getMonth() === m[2] - 1 ? d : null;
}

/** 「8:30」「08:30」「8時30分」→ 「08:30」（不正なら ''） */
function normalizeTime_(s) {
  if (Object.prototype.toString.call(s) === '[object Date]') return pad2_(s.getHours()) + ':' + pad2_(s.getMinutes());
  var m = /^(\d{1,2})\s*[:：時]\s*(\d{0,2})/.exec(String(s || '').trim().replace(/[０-９]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  }));
  if (!m || +m[1] > 30 || +(m[2] || 0) > 59) return '';
  return pad2_(+m[1]) + ':' + pad2_(+(m[2] || 0));
}

function minutesOf_(hhmm) {
  var t = normalizeTime_(hhmm);
  if (!t) return null;
  return +t.slice(0, 2) * 60 + +t.slice(3);
}

/** 開始〜終了の時間数（日をまたぐ場合も）。不明なら null */
function spanHours_(start, end) {
  var s = minutesOf_(start), e = minutesOf_(end);
  if (s === null || e === null) return null;
  if (e <= s) e += 24 * 60;
  return round2_((e - s) / 60);
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

/** 「2026/10」に months か月足す */
function addMonths_(ym, months) {
  var m = /^(\d{4})\/(\d{2})$/.exec(ym || '');
  if (!m) return '';
  var d = new Date(+m[1], +m[2] - 1 + months, 1);
  return d.getFullYear() + '/' + pad2_(d.getMonth() + 1);
}

function isNum_(v) {
  return typeof v === 'number' && isFinite(v);
}

/** シートの値（文字の「1,600」なども）→ 数値。空なら null */
function toNum_(v) {
  if (isNum_(v)) return v;
  var s = String(v === null || v === undefined ? '' : v).replace(/[¥￥,，円\s]/g, '').replace(/[０-９．]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  });
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return +s;
}

// ---- Claude の結果 → 画面で確認する案件 ----

function str_(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * Claude が返した1案件を、確認画面とシートで使う形にそろえる。
 * 不正な日付は捨て、時間は「HH:MM」にそろえる。
 */
function normalizeCase_(c) {
  var shifts = (c.shifts || []).map(function (s) {
    var d = parseYmd_(s.date);
    if (!d) return null;
    return {
      date: ymd_(d),
      holiday: !!s.holiday,
      start: normalizeTime_(s.start),
      end: normalizeTime_(s.end),
      breakHours: isNum_(s.break_minutes) ? round2_(s.break_minutes / 60) : null,
      headcount: isNum_(s.headcount) && s.headcount > 0 ? s.headcount : null,
      note: str_(s.note)
    };
  }).filter(Boolean);
  shifts.sort(function (a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  });
  return {
    client: str_(c.client_name),
    title: str_(c.title),
    place: str_(c.venue),
    prefecture: str_(c.prefecture),
    address: str_(c.address_access),
    work: str_(c.position),
    role: DEFAULT_ROLE,
    conditions: str_(c.conditions),
    genderReq: GENDER_REQ.indexOf(c.gender) >= 0 ? c.gender : '記載なし',
    dress: str_(c.dress),
    belongings: str_(c.belongings),
    meetingTime: str_(c.meeting_time),
    meetingPlace: str_(c.meeting_place),
    contactName: splitContact_(c.contact).name,
    contactPhone: splitContact_(c.contact).phone,
    payBasis: PAY_BASIS.indexOf(c.pay_basis) >= 0 ? c.pay_basis : '記載なし',
    unitPrice: isNum_(c.unit_price) ? c.unit_price : null,
    minHours: isNum_(c.min_hours) ? c.min_hours : null,
    transport: isNum_(c.transport_fee) ? c.transport_fee : null,
    transportNote: str_(c.transport_note),
    mealFee: isNum_(c.meal_fee) ? c.meal_fee : null,
    mealNote: str_(c.meal_note),
    notes: str_(c.notes),
    staffPay: '', // スタッフ向け給与（確認画面で入れる）
    shifts: shifts
  };
}

/** 取引先名の比べ方（全角・半角、空白、大文字・小文字の違いを無視） */
function clientKey_(name) {
  var s = str_(name);
  if (s.normalize) s = s.normalize('NFKC');
  return s.replace(/\s/g, '').toLowerCase();
}

/** 取引先名 → freee の取引先名（通称・正式名称と、全角・半角や空白の違いを無視して比べる）。なければ '' */
function matchPartnerName_(partners, client) {
  var key = clientKey_(client);
  if (!key) return '';
  var hit = partners.filter(function (p) { return clientKey_(p.name) === key || (p.longName && clientKey_(p.longName) === key); })[0];
  return hit ? str_(hit.name) : '';
}

/** その取引先の支払いが、売上計上月の何か月後か */
function paymentMonthsFor_(client, defaultMonths) {
  var key = clientKey_(client);
  for (var name in PAYMENT_TERM_EXCEPTIONS) {
    if (clientKey_(name) === key) return PAYMENT_TERM_EXCEPTIONS[name];
  }
  return isNum_(defaultMonths) ? defaultMonths : DEFAULT_PAYMENT_MONTHS;
}

/** 「時給1,200円」「日給 10000円」→ { unit: '時給', rate: 1200 }（読めなければ null） */
function staffPayTerms_(text) {
  var s = str_(text).replace(/[０-９，]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  var m = /(時給|日給)\D*?([\d,]+)/.exec(s);
  if (!m) return null;
  return { unit: m[1], rate: +m[2].replace(/,/g, '') };
}

/** 休憩時間 → 時間数。数字は時間（12より大きければ分とみなす）、「45分」「1時間30分」「1:00」も読む。空欄は0、読めなければ null */
function breakHours_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  if (Object.prototype.toString.call(v) === '[object Date]') return round2_(v.getHours() + v.getMinutes() / 60);
  if (isNum_(v)) return v > 12 ? round2_(v / 60) : v;
  var s = str_(v).replace(/[０-９：．]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  var m;
  if ((m = /^(\d{1,2}):(\d{2})$/.exec(s))) return round2_(+m[1] + +m[2] / 60);
  if ((m = /^(?:(\d+(?:\.\d+)?)\s*時間)?\s*(?:(\d+)\s*分)?$/.exec(s)) && (m[1] || m[2])) return round2_((+m[1] || 0) + (+m[2] || 0) / 60);
  var n = toNum_(s);
  return n === null ? null : (n > 12 ? round2_(n / 60) : n);
}

/**
 * 「案件応募」の1行 → 実働時間と給与額（わからなければ ''）。
 * 実働時間 = 勤務終了 − 勤務開始 − 休憩（日をまたぐ勤務も）。給与額は時給なら 単価 × 実働時間（1円未満四捨五入）、日給なら 単価。
 * 欠勤の人は0円。
 */
function workPay_(app) {
  var span = spanHours_(app.actualStart, app.actualEnd);
  var brk = breakHours_(app.actualBreak);
  var hours = span !== null && brk !== null ? round2_(Math.max(0, span - brk)) : '';
  var rate = toNum_(app.payRate);
  var pay = '';
  if (ABSENT_STATUSES.indexOf(app.workStatus) >= 0) pay = 0;
  else if (rate !== null && app.payUnit === '時給' && hours !== '') pay = Math.round(rate * hours);
  else if (rate !== null && app.payUnit === '日給') pay = rate;
  return { actualHours: hours, pay: pay };
}

function unitOf_(payBasis) {
  if (payBasis === '拘束時間' || payBasis === '実働時間') return '時給';
  if (payBasis === '日給') return '日給';
  return '';
}

function yen_(n) {
  return '¥' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 1日（1時間帯）分の金額。
 * 売上 = 単価 ×（時給なら請求する時間）× 人数、総支払額 = 売上 ＋（交通費＋食費）× 人数。
 * 時給の「請求する時間」は、依頼文の支払い方（payBasis）が拘束時間なら勤務時間、実働時間なら実働時間。
 * 人数や単価がわからないときは空欄にする（推測しない）。
 */
function jobAmounts_(row, minHours, payBasis) {
  var span = spanHours_(row.start, row.end);
  var brk = isNum_(row.breakHours) ? row.breakHours : null;
  var work = span !== null && brk !== null ? round2_(Math.max(0, span - brk)) : null;
  var hours = null;
  if (payBasis === '拘束時間') hours = span;
  else if (payBasis === '実働時間') hours = work;
  else if (payBasis === '日給') hours = 1;
  if (hours !== null && isNum_(minHours) && payBasis !== '日給') hours = Math.max(hours, minHours);

  var n = isNum_(row.headcount) ? row.headcount : null;
  var sales = isNum_(row.unitPrice) && hours !== null && n !== null ? Math.round(row.unitPrice * hours * n) : null;
  var extras = (isNum_(row.transport) ? row.transport : 0) + (isNum_(row.meal) ? row.meal : 0);
  var total = sales !== null ? sales + extras * n : null;
  return { workHours: work, sales: sales, total: total };
}

/**
 * 確認画面で直した案件 → シートの行（1日・1時間帯ごと）。
 * @param {Array} cases normalizeCase_ の形（画面で直したもの）
 * @param {{client: string, importId: string, paymentMonthsAfter: number, caseIdPrefix: string, firstCaseNo: number}} opts
 *   caseIdPrefix（「2026-10」）と firstCaseNo があれば、案件IDは「2026-10-0001」、枠IDは「2026-10-0001-01」
 */
function jobRows_(cases, opts) {
  var rows = [];
  var caseNo = 0;
  cases.forEach(function (c, ci) {
    if (!(c.shifts || []).length) return; // 日程のない案件は追加しない（通し番号も使わない）
    var caseId = opts.caseIdPrefix ? caseIdOf_(opts.caseIdPrefix, opts.firstCaseNo + (caseNo++)) : opts.importId + '-' + (ci + 1);
    (c.shifts || []).forEach(function (s, si) {
      var d = parseYmd_(s.date);
      var row = {
        client: str_(c.client) || str_(opts.client),
        title: c.title,
        place: c.place,
        work: c.work,
        role: ROLES.indexOf(str_(c.role).toUpperCase()) >= 0 ? str_(c.role).toUpperCase() : DEFAULT_ROLE,
        date: d ? ymd_(d) : str_(s.date),
        start: normalizeTime_(s.start),
        end: normalizeTime_(s.end),
        weekday: d ? WEEKDAYS_JA[d.getDay()] + (s.holiday ? '祝' : '') : '',
        breakHours: toNum_(s.breakHours),
        dress: str_(c.dress),
        belongings: str_(c.belongings),
        unit: unitOf_(c.payBasis),
        unitPrice: toNum_(c.unitPrice),
        transport: toNum_(c.transport),
        meal: toNum_(c.mealFee) !== null ? toNum_(c.mealFee) : str_(c.mealNote),
        invoice: INVOICE_OPTIONS[0],
        salesMonth: d ? d.getFullYear() + '/' + pad2_(d.getMonth() + 1) : '',
        headcount: toNum_(s.headcount),
        conditions: c.conditions,
        meetingTime: c.meetingTime,
        meetingPlace: c.meetingPlace,
        address: c.address,
        contactName: str_(c.contactName),
        contactPhone: str_(c.contactPhone),
        notes: [c.notes, s.note, isNum_(toNum_(c.minHours)) ? toNum_(c.minHours) + '時間保証' : '',
          c.transportNote ? '交通費：' + c.transportNote : ''].filter(Boolean).join('／'),
        staffPay: str_(c.staffPay),
        staffTransport: STAFF_TRANSPORT,
        recruit: RECRUIT.OPEN,
        applied: 0,
        confirmed: 0,
        prefecture: c.prefecture,
        genderReq: c.genderReq,
        caseId: caseId,
        slotId: opts.caseIdPrefix ? slotIdOf_(caseId, si + 1) : caseId + '-' + (si + 1),
        importId: opts.importId
      };
      var a = jobAmounts_(row, toNum_(c.minHours), c.payBasis);
      row.workHours = a.workHours;
      row.sales = a.sales;
      row.total = a.total;
      row.paymentMonth = addMonths_(row.salesMonth, paymentMonthsFor_(row.client, opts.paymentMonthsAfter));
      Object.keys(row).forEach(function (k) { if (row[k] === null) row[k] = ''; });
      rows.push(row);
    });
  });
  return rows;
}

// ---- LINE 配信 ----

/** 「10/8(木) 8:30〜15:30」 */
function slotLabel_(row) {
  var d = parseYmd_(row.date);
  var date = d ? (d.getMonth() + 1) + '/' + d.getDate() + '(' + (row.weekday || WEEKDAYS_JA[d.getDay()]) + ')' : str_(row.date);
  var t = function (x) { return normalizeTime_(x).replace(/^0/, ''); };
  var time = row.start ? t(row.start) + '〜' + (row.end ? t(row.end) : '') : '';
  return (date + ' ' + time).trim();
}

/** 都道府県 → 登録フォームの希望エリア（大阪府 → 大阪） */
function areaOf_(prefecture) {
  return str_(prefecture).replace(/[都府県]$/, '');
}

/**
 * 案件を受け取るスタッフを選ぶ。
 * @param {Array} staff シート「スタッフ登録」の行（rowToRecord_ の形）
 * @param {{statuses: string[], areas: string[], gender: string, weekdays: string[]}} f
 *   areas：案件のエリア（空なら絞らない）／gender：'女性のみ' などの指定（なければ絞らない）／
 *   weekdays：案件の曜日（空なら絞らない）
 */
function jobTargets_(staff, f) {
  return staff.filter(function (r) {
    if (!r.userId || r.blocked) return false;
    if (f.statuses.indexOf(r.status) < 0) return false;
    if (f.areas && f.areas.length) {
      var mine = str_(r.areas).split(LIST_SEPARATOR);
      if (!f.areas.some(function (a) { return mine.indexOf(a) >= 0; })) return false;
    }
    if (f.gender === '女性のみ' && r.gender !== '女性') return false;
    if (f.gender === '男性のみ' && r.gender !== '男性') return false;
    if (f.weekdays && f.weekdays.length) {
      var days = str_(r.weekdays).split(LIST_SEPARATOR);
      if (!f.weekdays.some(function (w) { return days.indexOf(w) >= 0; })) return false;
    }
    return true;
  });
}

/**
 * 1案件の送信先の条件。
 * @param {Array} rows 同じ案件IDの行
 * @param {{statuses: string[], matchArea: boolean, matchGender: boolean, matchWeekday: boolean}} req 画面で選んだ条件
 */
function jobFilter_(rows, req) {
  var weekdays = [];
  rows.forEach(function (r) {
    // 「月祝」は「月」と「祝」のどちらかが勤務できる曜日に入っていれば対象
    String(r.weekday || '').split('').forEach(function (c) { if (weekdays.indexOf(c) < 0) weekdays.push(c); });
  });
  var area = areaOf_(rows[0].prefecture);
  return {
    statuses: req.statuses && req.statuses.length ? req.statuses : [STATUS.ACTIVE],
    areas: req.matchArea && area ? [area] : [],
    gender: req.matchGender ? rows[0].genderReq : '',
    weekdays: req.matchWeekday ? weekdays : []
  };
}

/**
 * 送信先を「受け取る案件の組み合わせ」ごとにまとめる。
 * 例：大阪の案件と京都の案件を選んだら、大阪だけ希望の人・京都だけ・両方の人で別々に送る。
 * @param {Array} groups 案件IDごとの行の配列
 * @return {Array<{groups: Array, userIds: string[]}>}
 */
function jobBuckets_(staff, groups, req) {
  var matched = {}; // userId → この人が受け取る案件（groups の番号）
  var order = [];
  groups.forEach(function (rows, gi) {
    jobTargets_(staff, jobFilter_(rows, req)).forEach(function (r) {
      if (!matched[r.userId]) { matched[r.userId] = []; order.push(r.userId); }
      matched[r.userId].push(gi);
    });
  });
  var buckets = {};
  var keys = [];
  order.forEach(function (id) {
    var key = matched[id].join(',');
    if (!buckets[key]) {
      buckets[key] = { groups: matched[id].map(function (gi) { return groups[gi]; }), userIds: [] };
      keys.push(key);
    }
    buckets[key].userIds.push(id);
  });
  return keys.map(function (k) { return buckets[k]; });
}

/**
 * 送信先を、画面で選んだ人だけに絞る（条件に合わない人は、選ばれていても送らない）。
 * @param {Array<{groups: Array, userIds: string[]}>} buckets jobBuckets_ の結果
 * @param {string[]=} userIds 送る人。省略したら全員に送る
 */
function restrictBuckets_(buckets, userIds) {
  if (!userIds) return buckets;
  var chosen = {};
  userIds.forEach(function (id) { chosen[id] = true; });
  return buckets.map(function (b) {
    return { groups: b.groups, userIds: b.userIds.filter(function (id) { return chosen[id]; }) };
  }).filter(function (b) { return b.userIds.length; });
}

function infoLine_(label, text) {
  return {
    type: 'box', layout: 'baseline', spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'xs', color: '#888888', flex: 2 },
      { type: 'text', text: text, size: 'xs', wrap: true, flex: 7 }
    ]
  };
}

/**
 * 1案件ぶんのバブル（応募ボタンは日程・時間帯ごと）。日程が多いときは複数のバブルに分ける。
 * @param {Array} rows 同じ案件IDの行（募集中のものだけ）
 */
function jobBubbles_(rows) {
  var first = rows[0];
  var meal = isNum_(toNum_(first.meal)) ? (toNum_(first.meal) > 0 ? yen_(toNum_(first.meal)) + ' 支給' : '') : str_(first.meal);
  var info = [];
  var where = [first.place, first.address].filter(Boolean).join('\n');
  if (where) info.push(infoLine_('場所', where));
  if (first.work) info.push(infoLine_('仕事', first.work));
  if (first.genderReq === '女性のみ') info.push(infoLine_('募集', '女性スタッフ'));
  if (first.genderReq === '男性のみ') info.push(infoLine_('募集', '男性スタッフ'));
  if (first.meetingTime || first.meetingPlace) info.push(infoLine_('集合', [first.meetingTime, first.meetingPlace].filter(Boolean).join('\n')));
  if (first.dress) info.push(infoLine_('服装', first.dress));
  if (first.belongings) info.push(infoLine_('持ち物', first.belongings));
  if (meal && meal !== 'なし') info.push(infoLine_('食事', meal));

  var bubbles = [];
  for (var i = 0; i < rows.length; i += SLOTS_PER_BUBBLE) {
    var chunk = rows.slice(i, i + SLOTS_PER_BUBBLE);
    var buttons = chunk.map(function (r) {
      return {
        type: 'button', style: 'primary', color: BRAND_BROWN, height: 'sm',
        action: { type: 'postback', label: slotLabel_(r).slice(0, 40), data: 'job=apply&s=' + encodeURIComponent(r.slotId), displayText: slotLabel_(r) + ' に応募します' }
      };
    });
    bubbles.push({
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: 'お仕事のご案内', size: 'xs', color: BRAND_BROWN, weight: 'bold' },
          { type: 'text', text: (first.title || 'お仕事') + (i > 0 ? '（つづき）' : ''), weight: 'bold', size: 'md', wrap: true },
          // 給与と交通費は目立つように、タイトルのすぐ下に出す
          { type: 'text', text: '💴 ' + (str_(first.staffPay) || '給与はお問い合わせください') + '\n🚃 交通費' + STAFF_TRANSPORT,
            weight: 'bold', size: 'sm', color: BRAND_BROWN, wrap: true },
          // LINE は中身が空の box や text を受け付けないので、項目がなければ入れない
          info.length ? { type: 'box', layout: 'vertical', spacing: 'xs', contents: info } : null,
          { type: 'text', text: '働ける日時のボタンを押すと応募できます（複数可）。', size: 'xxs', color: '#888888', wrap: true }
        ].filter(Boolean)
      },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons }
    });
  }
  return bubbles;
}

/** 選んだ案件（案件IDごとの行）→ 送信するメッセージ（カルーセル。最大5通） */
function jobMessages_(groups) {
  var bubbles = [];
  groups.forEach(function (rows) { bubbles = bubbles.concat(jobBubbles_(rows)); });
  if (!bubbles.length) return [];
  if (bubbles.length > MAX_BUBBLES * MAX_MESSAGES) throw new Error('一度に送れる案件が多すぎます。案件を分けて配信してください');
  var messages = [];
  for (var i = 0; i < bubbles.length; i += MAX_BUBBLES) {
    var part = bubbles.slice(i, i + MAX_BUBBLES);
    messages.push({
      type: 'flex',
      altText: 'お仕事のご案内：' + groups.map(function (g) { return g[0].title; }).join('、').slice(0, 300),
      contents: part.length === 1 ? part[0] : { type: 'carousel', contents: part }
    });
  }
  return messages;
}

/**
 * 応募ボタンが押されたときに、応募を受け付けてよいか。受け付けられない理由（なければ ''）。
 * @param {Object|null} slot 「案件一覧」の行
 * @param {Object|null} staff 「スタッフ登録」の行
 * @param {boolean} already すでに同じ枠に応募しているか
 */
function applyRejectReason_(slot, staff, already, now) {
  if (!staff) return 'お仕事への応募は、スタッフ登録が済んだ方のみ受け付けています。';
  if (!slot) return 'この募集は見つかりませんでした。募集が終了した可能性があります。';
  if (slot.recruit !== RECRUIT.OPEN) return slotLabel_(slot) + ' の「' + slot.title + '」は、募集を締め切りました。';
  var d = parseYmd_(slot.date);
  if (d) {
    var startMin = minutesOf_(slot.start);
    var begins = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, startMin === null ? 0 : startMin);
    if (now >= begins) return slotLabel_(slot) + ' の「' + slot.title + '」は、募集を締め切りました。';
  }
  if (already) return slotLabel_(slot) + ' の「' + slot.title + '」には、すでに応募いただいています。結果をお待ちください。';
  return '';
}

function applyAcceptedText_(slot) {
  return '応募を受け付けました。\n\n' + slot.title + '\n📅 ' + slotLabel_(slot) + '\n📍 ' + slot.place +
    '\n\n担当者が確認して、このトークで結果をお知らせします。';
}

/** 「08:30」「15:30」→「8:30〜15:30」 */
function appTimeText_(app) {
  var s = normalizeTime_(app.start), e = normalizeTime_(app.end);
  if (!s) return '';
  return shortTime_(s) + '〜' + (e ? shortTime_(e) : '');
}

/** 「確定」にしたときの連絡（集合場所などの詳細は、あとで担当者が「詳細連絡を送る」から送る） */
function applyConfirmedText_(app) {
  return app.name + ' さん\n\nお仕事が確定しました！よろしくお願いいたします。\n\n' +
    '■ ' + app.title + '\n📅 ' + app.date + ' ' + appTimeText_(app) + '\n\n' +
    '集合場所・持ち物などの詳細は、後日このトークでお送りします。\n' +
    'ご都合が悪くなった場合は、すぐにこのトークでお知らせください。';
}

function applyDeclinedText_(app) {
  return app.name + ' さん\n\n「' + app.title + '」（' + app.date + ' ' + appTimeText_(app) + '）にご応募いただき、ありがとうございました。\n\n' +
    '今回は定員に達したため、ご案内できませんでした。またのご応募をお待ちしています。';
}

// ---- 詳細連絡（確定したスタッフに担当者が送る） ----

/** 詳細連絡に必ず載せる緊急連絡先（遅刻・体調不良など、当日に困ったときの連絡先） */
var DETAIL_EMERGENCY_CONTACT = '前田 090-7873-8978';

/** 「服装：…\n持ち物：…」（服装　持ち物 の列）→ 服装と持ち物に分ける */
function splitDress_(text) {
  var dress = [], belongings = [];
  var target = dress;
  String(text || '').split('\n').forEach(function (line) {
    var m = /^\s*(服装|持ち物)[：:]\s*(.*)$/.exec(line);
    if (m) {
      target = m[1] === '服装' ? dress : belongings;
      if (m[2]) target.push(m[2]);
    } else if (line.trim()) {
      target.push(line.trim());
    }
  });
  return { dress: dress.join('\n'), belongings: belongings.join('\n') };
}

function shortTime_(t) {
  return normalizeTime_(t).replace(/^0/, '');
}

/** 「10月8日(木)」 */
function jpDate_(row) {
  var d = parseYmd_(row.date);
  if (!d) return str_(row.date);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日(' + (row.weekday || WEEKDAYS_JA[d.getDay()]) + ')';
}

/** 詳細連絡の入力欄の初期値（「案件一覧」の行から） */
function detailDefaults_(row) {
  // 以前の形（服装の列に「服装：…／持ち物：…」）にも対応する
  var d = str_(row.belongings) ? { dress: str_(row.dress), belongings: str_(row.belongings) } : splitDress_(row.dress);
  var meal = toNum_(row.meal);
  var pay = str_(row.staffPay);
  var contact = str_(row.contactPhone) ? { name: str_(row.contactName), phone: str_(row.contactPhone) } : splitContact_(row.contactName);
  var place = str_(row.address);
  if (row.place && place.indexOf(row.place) < 0) place = (place ? place + '　' : '') + row.place;
  return {
    title: str_(row.title),
    work: str_(row.work),
    place: place,
    timeNote: /前後/.test(str_(row.notes)) ? '多少前後する可能性があります。' : '',
    meetingPlace: str_(row.meetingPlace),
    meetingTime: str_(row.meetingTime),
    contactName: contact.name,
    contactPhone: contact.phone,
    dress: d.dress,
    pay: pay && !/交通費/.test(pay) ? pay + '＋交通費' : pay,
    meal: meal !== null ? (meal > 0 ? meal + '円支給' : '') : str_(row.meal),
    belongings: d.belongings,
    images: str_(row.detailImages).split(',').map(str_).filter(Boolean)
  };
}

/**
 * スタッフに送る詳細連絡の文面。
 * @param {Object} f detailDefaults_ の形（画面で直したもの）
 * @param {Array} slots このスタッフが確定した日程（「案件一覧」の行）
 */
function detailText_(f, slots) {
  slots = slots.slice().sort(function (a, b) { return str_(a.date) < str_(b.date) ? -1 : str_(a.date) > str_(b.date) ? 1 : 0; });
  var times = slots.map(function (r) { return r.start ? shortTime_(r.start) + '~' + shortTime_(r.end) : ''; });
  var sameTime = times.every(function (t) { return t === times[0]; });
  var time = sameTime ? times[0] : slots.map(function (r, i) { return jpDate_(r) + ' ' + times[i]; }).join('\n');
  if (time && f.timeNote) time += '\n※' + f.timeNote.replace(/^※/, '');

  var parts = [
    str_(f.title) + 'の詳細です。\n\n内容をよく読んで交通費と出発時間をお調べください。'
  ];
  var section = function (label, value) { if (str_(value)) parts.push('■' + label + '\n' + str_(value)); };
  section('タイトル', f.title);
  section('業務内容', f.work);
  section('日程', slots.map(jpDate_).join('・'));
  section('場所', f.place);
  section('時間', time);
  section('集合場所', f.meetingPlace);
  section('集合時間', f.meetingTime);
  var name = str_(f.contactName), phone = str_(f.contactPhone);
  if (name) parts.push('■集合担当：' + name + (phone ? '\n' + phone : ''));
  else if (phone) parts.push('■集合担当\n' + phone);
  section('緊急連絡先', DETAIL_EMERGENCY_CONTACT);
  section('服装', f.dress);
  section('ギャランティ', f.pay);
  section('昼食', f.meal);
  section('持ち物', f.belongings);
  return parts.join('\n\n');
}

/** 「前田 090-7873-8978」→ 名前と電話番号に分ける */
function splitContact_(text) {
  var s = str_(text);
  var m = /(0\d{1,4}[-‐－ー−()（）\s]?\d{1,4}[-‐－ー−()（）\s]?\d{3,4})/.exec(toHalfWidth_(s));
  if (!m) return { name: s.replace(/\s+/g, ' '), phone: '' };
  var phone = m[1].replace(/[‐－ー−]/g, '-');
  var name = toHalfWidth_(s).replace(m[1], '').replace(/[：:（）()、,／/]|TEL|電話|携帯/gi, ' ').replace(/\s+/g, ' ').trim();
  return { name: name, phone: phone.trim() };
}

/** 集合担当を「案件一覧」に保存する形（1つの列） */
function joinContact_(name, phone) {
  return [str_(name), str_(phone)].filter(Boolean).join(' ');
}

/** 詳細連絡に添付できる画像の数（本文・画像・返信のお願いで、LINE の1回の上限5通に収める） */
var DETAIL_MAX_IMAGES = 3;

/** Google ドライブの画像を LINE で表示できる URL（「リンクを知っている全員」が見られる設定が必要） */
function driveImageUrl_(id) {
  return 'https://lh3.googleusercontent.com/d/' + encodeURIComponent(id);
}

/** 詳細連絡で送るメッセージ：本文 → 画像（最大3枚）→ 交通費・出発時間の返信のお願い */
function detailMessages_(f, slots) {
  var images = (f.images || []).slice(0, DETAIL_MAX_IMAGES).map(function (id) {
    return { type: 'image', originalContentUrl: driveImageUrl_(id), previewImageUrl: driveImageUrl_(id) };
  });
  return [{ type: 'text', text: detailText_(f, slots) }].concat(images, [{ type: 'text', text: travelRequestText_(str_(f.title)) }]);
}

/** 詳細連絡のあとに送る、交通費と出発時間の返信のお願い */
function travelRequestText_(title) {
  return '【ご返信のお願い】\n' +
    '「' + title + '」の交通費（往復）と出発時間を調べて、このトークに返信してください。\n\n' +
    '（返信の例）\n交通費：1,060円\n出発時間：7:30\n\n' +
    '※交通費は、ご自宅の最寄り駅から現場の最寄り駅までの往復の金額です\n' +
    '※出発時間は、ご自宅を出発する時間です';
}

/**
 * スタッフの返信から交通費と出発時間を読む。読めなかったものは null / ''。
 * 「交通費：1,060円 出発時間：7:30」「1060円、7時半出発」などに対応。
 */
function parseTravelReply_(text) {
  var t = toHalfWidth_(String(text || '')).replace(/，/g, ',');
  var fare = null;
  var m = /交通費[^\d]{0,12}?([\d,]+)/.exec(t) || /([\d,]+)\s*円/.exec(t) || /[¥￥]\s*([\d,]+)/.exec(t);
  if (m) fare = toNum_(m[1]);
  var depart = '';
  var d = /出発[^\d]{0,8}?(\d{1,2})\s*(?:[:：]\s*(\d{2})|時\s*(半|\d{1,2})?)/.exec(t) ||
    /(\d{1,2})\s*(?:[:：]\s*(\d{2})|時\s*(半|\d{1,2})?)[^\d]{0,4}出発/.exec(t);
  if (!d && fare !== null) d = /(\d{1,2})\s*(?:[:：]\s*(\d{2})|時\s*(半|\d{1,2})?)/.exec(t.replace(m[0], ''));
  if (d) {
    var h = +d[1], mi = d[2] !== undefined ? +d[2] : d[3] === '半' ? 30 : d[3] ? +d[3] : 0;
    if (h <= 23 && mi <= 59) depart = pad2_(h) + ':' + pad2_(mi);
  }
  return { fare: fare, departure: depart };
}

/**
 * 返信を待っている応募（確定・勤務ステータスが詳細送付済か出発時間確認済・交通費か出発時間がまだ・日程が今日以降）を、
 * 案件ごとにまとめて日程の早い順に返す。
 * @param {Array} apps 「案件応募」の行（rowToRecord_ の形。_row にシートの行番号）
 */
function travelPending_(apps, userId, now) {
  var today = ymd_(now);
  var byCase = {};
  var order = [];
  apps.forEach(function (a) {
    if (a.userId !== userId || !a.detailSentAt) return;
    if (a.status !== APPLY_STATUS.CONFIRMED) return;
    if (a.workStatus !== WORK_STATUS.DETAIL_SENT && a.workStatus !== WORK_STATUS.DEPART_TIME_OK) return;
    if (str_(a.fare) !== '' && str_(a.departure) !== '') return;
    var d = parseYmd_(a.date);
    if (d && ymd_(d) < today) return;
    if (!byCase[a.caseId]) { byCase[a.caseId] = []; order.push(a.caseId); }
    byCase[a.caseId].push(a);
  });
  var key = function (a) { return ymd_(parseYmd_(a.date) || now); };
  var groups = order.map(function (id) {
    return byCase[id].sort(function (a, b) { return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0; });
  });
  var first = function (g) { return key(g[0]); };
  groups.sort(function (a, b) { return first(a) < first(b) ? -1 : first(a) > first(b) ? 1 : 0; });
  return groups;
}

/** 返信を受け付けたときの返事 */
function travelReplyText_(apps, fare, departure, rest) {
  var a = apps[0];
  var dates = apps.map(function (x) { return jpDate_(x); }).join('・');
  var lines = [];
  if (fare !== null && departure) {
    lines.push('「' + a.title + '」（' + dates + '）の\n交通費（往復）：' + yen_(fare) + '\n出発時間：' + shortTime_(departure) +
      '\nを受け付けました。ありがとうございます。');
    if (rest) lines.push('続けて「' + rest[0].title + '」（' + rest.map(jpDate_).join('・') + '）の交通費と出発時間も送ってください。');
  } else if (fare !== null) {
    lines.push('「' + a.title + '」の交通費（往復）' + yen_(fare) + ' を受け付けました。\n出発時間も送ってください（例：出発時間：7:30）。');
  } else {
    lines.push('「' + a.title + '」の出発時間 ' + shortTime_(departure) + ' を受け付けました。\n交通費（往復）も送ってください（例：交通費：1,060円）。');
  }
  return lines.join('\n\n');
}

// ---- 出発確認（出発時間になったら「予定通り出発しましたか？」を送る） ----

/**
 * 出発する日時（日程＋出発時間）。出発時間が開始時刻より遅ければ前日の出発とみなす（深夜・早朝の勤務）。
 */
function departureAt_(app) {
  var d = parseYmd_(app.date);
  var dep = minutesOf_(app.departure);
  if (!d || dep === null) return null;
  var at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, dep);
  var start = minutesOf_(app.start);
  if (start !== null && dep > start) at = new Date(at.getTime() - 24 * 3600000);
  return at;
}

/**
 * 今すること：'check'（出発確認を送る）／'alert'（返信がないので担当者にメール）／''
 */
function departureAction_(app, now) {
  if (app.status !== APPLY_STATUS.CONFIRMED) return '';
  if (app.workStatus === WORK_STATUS.DEPART_TIME_OK && !app.departCheckSentAt) {
    var at = departureAt_(app);
    if (at && now >= at && now < new Date(at.getTime() + DEPART_CHECK_WINDOW_MINUTES * 60000)) return 'check';
    return '';
  }
  if (app.workStatus === WORK_STATUS.DEPART_CHECKING && !app.departAnswer && !app.departAlertAt) {
    var sent = parseTimestamp_(app.departCheckSentAt);
    if (sent && now >= new Date(sent.getTime() + DEPART_ALERT_MINUTES * 60000)) return 'alert';
  }
  return '';
}

/** 出発確認のメッセージ（「はい」「いいえ」のボタン付き） */
function departureCheckMessage_(app) {
  var text = 'おはようございます。出発時間になりました。\n\n予定通り出発しましたでしょうか？';
  var data = function (ans) { return 'dep=' + ans + '&s=' + encodeURIComponent(app.slotId); };
  return {
    type: 'template',
    altText: text,
    template: {
      type: 'confirm',
      text: text,
      actions: [
        { type: 'postback', label: 'はい', data: data('yes'), displayText: 'はい' },
        { type: 'postback', label: 'いいえ', data: data('no'), displayText: 'いいえ' }
      ]
    }
  };
}

function departureYesText_() {
  return 'ご連絡ありがとうございます。\nお気をつけてお越しください。本日もよろしくお願いいたします。';
}

function departureNoText_() {
  return 'ご連絡ありがとうございます。\n担当者から連絡しますので、このトークで今の状況（到着できそうな時刻など）を教えてください。';
}

/** 担当者へのメール（返信がない・「いいえ」と答えた） */
function departureAlertMail_(app, reason, sheetUrl) {
  var subject = '[セブンハーツ] 出発確認：' + app.name + ' さん（' + reason + '）';
  var body = [
    app.name + ' さんの出発確認について、' + reason + '。',
    '',
    '案件：' + app.title,
    '日程：' + app.date + ' ' + appTimeText_(app),
    '出発時間：' + shortTime_(app.departure),
    '電話番号：' + (app.phone || '（未登録）'),
    '',
    '状況を確認して、「案件応募」の勤務ステータスを「出勤」「遅刻」「連絡欠勤」「無断欠勤」などに変えてください。',
    sheetUrl || ''
  ].join('\n');
  return { subject: subject, body: body };
}

/**
 * 「案件応募」の日程・開始時間・終了時間を「案件一覧」に合わせる。変わったところだけ返す。
 * @param {Array} apps 「案件応募」の行（_row 付き）
 * @param {Object} slots 枠ID → 「案件一覧」の行
 */
/**
 * 「案件一覧」で行をコピーして別の日程を作ると、枠IDまで同じになり、別の日程が同じ枠として扱われてしまう。
 * 同じ枠IDの2行目以降に新しい枠IDを付け、その日程・時間の応募も新しい枠IDに付け替える。
 * @param {Array} jobs 「案件一覧」の行（_row 付き）
 * @param {Array} apps 「案件応募」の行（_row 付き）
 * @return {{jobs: Array<{row: number, slotId: string}>, apps: Array<{row: number, slotId: string}>}}
 */
function duplicateSlotFixes_(jobs, apps) {
  var used = {}, first = {}, out = { jobs: [], apps: [] };
  var key = function (r) { var d = parseYmd_(r.date); return (d ? ymd_(d) : str_(r.date)) + ' ' + normalizeTime_(r.start); };
  jobs.forEach(function (j) { if (j.slotId) used[j.slotId] = true; });
  jobs.forEach(function (j) {
    var id = str_(j.slotId);
    if (!id) return;
    if (!first[id]) { first[id] = j; return; }
    var base = str_(j.caseId) || id.replace(/-\d+$/, '');
    var idOf = function (k) { return CASE_ID_RE.test(base) ? slotIdOf_(base, k) : base + '-' + k; };
    var n = 1;
    while (used[idOf(n)]) n++;
    var newId = idOf(n);
    used[newId] = true;
    out.jobs.push({ row: j._row, slotId: newId });
    // 1行目と日程・開始時間が違えば、この日程・時間の応募はこの行のもの
    if (key(j) === key(first[id])) return;
    apps.forEach(function (a) {
      if (a.slotId === id && key(a) === key(j)) out.apps.push({ row: a._row, slotId: newId });
    });
  });
  return out;
}

// ---- 案件ID・枠ID ----
// 案件ID：「2026-10-0001」（登録した年・月と、その月の通し番号4桁）。枠ID：「2026-10-0001-01」（案件IDと日程の番号2桁）

var CASE_ID_RE = /^(\d{4}-\d{2})-(\d{4})$/;

function caseIdOf_(prefix, no) {
  return prefix + '-' + ('000' + no).slice(-4);
}

function slotIdOf_(caseId, no) {
  return caseId + '-' + (no < 10 ? '0' : '') + no;
}

/** その月（「2026-10」）の次の通し番号 */
function nextCaseNo_(caseIds, prefix) {
  var max = 0;
  caseIds.forEach(function (id) {
    var m = CASE_ID_RE.exec(str_(id));
    if (m && m[1] === prefix) max = Math.max(max, +m[2]);
  });
  return max + 1;
}

/** 取込ID（yyMMddHHmmss）や日程 → 「2026-10」 */
function caseIdPrefixOf_(importId, date) {
  var m = /^(\d{2})(\d{2})\d{8}$/.exec(str_(importId));
  if (m) return '20' + m[1] + '-' + m[2];
  var d = parseYmd_(date);
  return d ? d.getFullYear() + '-' + pad2_(d.getMonth() + 1) : '';
}

/**
 * 以前の形式（「261006120000-1」）の案件ID・枠IDを、新しい形式に振り直す。
 * 案件は取り込んだ順に、取り込んだ月ごとの通し番号を付ける。応募の枠ID・案件IDも付け替え、もとの枠IDは「旧枠ID」に残す
 * （すでに送った LINE の応募ボタンなどが、もとの枠IDのままでも使えるように）。
 */
function jobIdMigration_(jobs, apps) {
  var out = { jobs: [], apps: [] };
  var used = jobs.map(function (j) { return j.caseId; });
  var order = [], byCase = {};
  jobs.forEach(function (j) {
    if (!j.caseId || CASE_ID_RE.test(str_(j.caseId))) return;
    if (!byCase[j.caseId]) { byCase[j.caseId] = []; order.push(j.caseId); }
    byCase[j.caseId].push(j);
  });
  var slotMap = {}, caseMap = {};
  order.forEach(function (oldCase) {
    var rows = byCase[oldCase];
    var prefix = caseIdPrefixOf_(rows[0].importId, rows[0].date);
    if (!prefix) return;
    var newCase = caseIdOf_(prefix, nextCaseNo_(used, prefix));
    used.push(newCase);
    caseMap[oldCase] = newCase;
    rows.forEach(function (j, i) {
      var newSlot = slotIdOf_(newCase, i + 1);
      if (j.slotId) slotMap[j.slotId] = newSlot;
      out.jobs.push({ row: j._row, caseId: newCase, slotId: newSlot, oldSlotId: str_(j.slotId) });
    });
  });
  apps.forEach(function (a) {
    if (slotMap[a.slotId] || caseMap[a.caseId]) {
      out.apps.push({ row: a._row, slotId: slotMap[a.slotId] || a.slotId, caseId: caseMap[a.caseId] || a.caseId });
    }
  });
  return out;
}

/** 枠IDごとの応募人数（辞退以外）と確定人数 */
function slotCounts_(apps) {
  var counts = {};
  apps.forEach(function (a) {
    if (!a.slotId || a.status === APPLY_STATUS.CANCELLED) return;
    var c = counts[a.slotId] || (counts[a.slotId] = { applied: 0, confirmed: 0 });
    c.applied++;
    if (a.status === APPLY_STATUS.CONFIRMED) c.confirmed++;
  });
  return counts;
}

/** 「案件一覧」の応募人数・確定人数で、数え直して変わる行だけ返す */
function slotCountChanges_(jobs, apps) {
  var counts = slotCounts_(apps);
  var out = [];
  jobs.forEach(function (j) {
    if (!j.slotId) return;
    var c = counts[j.slotId] || { applied: 0, confirmed: 0 };
    var f = {};
    if (toNum_(j.applied) !== c.applied) f.applied = c.applied;
    if (toNum_(j.confirmed) !== c.confirmed) f.confirmed = c.confirmed;
    if (Object.keys(f).length) out.push({ row: j._row, fields: f });
  });
  return out;
}

/**
 * シフト提出の画面に出す、その人の確定したお仕事（その月の分。日付・開始時間順）。
 * @param {Array} apps 「案件応募」の行
 * @param {Object} slots 枠ID → 「案件一覧」の行（場所・集合などを出すため）
 */
function confirmedJobsInMonth_(apps, slots, userId, year, month) {
  var out = [];
  apps.forEach(function (a) {
    if (a.userId !== userId || a.status !== APPLY_STATUS.CONFIRMED) return;
    if (ABSENT_STATUSES.indexOf(a.workStatus) >= 0) return;
    var d = parseYmd_(a.date);
    if (!d || d.getFullYear() !== year || d.getMonth() + 1 !== month) return;
    var s = slots[a.slotId] || {};
    out.push({
      day: d.getDate(),
      label: slotLabel_(a),
      title: str_(a.title || s.title),
      place: str_(s.place),
      meeting: [s.meetingTime, s.meetingPlace].map(str_).filter(Boolean).join(' '),
      sort: ymd_(d) + normalizeTime_(a.start)
    });
  });
  out.sort(function (x, y) { return x.sort < y.sort ? -1 : x.sort > y.sort ? 1 : 0; });
  out.forEach(function (j) { delete j.sort; });
  return out;
}

function applyTimeChanges_(apps, slots) {
  var changes = [];
  apps.forEach(function (a) {
    var s = slots[a.slotId];
    if (!s) return;
    var want = { date: str_(s.date), start: normalizeTime_(s.start), end: normalizeTime_(s.end) };
    var have = { date: str_(a.date), start: normalizeTime_(a.start), end: normalizeTime_(a.end) };
    var diff = {};
    Object.keys(want).forEach(function (k) { if (want[k] !== have[k]) diff[k] = want[k]; });
    if (Object.keys(diff).length) changes.push({ row: a._row, fields: diff });
  });
  return changes;
}

// ---- 「案件応募」に手で追加する（ManualApply.html） ----

/** 手で追加する応募 → 追加できない理由（なければ ''）。staff は「スタッフ登録」の行（LINE 未登録の人は null） */
function manualApplyError_(apps, slot, staff, req) {
  if (!slot) return '日程を選んでください（「案件一覧」に見つかりません）';
  if (req.status !== APPLY_STATUS.APPLIED && req.status !== APPLY_STATUS.CONFIRMED) return '状態は「応募」か「確定」を選んでください';
  if (!staff && !str_(req.name)) return 'スタッフを選ぶか、名前を入れてください';
  var name = staff ? fullName_(staff) : str_(req.name);
  var same = function (a) {
    return staff ? a.userId === staff.userId : !a.userId && clientKey_(a.name) === clientKey_(name);
  };
  var dup = apps.filter(function (a) { return a.slotId === slot.slotId && same(a) && a.status !== APPLY_STATUS.CANCELLED; })[0];
  if (dup) return name + ' さんは、この日程（' + str_(dup.date) + ' ' + appTimeText_(dup) + '）にすでに「' + dup.status + '」で入っています';
  if (req.status === APPLY_STATUS.CONFIRMED) {
    var day = function (a) { var d = parseYmd_(a.date); return d ? ymd_(d) : str_(a.date); };
    var other = apps.filter(function (a) { return a.status === APPLY_STATUS.CONFIRMED && same(a) && day(a) === day(slot); })[0];
    if (other) return name + ' さんは ' + confirmConflictMemo_(other);
  }
  return '';
}

/** 手で追加する応募の行 */
function manualApplyRecord_(slot, staff, req, now) {
  var terms = staffPayTerms_(slot.staffPay) || {};
  return {
    appliedAt: now, status: req.status, slotId: slot.slotId, caseId: slot.caseId, title: slot.title,
    date: slot.date, start: slot.start, end: slot.end,
    payUnit: terms.unit || '', payRate: terms.rate || '',
    name: staff ? fullName_(staff) : str_(req.name),
    phone: staff ? staff.phone : str_(req.phone),
    userId: staff ? staff.userId : '',
    // 確定で「連絡しない」を選んだときは、あとで自動で送らないよう記録しておく
    notifiedAt: req.status === APPLY_STATUS.CONFIRMED && !(staff && req.notify) ? '連絡なし（手動で追加）' : '',
    adminMemo: '[' + String(now).slice(5, 16) + '] 手動で追加'
  };
}

// ---- 終了確認（勤務終了予定時間に、勤務時間などの報告をお願いする） ----

/** 終了確認を送ってから返信を受け付ける時間（時間）。これを過ぎた返信は担当者が手で対応する */
var END_REPORT_HOURS = 24;
/** 報告のあと、続けて送られてきたメッセージも報告に足す時間（分）。返事は送らない */
var END_REPORT_APPEND_MINUTES = 30;

/** 勤務終了予定の日時（終了が開始より早ければ翌日） */
function endAt_(app) {
  var d = parseYmd_(app.date);
  var end = minutesOf_(app.end);
  if (!d || end === null) return null;
  var at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, end);
  var start = minutesOf_(app.start);
  if (start !== null && end <= start) at = new Date(at.getTime() + 24 * 3600000);
  return at;
}

/** 終了確認を送るか（確定・欠勤でない・まだ送っていない・終了予定時間から60分以内） */
function endCheckDue_(app, now) {
  if (app.status !== APPLY_STATUS.CONFIRMED || app.endCheckSentAt) return false;
  if (ABSENT_STATUSES.indexOf(app.workStatus) >= 0) return false;
  var at = endAt_(app);
  return !!at && now >= at && now < new Date(at.getTime() + DEPART_CHECK_WINDOW_MINUTES * 60000);
}

function endCheckText_() {
  return 'お疲れ様です。勤務終了予定時間になりました。\n\n' +
    '本日の業務の開始時間、終了時間、休憩時間を返信してください。\n\n' +
    '（返信の例）\n開始 9:00\n終了 18:00\n休憩 1時間';
}

function endThanksText_() {
  return '返信ありがとうございます。本日もご勤務お疲れ様でした。\n\nお気をつけておかえりください';
}

/**
 * スタッフのメッセージを終了報告として受け付けるか。
 * @return {{app: Object, mode: 'report'|'append'}|null}
 *   report：終了確認への最初の返信（お礼を返す）／append：報告のすぐあとに続けて送られたもの（報告に足す。返事はしない）
 */
function endReportTarget_(apps, userId, now) {
  var best = null;
  apps.forEach(function (a) {
    if (a.userId !== userId || a.status !== APPLY_STATUS.CONFIRMED || !a.endCheckSentAt) return;
    var sent = parseTimestamp_(a.endCheckSentAt);
    if (!sent || now - sent > END_REPORT_HOURS * 3600000) return;
    var mode = '';
    if (!a.endReportAt) mode = 'report';
    else {
      var at = parseTimestamp_(a.endReportAt);
      if (at && now - at <= END_REPORT_APPEND_MINUTES * 60000) mode = 'append';
    }
    if (!mode) return;
    // 返信待ちを優先し、同じなら最近送ったもの
    if (!best || (mode === 'report' && best.mode === 'append') ||
        (mode === best.mode && str_(a.endCheckSentAt) > str_(best.app.endCheckSentAt))) {
      best = { app: a, mode: mode };
    }
  });
  return best;
}

// ---- 同じ人が同じ日に二重に確定しないように ----

/**
 * 「確定」にした行のうち、同じ人がすでに同じ日に確定しているものを探す（その行は確定にできない）。
 * 一度に複数の行を確定にしたときは、上の行を優先する。
 * @param {Array} apps 「案件応募」の全行（_row 付き。今回の編集を反映したもの）
 * @param {number[]} editedRows 今回「状態」を変えた行（シートの行番号）
 * @return {Array<{row: number, other: Object}>} 確定にできない行と、先に確定していた行
 */
function confirmConflicts_(apps, editedRows) {
  var edited = {};
  editedRows.forEach(function (r) { edited[r] = true; });
  var day = function (a) { var d = parseYmd_(a.date); return d ? ymd_(d) : str_(a.date); };
  var confirmed = apps.filter(function (a) { return a.status === APPLY_STATUS.CONFIRMED && a.userId; });
  var reverted = {};
  var out = [];
  editedRows.slice().sort(function (a, b) { return a - b; }).forEach(function (row) {
    var app = confirmed.filter(function (a) { return a._row === row; })[0];
    if (!app) return;
    var other = confirmed.filter(function (a) {
      if (a._row === row || reverted[a._row] || a.userId !== app.userId || day(a) !== day(app)) return false;
      // 今回いっしょに確定にした行は、上の行だけを先に確定したものとみなす
      return !edited[a._row] || a._row < row;
    })[0];
    if (other) {
      reverted[row] = true;
      out.push({ row: row, other: other });
    }
  });
  return out;
}

function confirmConflictMemo_(other) {
  return '同じ日（' + other.date + '）に「' + other.title + '」（' + appTimeText_(other) + '）で確定しているため、確定にできませんでした';
}

