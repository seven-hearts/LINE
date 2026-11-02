/**
 * スタッフマニュアル（縦スクロールのマンガ。liff/manual/）の閲覧数の記録と集計。
 *
 * - マニュアルのページを開いたとき・章の最後のページまで読んだときに、ページから記録が届く（apiManualView_）
 *   → シート「マニュアル閲覧」に1行ずつ追加
 *   スタッフ用リッチメニュー（LIFF の URL）から開いた場合は、LINEユーザーIDと氏名も入る
 * - シート「マニュアル集計」に、開いた回数・人数、章ごとに読み終えた人数、スタッフ別の既読状況をまとめる
 *   毎朝6時（setup で登録するトリガー）と、メニュー「セブンハーツ > マニュアルの閲覧数を集計」で作り直す
 * - トークで「マニュアル」と送ると、マニュアルを開くボタンを返す（Webhook.gs）
 *
 * manualViewRecord_ と manualSummary_ はシートに触れないので、tests/manual.test.js で確認できる。
 */

var MANUAL_EVENTS = { open: '開いた', chapter: '章を読み終えた' };
/** リッチメニューなどの URL に付ける ?from=… → シートに書く名前 */
var MANUAL_FROM = { staffmenu: 'スタッフ用リッチメニュー', menu: 'リッチメニュー', talk: 'トーク' };
var MANUAL_FROM_DIRECT = 'URLから直接';
var MANUAL_LOG_MAX_ROWS = 50000;  // これを超えたら古い記録から消す
var MANUAL_RATE_LIMIT = 120;      // 1台の端末から10分間に受け付ける記録の数（いたずら対策）
var MANUAL_SUMMARY_HOUR = 6;      // 集計を作り直す時刻（毎朝）
var MANUAL_DAILY_DAYS = 30;       // 日ごとの表に出す日数

// ---- マニュアルの URL ----

/** だれでも開ける URL（LINE Official Account Manager で作るリッチメニューなど） */
function manualUrl_(from) {
  return getConfig_().manualUrl + (from ? '?from=' + from : '');
}

/** LIFF の URL（LINE で開くと、だれが読んだかを記録できる）。スタッフ用リッチメニューとスタッフへの返信に使う */
function staffManualUrl_(from) {
  return registerUrl_() + '/manual/' + (from ? '?from=' + from : '');
}

function manualButton_(isStaff) {
  return buttonMessage_('スタッフマニュアル（マンガ）はこちらから読めます。', 'マニュアルを読む',
    isStaff ? staffManualUrl_('talk') : manualUrl_('talk'));
}

// ---- 記録 ----

function isSmallInt_(v, min, max) {
  return typeof v === 'number' && Math.floor(v) === v && v >= min && v <= max;
}

/** ページから届いた内容を確かめて、シートに書く形にする。おかしな内容なら null */
function manualViewRecord_(data) {
  data = data || {};
  var visitor = String(data.visitor || '');
  if (!/^[a-z0-9]{16}$/.test(visitor)) return null;
  var event = MANUAL_EVENTS[data.event];
  if (!event || !Object.prototype.hasOwnProperty.call(MANUAL_EVENTS, data.event)) return null;
  var chapter = Number(data.chapter || 0);
  var total = Number(data.total || 0);
  if (!isSmallInt_(chapter, 0, 99) || !isSmallInt_(total, 0, 99)) return null;
  var isChapter = data.event === 'chapter';
  if (isChapter && chapter < 1) return null;
  var from = String(data.from || '');
  if (!/^[a-z0-9_-]{1,20}$/.test(from)) from = '';
  return {
    visitor: visitor,
    event: event,
    chapter: isChapter ? chapter : '',
    title: isChapter ? String(data.title || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : '',
    total: total,
    from: MANUAL_FROM[from] || from || MANUAL_FROM_DIRECT
  };
}

/** マニュアルのページからの記録（ログインしていなくても受け付ける。IDトークンがあれば本人を確かめて氏名も残す） */
function apiManualView_(idToken, data) {
  var rec = manualViewRecord_(data);
  if (!rec) return { ok: false };
  var sh = spreadsheet_().getSheetByName(MANUAL_LOG_SHEET);
  if (!sh) return { ok: false }; // setup を実行するまでは記録しない（エラーログを埋めないように）

  var cache = CacheService.getScriptCache();
  var key = 'mv:' + rec.visitor;
  var count = Number(cache.get(key) || 0);
  if (count >= MANUAL_RATE_LIMIT) return { ok: false };
  cache.put(key, String(count + 1), 600);

  var userId = '';
  if (idToken) {
    try {
      userId = verifyIdToken_(idToken);
    } catch (err) {
      userId = ''; // 有効期限切れなど。人数としては数える
    }
  }
  var at = now_();
  rec.at = at;
  rec.date = at.slice(0, 10);
  rec.userId = userId;
  rec.name = userId ? manualViewerName_(userId) : '';

  var header = headerMap_(sh);
  var row = new Array(sh.getLastColumn()).fill('');
  Object.keys(rec).forEach(function (k) {
    var i = header[labelOf_(MANUAL_LOG_SHEET, k)];
    if (i !== undefined) row[i] = cellValue_(rec[k]);
  });
  sh.appendRow(row); // 同時に届いても行が重ならない
  if (sh.getLastRow() > MANUAL_LOG_MAX_ROWS + 1000) sh.deleteRows(2, 1000);
  return { ok: true };
}

/** 氏名（「スタッフ登録」から。同じ人が続けて読むので1時間覚えておく） */
function manualViewerName_(userId) {
  var cache = CacheService.getScriptCache();
  var key = 'mvn:' + userId;
  var cached = cache.get(key);
  if (cached) return cached;
  var reg = readRecord_(REG_SHEET, userId);
  var name = reg ? fullName_(reg) : '（スタッフ登録なし）';
  cache.put(key, name, 3600);
  return name;
}

// ---- 集計 ----

/** 'yyyy/MM/dd' の n 日前 */
function manualDayBefore_(day, n) {
  var p = String(day).split('/');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] - n));
  return d.getUTCFullYear() + '/' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '/' + ('0' + d.getUTCDate()).slice(-2);
}

/**
 * 「マニュアル閲覧」の記録をまとめる。
 * 同じ端末で一度でも LIFF から開いていれば、LIFF でないときの記録もその人として数える。
 * @param {Object[]} rows 「マニュアル閲覧」の行（古い順）
 * @param {{userId: string, name: string, status: string}[]} staff 既読状況を出すスタッフ
 * @param {string} today 'yyyy/MM/dd'
 */
function manualSummary_(rows, staff, today) {
  rows = rows.filter(function (r) { return r.visitor && (r.event === MANUAL_EVENTS.open || r.event === MANUAL_EVENTS.chapter); });
  var userOfVisitor = {};
  rows.forEach(function (r) { if (r.userId) userOfVisitor[r.visitor] = r.userId; });
  function viewer(r) {
    var u = r.userId || userOfVisitor[r.visitor];
    return u ? 'u:' + u : 'v:' + r.visitor;
  }
  function count(obj) { return Object.keys(obj).length; }

  var weekStart = manualDayBefore_(today, 6);
  var total = 0;
  var titles = {};
  var opens = 0, opens7 = 0;
  var viewers = {}, viewers7 = {};
  var readers = {};   // 章 → { 閲覧者: true }
  var readBy = {};    // 閲覧者 → { 章: true }
  var daily = {};     // 日付 → { opens, viewers }
  var froms = {}, fromOrder = [];
  var perUser = {};   // LINEユーザーID → { opens, lastAt }

  rows.forEach(function (r) {
    var v = viewer(r);
    var t = Number(r.total) || 0;
    if (t) total = t; // いちばん新しい記録の章の数を、いまのマニュアルの章の数とする
    var u = r.userId || userOfVisitor[r.visitor];
    if (r.event === MANUAL_EVENTS.open) {
      opens++;
      viewers[v] = true;
      if (r.date >= weekStart) { opens7++; viewers7[v] = true; }
      var d = daily[r.date] || (daily[r.date] = { opens: 0, viewers: {} });
      d.opens++;
      d.viewers[v] = true;
      var f = r.from || MANUAL_FROM_DIRECT;
      if (!froms[f]) { froms[f] = 0; fromOrder.push(f); }
      froms[f]++;
      if (u) {
        var p = perUser[u] || (perUser[u] = { opens: 0, lastAt: '' });
        p.opens++;
        if (String(r.at) > p.lastAt) p.lastAt = String(r.at);
      }
    } else {
      var no = Number(r.chapter);
      if (!no) return;
      if (r.title) titles[no] = r.title;
      (readers[no] || (readers[no] = {}))[v] = true;
      (readBy[v] || (readBy[v] = {}))[no] = true;
    }
  });

  function readAll(v) {
    if (!total || !readBy[v]) return false;
    for (var no = 1; no <= total; no++) if (!readBy[v][no]) return false;
    return true;
  }
  var finished = Object.keys(readBy).filter(readAll).length;
  var viewerCount = count(viewers);

  var chapters = [];
  for (var no = 1; no <= total; no++) {
    var n = readers[no] ? count(readers[no]) : 0;
    chapters.push({ no: no, title: titles[no] || '', readers: n, rate: viewerCount ? n / viewerCount : 0 });
  }

  var days = [];
  for (var i = 0; i < MANUAL_DAILY_DAYS; i++) {
    var day = manualDayBefore_(today, i);
    var dd = daily[day];
    days.push({ date: day, opens: dd ? dd.opens : 0, viewers: dd ? count(dd.viewers) : 0 });
  }

  var staffRows = staff.map(function (s) {
    var p = perUser[s.userId];
    var read = Object.keys(readBy['u:' + s.userId] || {}).map(Number).sort(function (a, b) { return a - b; });
    return {
      name: s.name,
      status: s.status,
      opens: p ? p.opens : 0,
      lastAt: p ? p.lastAt : '',
      read: read,
      finished: readAll('u:' + s.userId)
    };
  });
  // 最近読んだ人を上に、まだ開いていない人を下にまとめる
  staffRows.sort(function (a, b) {
    if (a.lastAt !== b.lastAt) return a.lastAt < b.lastAt ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return {
    total: total,
    opens: opens,
    opens7: opens7,
    viewers: viewerCount,
    viewers7: count(viewers7),
    finished: finished,
    chapters: chapters,
    days: days,
    from: fromOrder.map(function (f) { return { from: f, opens: froms[f] }; }).sort(function (a, b) { return b.opens - a.opens; }),
    staff: staffRows
  };
}

/** 「マニュアル集計」の表（2次元の配列と、太字にする行・見出しの行） */
function manualSummaryRows_(s, updatedAt) {
  var W = 6;
  var rows = [], titles = [], heads = [];
  function line(cells) {
    var r = cells.slice(0, W);
    while (r.length < W) r.push('');
    rows.push(r);
  }
  function title(text) { titles.push(rows.length); line([text]); }
  function head(cells) { heads.push(rows.length); line(cells); }
  function pct(x) { return Math.round(x * 100) + '%'; }

  title('スタッフマニュアルの閲覧数（更新：' + updatedAt + '）');
  line(['毎朝' + MANUAL_SUMMARY_HOUR + '時に自動で更新します。すぐに更新するときは、メニュー「セブンハーツ > マニュアルの閲覧数を集計」を選んでください。']);
  line([]);

  title('■ 全体');
  head(['', '累計', '直近7日']);
  line(['開いた回数', s.opens, s.opens7]);
  line(['閲覧した人数（端末の数）', s.viewers, s.viewers7]);
  line(['全章を読み終えた人数', s.finished]);
  line([]);

  title('■ 章ごとに読み終えた人数（章の最後のページまで読んだ人）');
  head(['章', '章の名前', '読み終えた人数', '閲覧した人数に対する割合']);
  if (!s.chapters.length) line(['（まだ記録がありません）']);
  s.chapters.forEach(function (c) { line(['第' + c.no + '章', c.title, c.readers, pct(c.rate)]); });
  line([]);

  title('■ スタッフ別（ステータスが「採用」〜「稼働可」の人。スタッフ用リッチメニューかトークのボタンから開いたときに記録）');
  head(['氏名', 'ステータス', '開いた回数', '最後に開いた日時', '読み終えた章', '全章']);
  if (!s.staff.length) line(['（対象のスタッフがいません）']);
  s.staff.forEach(function (r) {
    line([r.name, r.status, r.opens, r.lastAt || 'まだ開いていません',
      r.read.map(function (n) { return '第' + n + '章'; }).join('・'), r.finished ? '○' : '']);
  });
  line([]);

  title('■ 開いた場所');
  head(['場所', '開いた回数']);
  if (!s.from.length) line(['（まだ記録がありません）']);
  s.from.forEach(function (f) { line([f.from, f.opens]); });
  line([]);

  title('■ 日ごと（直近' + MANUAL_DAILY_DAYS + '日・新しい順）');
  head(['日付', '開いた回数', '閲覧した人数']);
  s.days.forEach(function (d) { line([d.date, d.opens, d.viewers]); });

  return { rows: rows, titles: titles, heads: heads };
}

/** シート「マニュアル集計」を作り直す（毎朝のトリガーと、メニューから） */
function updateManualSummary() {
  var ss = spreadsheet_();
  if (!ss.getSheetByName(MANUAL_LOG_SHEET)) throw new Error('シート「' + MANUAL_LOG_SHEET + '」がありません。setup を実行してください');
  // 日時の列が日付として読み込まれた場合も、文字にそろえる
  function text(v, format) { return v instanceof Date ? Utilities.formatDate(v, 'Asia/Tokyo', format) : String(v); }
  var logs = readAll_(MANUAL_LOG_SHEET).map(function (x) {
    x.rec.at = text(x.rec.at, 'yyyy/MM/dd HH:mm:ss');
    x.rec.date = text(x.rec.date, 'yyyy/MM/dd');
    return x.rec;
  });
  var statuses = staffMenuStatuses_();
  var staff = readAll_(REG_SHEET).map(function (x) { return x.rec; })
    .filter(function (r) { return r.userId && statuses.indexOf(r.status) >= 0; })
    .map(function (r) { return { userId: r.userId, name: fullName_(r), status: r.status }; });
  var now = now_();
  var table = manualSummaryRows_(manualSummary_(logs, staff, now.slice(0, 10)), now);

  var sh = ss.getSheetByName(MANUAL_SUMMARY_SHEET) || ss.insertSheet(MANUAL_SUMMARY_SHEET);
  sh.clear();
  applySheetFont_(sh);
  sh.getRange(1, 1, table.rows.length, table.rows[0].length).setValues(table.rows);
  table.titles.forEach(function (r) { sh.getRange(r + 1, 1).setFontWeight('bold').setFontColor('#381e19'); });
  table.heads.forEach(function (r) {
    sh.getRange(r + 1, 1, 1, table.rows[0].length).setFontWeight('bold').setBackground('#f3e5f5');
  });
  sh.setColumnWidth(1, 200);
  sh.setColumnWidths(2, 5, 140);
  return table;
}

/** メニュー「マニュアルの閲覧数を集計」 */
function updateManualSummaryNow() {
  updateManualSummary();
  spreadsheet_().getSheetByName(MANUAL_SUMMARY_SHEET).activate();
}
