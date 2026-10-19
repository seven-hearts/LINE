/**
 * freee会計の請求書（freee請求書 API）を、シート「案件一覧」から作る。
 *
 * - メニュー「freee に請求書を作る」→ 月を選ぶ → 取引先・タイトルごとの内容を確認 → freee に「送付待ち」の請求書を作成
 * - 請求額 = 単価 × 時間（開始〜終了。休憩時間を含む）× 人数。日給は 単価 × 人数
 *   「案件応募」に確定した人がいる枠は、その人たちの実際の勤務開始〜終了時間（未入力の人は予定の時間）と人数で計算する
 * - 交通費・食費は、明細に別の行で入れる（1人あたりの金額 × 人数）
 * - 末締め。支払期日は取引先ごとの決まり（PAYMENT_TERMS）
 * - 作成した行は「請求書」を「発行済」にし、「freee請求書番号」を入れる（二重に作らない）
 *
 * 連携には freee アプリの Client ID / Client Secret（スクリプト プロパティ FREEE_CLIENT_ID・FREEE_CLIENT_SECRET）が必要（README参照）。
 * 前半の関数はシートと freee に触れないので、tests/freee.test.js で確認できる。
 */

var FREEE_AUTH_URL = 'https://accounts.secure.freee.co.jp/public_api/authorize';
var FREEE_TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';
var FREEE_API = 'https://api.freee.co.jp';
/** 認可コードを freee の画面に表示する（コピーして貼り付けてもらう） */
var FREEE_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

var INVOICE_TAX_RATE = 10;
/** 請求書の件名（「2026年10月分 」のあとに付く）。タイトルが空欄の行に使う */
var INVOICE_SUBJECT = 'イベント運営業務';

// ---- 計算（シート・freee に触れない） ----

/** 「2026/10」「2026-10」「2026/10/31」や Date → 「2026/10」（不正なら ''） */
function ymOf_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? '' : v.getFullYear() + '/' + pad2_(v.getMonth() + 1);
  var m = /^(\d{4})[-\/](\d{1,2})/.exec(str_(v));
  return m && +m[2] >= 1 && +m[2] <= 12 ? m[1] + '/' + pad2_(+m[2]) : '';
}

/** 「2026/10」に months か月足した月の末日 → 「2026-12-31」 */
function monthEnd_(ym, months) {
  var m = /^(\d{4})\/(\d{2})$/.exec(ym || '');
  if (!m) return '';
  var d = new Date(+m[1], +m[2] + (months || 0), 0);
  return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate());
}

/** 時給で請求する時間：開始〜終了（休憩時間を含む）。備考に「○時間保証」があれば、それより短くしない */
function invoiceHours_(row, start, end) {
  var h = spanHours_(start === undefined ? row.start : start, end === undefined ? row.end : end);
  if (h === null) return null;
  var m = /(\d+(?:\.\d+)?)\s*時間保証/.exec(str_(row.notes));
  return m ? Math.max(h, +m[1]) : h;
}

/**
 * 実際に働いた人ごとの請求時間。勤務開始・終了時間が入っていない人は予定の時間で計算する。
 * @param {Array} workers [{ name, actualStart, actualEnd }]（確定・欠勤以外）
 * @return {{hours: Array<number>, planned: Array<string>, times: Array<string>}}
 */
function workerHours_(row, workers) {
  var res = { hours: [], planned: [], times: [] };
  workers.forEach(function (w) {
    var actual = spanHours_(w.actualStart, w.actualEnd) !== null;
    var s = actual ? w.actualStart : row.start, e = actual ? w.actualEnd : row.end;
    if (!actual) res.planned.push(w.name || '（名前なし）');
    res.hours.push(invoiceHours_(row, s, e));
    res.times.push(normalizeTime_(s) + '〜' + normalizeTime_(e));
  });
  return res;
}

/** 「10/8(木)」 */
function invoiceDay_(row) {
  var d = parseYmd_(row.date);
  return d ? (d.getMonth() + 1) + '/' + d.getDate() + '(' + WEEKDAYS_JA[d.getDay()] + ')' : str_(row.date);
}

function round3_(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * 1行（1日・1時間帯）→ 請求書の明細。足りない情報があれば problem に理由を入れる（推測しない）。
 * @param {Array=} workers 「案件応募」で確定した人（欠勤を除く）。undefined なら、シートの人数と予定の時間で計算する
 * @return {{lines: Array, problem: string, warnings: Array<string>}}
 */
function invoiceRowLines_(row, workers) {
  var d = parseYmd_(row.date);
  var n = workers ? workers.length : toNum_(row.headcount);
  var warnings = [];
  var sheetN = toNum_(row.headcount);
  if (workers && sheetN !== null && sheetN !== n) {
    warnings.push('案件応募で出勤（確定）の' + n + '名で計算しています（案件一覧の人数は' + sheetN + '名）');
  }
  var price = toNum_(row.unitPrice);
  var missing = [];
  if (!d) missing.push('日程');
  if (n === null) missing.push('人数');
  if (price === null) missing.push('単価');
  if (row.unit !== '時給' && row.unit !== '日給') missing.push('単位（時給・日給）');
  var wh = workers && row.unit === '時給' ? workerHours_(row, workers) : null;
  var hours = row.unit === '時給' && !wh ? invoiceHours_(row) : null;
  if (row.unit === '時給' && (wh ? wh.hours.indexOf(null) >= 0 : hours === null)) missing.push('開始時間・終了時間');
  if (missing.length) return { lines: [], problem: missing.join('・') + 'が入っていません', warnings: warnings };
  if (n <= 0) return { lines: [], problem: '', warnings: warnings }; // 0人の日は請求しない
  if (wh && wh.planned.length) warnings.push('勤務開始・終了時間が未入力のため予定の時間で計算：' + wh.planned.join('、'));

  var day = invoiceDay_(row);
  var date = d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate());
  var title = str_(row.title) + (row.role && row.role !== DEFAULT_ROLE ? '（' + row.role + '）' : '');
  var lines = [];
  if (wh) {
    var total = wh.hours.reduce(function (a, b) { return a + b; }, 0);
    var same = wh.hours.every(function (h, i) { return h === wh.hours[0] && wh.times[i] === wh.times[0]; });
    lines.push({
      description: day + ' ' + title + (same ? ' ' + wh.times[0] + '（' + wh.hours[0] + '時間×' + n + '名）' : '（' + n + '名・合計' + round3_(total) + '時間）'),
      sales_date: date, quantity: round3_(total), unit: '時間', unit_price: price
    });
  } else if (row.unit === '時給') {
    lines.push({
      description: day + ' ' + title + ' ' + normalizeTime_(row.start) + '〜' + normalizeTime_(row.end) + '（' + hours + '時間×' + n + '名）',
      sales_date: date, quantity: round3_(hours * n), unit: '時間', unit_price: price
    });
  } else {
    lines.push({ description: day + ' ' + title, sales_date: date, quantity: n, unit: '名', unit_price: price });
  }
  var transport = toNum_(row.transport);
  if (transport) lines.push({ description: day + ' 交通費（' + n + '名）', sales_date: date, quantity: n, unit: '名', unit_price: transport });
  var meal = toNum_(row.meal);
  if (meal) lines.push({ description: day + ' 食費（' + n + '名）', sales_date: date, quantity: n, unit: '名', unit_price: meal });
  return { lines: lines, problem: '', warnings: warnings };
}

function lineAmount_(l) {
  return Math.round(l.quantity * l.unit_price);
}

/**
 * その月に請求する行を、取引先・タイトルごとの請求書にまとめる（件名は「2026年10月分 タイトル」）。
 * @param {Array} rows 「案件一覧」の行（_row にシートの行番号）
 * @param {string} ym 「2026/10」（売上計上月）
 * @param {Object} workers 枠ID → 実際に働いた人の一覧（「案件応募」で確定・欠勤以外。確定した人がいない枠は入れない）
 */
function buildInvoices_(rows, ym, workers, defaultMonths) {
  var byKey = {};
  var order = [];
  rows.forEach(function (r) {
    if (ymOf_(r.salesMonth) !== ym) return;
    if (str_(r.invoice) && r.invoice !== INVOICE_OPTIONS[0]) return; // 発行済・入金済
    if (str_(r.freeeInvoice)) return;
    var client = str_(r.client) || '（取引先名なし）';
    var title = str_(r.title);
    var key = clientKey_(client) + '\n' + clientKey_(title);
    if (!byKey[key]) {
      byKey[key] = { key: key, client: client, title: title, rows: [], lines: [], problems: [], warnings: [] };
      order.push(key);
    }
    var inv = byKey[key];
    var res = invoiceRowLines_(r, workers && r.slotId ? workers[r.slotId] : undefined);
    var where = (r._row ? r._row + '行目 ' : '') + invoiceDay_(r) + ' ' + str_(r.title);
    if (res.problem) inv.problems.push(where + '：' + res.problem);
    if (!str_(r.client)) inv.problems.push(where + '：取引先名が入っていません');
    inv.rows.push(r._row);
    inv.lines = inv.lines.concat(res.lines);
    res.warnings.forEach(function (w) { inv.warnings.push(where + '：' + w); });
  });
  return order.map(function (key) {
    var inv = byKey[key];
    inv.lines.sort(function (a, b) { return a.sales_date < b.sales_date ? -1 : a.sales_date > b.sales_date ? 1 : 0; });
    var subtotal = inv.lines.reduce(function (s, l) { return s + lineAmount_(l); }, 0);
    var tax = Math.floor(subtotal * INVOICE_TAX_RATE / 100);
    inv.subtotal = subtotal;
    inv.tax = tax;
    inv.total = subtotal + tax;
    inv.billingDate = monthEnd_(ym, 0);
    inv.paymentDate = monthEnd_(ym, paymentMonthsFor_(inv.client, defaultMonths));
    inv.subject = ym.replace(/^(\d{4})\/0?(\d+)$/, '$1年$2月分 ') + (inv.title || INVOICE_SUBJECT);
    return inv;
  });
}

/** freee に送る請求書（税抜・外税、端数切り捨て、敬称「御中」、振込） */
function invoiceRequest_(inv, companyId, partnerId) {
  return {
    company_id: companyId,
    partner_id: partnerId,
    partner_title: '御中',
    billing_date: inv.billingDate,
    payment_date: inv.paymentDate,
    payment_type: 'transfer',
    subject: inv.subject,
    tax_entry_method: 'out',
    tax_fraction: 'omit',
    line_amount_fraction: 'omit',
    withholding_tax_entry_method: 'out',
    lines: inv.lines.map(function (l) {
      return {
        type: 'item', description: l.description, sales_date: l.sales_date,
        quantity: l.quantity, unit: l.unit, unit_price: String(l.unit_price), tax_rate: INVOICE_TAX_RATE
      };
    })
  };
}

/** freee の取引先一覧から、名前が同じものを探す（見つからない・複数あるときはエラー） */
function findPartner_(partners, client) {
  var key = clientKey_(client);
  var hits = partners.filter(function (p) {
    return clientKey_(p.name) === key || (p.long_name && clientKey_(p.long_name) === key);
  });
  if (!hits.length) throw new Error('freee に取引先「' + client + '」が見つかりません。シートの取引先名を freee の取引先名と同じ書き方にしてください');
  if (hits.length > 1) throw new Error('freee に「' + client + '」という取引先が複数あります。freee 側で名前を区別してください');
  return hits[0];
}

/** freee のエラー応答 → 読める文章 */
function freeeErrorText_(code, body) {
  var texts = [];
  (function walk(v) {
    if (typeof v === 'string') texts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') ['messages', 'message', 'detail', 'errors', 'title'].forEach(function (k) { if (v[k] !== undefined) walk(v[k]); });
  })(body);
  return 'freee のエラー（' + code + '）：' + (texts.length ? texts.join(' / ') : '詳しい理由はわかりませんでした');
}

// ---- freee との連携（OAuth） ----

function freeeProps_() {
  return PropertiesService.getScriptProperties();
}

function freeeClient_() {
  var p = freeeProps_();
  var id = str_(p.getProperty('FREEE_CLIENT_ID')), secret = str_(p.getProperty('FREEE_CLIENT_SECRET'));
  if (!id || !secret) throw new UserError('スクリプト プロパティに FREEE_CLIENT_ID と FREEE_CLIENT_SECRET を入れてください（README の「freee に請求書を作る」参照）');
  return { id: id, secret: secret };
}

function freeeTokenRequest_(payload) {
  var c = freeeClient_();
  payload.client_id = c.id;
  payload.client_secret = c.secret;
  var res = UrlFetchApp.fetch(FREEE_TOKEN_URL, { method: 'post', payload: payload, muteHttpExceptions: true });
  var body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) { /* 下でエラーにする */ }
  if (res.getResponseCode() !== 200 || !body.access_token) {
    throw new UserError('freee との連携に失敗しました（' + res.getResponseCode() + '）' +
      (body.error_description ? '：' + body.error_description : '') + '。もう一度「freee と連携する」からやり直してください');
  }
  freeeProps_().setProperty('FREEE_TOKEN', JSON.stringify({
    access: body.access_token,
    refresh: body.refresh_token,
    expiresAt: Date.now() + ((body.expires_in || 21600) - 300) * 1000
  }));
}

/** 有効なアクセストークン（期限切れなら更新する。更新トークンは1回しか使えないのでロックの中で） */
function freeeAccessToken_() {
  var t = JSON.parse(freeeProps_().getProperty('FREEE_TOKEN') || 'null');
  if (!t) throw new UserError('freee と連携していません。画面の「freee と連携する」から連携してください');
  if (Date.now() < t.expiresAt) return t.access;
  freeeTokenRequest_({ grant_type: 'refresh_token', refresh_token: t.refresh });
  return JSON.parse(freeeProps_().getProperty('FREEE_TOKEN')).access;
}

function freeeFetch_(method, path, query, body) {
  var url = FREEE_API + path + (query ? '?' + Object.keys(query).map(function (k) {
    return k + '=' + encodeURIComponent(query[k]);
  }).join('&') : '');
  var opts = { method: method, headers: { Authorization: 'Bearer ' + freeeAccessToken_() }, muteHttpExceptions: true };
  if (body) {
    opts.contentType = 'application/json';
    opts.payload = JSON.stringify(body);
  }
  var res = UrlFetchApp.fetch(url, opts);
  var code = res.getResponseCode();
  var data = {};
  try { data = JSON.parse(res.getContentText()); } catch (e) { /* 空の応答など */ }
  if (code === 401) throw new UserError('freee の連携が切れています。画面の「freee と連携し直す」から、もう一度連携してください');
  if (code >= 300) throw new UserError(freeeErrorText_(code, data));
  return data;
}

function freeeCompanyId_() {
  var id = str_(freeeProps_().getProperty('FREEE_COMPANY_ID'));
  if (!id) throw new UserError('freee の事業所が選ばれていません。画面の「freee と連携する」からやり直してください');
  return +id;
}

/** 事業所の取引先をすべて取る */
function freeePartners_(companyId) {
  var all = [];
  for (var offset = 0; ; offset += 3000) {
    var page = freeeFetch_('get', '/api/1/partners', { company_id: companyId, offset: offset, limit: 3000 }).partners || [];
    all = all.concat(page);
    if (page.length < 3000) return all;
  }
}

// ---- 画面（FreeeInvoice.html）から呼ぶ ----

function showFreeeInvoice() {
  jobSheets_();
  var html = HtmlService.createHtmlOutputFromFile('FreeeInvoice').setWidth(900).setHeight(760);
  SpreadsheetApp.getUi().showModalDialog(html, 'freee に請求書を作る');
}

/** 「案件一覧」の行と、実際に働いた人（枠IDごと。「案件応募」で確定し、欠勤でない人） */
function invoiceSource_() {
  var rows = readAll_(JOB_SHEET).map(function (x) { x.rec._row = x.row; return x.rec; });
  var workers = {};
  readAll_(APPLY_SHEET).forEach(function (x) {
    var a = x.rec;
    if (a.status !== APPLY_STATUS.CONFIRMED || !a.slotId) return;
    if (!workers[a.slotId]) workers[a.slotId] = [];
    if (ABSENT_STATUSES.indexOf(a.workStatus) < 0) workers[a.slotId].push({ name: a.name, actualStart: a.actualStart, actualEnd: a.actualEnd });
  });
  return { rows: rows, workers: workers };
}

function freeeInvoiceInit() {
  var p = freeeProps_();
  var months = {};
  readAll_(JOB_SHEET).forEach(function (x) {
    var ym = ymOf_(x.rec.salesMonth);
    if (ym && (!str_(x.rec.invoice) || x.rec.invoice === INVOICE_OPTIONS[0])) months[ym] = true;
  });
  var now = new Date();
  var last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return {
    connected: !!p.getProperty('FREEE_TOKEN') && !!p.getProperty('FREEE_COMPANY_ID'),
    companyName: p.getProperty('FREEE_COMPANY_NAME') || '',
    authUrl: freeeAuthUrl_(),
    months: Object.keys(months).sort().reverse(),
    defaultMonth: last.getFullYear() + '/' + pad2_(last.getMonth() + 1)
  };
}

function freeeAuthUrl_() {
  var id = str_(freeeProps_().getProperty('FREEE_CLIENT_ID'));
  if (!id) return '';
  return FREEE_AUTH_URL + '?response_type=code&client_id=' + encodeURIComponent(id) +
    '&redirect_uri=' + encodeURIComponent(FREEE_REDIRECT_URI) + '&prompt=select_company';
}

/** 画面に貼り付けた認可コードで連携する。事業所が複数あれば一覧を返す */
function freeeConnect(code) {
  code = str_(code);
  if (!code) throw new UserError('freee の画面に表示されたコードを貼り付けてください');
  freeeClient_();
  return withLock_(function () {
    freeeTokenRequest_({ grant_type: 'authorization_code', code: code, redirect_uri: FREEE_REDIRECT_URI });
    var companies = freeeFetch_('get', '/api/1/companies').companies || [];
    if (!companies.length) throw new UserError('freee の事業所が見つかりませんでした');
    if (companies.length === 1) return freeeSelectCompanyLocked_(companies[0]);
    freeeProps_().deleteProperty('FREEE_COMPANY_ID');
    return { companies: companies.map(function (c) { return { id: c.id, name: c.display_name || c.name || String(c.id) }; }) };
  });
}

function freeeSelectCompany(id, name) {
  return withLock_(function () { return freeeSelectCompanyLocked_({ id: id, display_name: name }); });
}

function freeeSelectCompanyLocked_(c) {
  freeeProps_().setProperty('FREEE_COMPANY_ID', String(c.id));
  freeeProps_().setProperty('FREEE_COMPANY_NAME', str_(c.display_name || c.name));
  return { connected: true, companyName: str_(c.display_name || c.name) };
}

/** 作成する前の確認（freee には送らない） */
function freeeInvoicePreview(ym) {
  ym = ymOf_(ym);
  if (!ym) throw new UserError('月を選んでください');
  var src = invoiceSource_();
  return buildInvoices_(src.rows, ym, src.workers, getConfig_().paymentMonthsAfter).map(function (inv) {
    return {
      key: inv.key, client: inv.client, title: inv.title, subject: inv.subject, billingDate: inv.billingDate, paymentDate: inv.paymentDate,
      lines: inv.lines.map(function (l) { return { description: l.description, quantity: l.quantity, unit: l.unit, unitPrice: l.unit_price, amount: lineAmount_(l) }; }),
      subtotal: inv.subtotal, tax: inv.tax, total: inv.total, problems: inv.problems, warnings: inv.warnings, rowCount: inv.rows.length
    };
  });
}

/** 選んだ取引先の請求書を freee に作り、シートに記録する（シートを読み直して作るので、画面の内容は使わない） */
function freeeCreateInvoices(req) {
  var ym = ymOf_(req && req.ym);
  if (!ym) throw new UserError('月を選んでください');
  var chosen = {};
  ((req && req.keys) || []).forEach(function (k) { chosen[k] = true; });
  return withLock_(function () {
    var sh = sheet_(JOB_SHEET);
    if (headerMap_(sh)['freee請求書番号'] === undefined) ensureSheet_(spreadsheet_(), JOB_SHEET);
    var companyId = freeeCompanyId_();
    var src = invoiceSource_();
    var invoices = buildInvoices_(src.rows, ym, src.workers, getConfig_().paymentMonthsAfter).filter(function (inv) { return chosen[inv.key]; });
    if (!invoices.length) throw new UserError('作成する請求書がありません（すでに作成済みかもしれません）。もう一度「内容を確認」を押してください');
    var partners = freeePartners_(companyId);
    return invoices.map(function (inv) {
      try {
        if (inv.problems.length) throw new Error(inv.problems.join('\n'));
        if (!inv.lines.length) throw new Error('請求する明細がありません');
        var partner = findPartner_(partners, inv.client);
        var created = freeeFetch_('post', '/iv/invoices', null, invoiceRequest_(inv, companyId, partner.id)).invoice || {};
        var number = str_(created.invoice_number) || str_(created.id);
        inv.rows.forEach(function (row) {
          updateCells_(JOB_SHEET, row, { invoice: INVOICE_OPTIONS[1], freeeInvoice: number });
        });
        return { client: inv.client, title: inv.title, ok: true, number: number, total: created.total_amount || inv.total };
      } catch (err) {
        logError_('freee 請求書：' + inv.client + ' ' + inv.title, '', err);
        return { client: inv.client, title: inv.title, ok: false, error: err.message };
      }
    });
  });
}
