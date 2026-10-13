/**
 * 毎月のシフト提出と、勤務エリアごとの集計。
 *
 * - 毎月25日の午前10時に、ステータスが「稼働可」のスタッフへ翌月のシフト提出フォームのボタンを送る（runScheduler）
 *   25日より後に「稼働可」になった人にも、その月のうちに送る。トークで「シフト」と送っても開ける
 * - フォーム（liff/shift.html）で出勤できる日を選ぶ → シート「シフト提出」に1人1か月1行で保存
 * - シート「シフト集計_2026年11月」に、日ごと・勤務エリアごとの出勤可能な人数を作る
 *   エリアは「スタッフ登録」（スタッフ名簿）の「希望エリア」を使う。提出から1分以内に更新される
 *
 * シートや LINE に触れない関数（月の計算・入力の整形・集計）は tests/shift.test.js で確認できる。
 */

var SHIFT_SEND_DAY = 25;   // 翌月のシフト提出の案内を送る日
var SHIFT_SEND_HOUR = 10;  // その日の何時に送るか
var SHIFT_OK = '○';
var SHIFT_NG = '×';
var SHIFT_NO_AREA = 'エリア未設定';
var SHIFT_SUMMARY_PREFIX = 'シフト集計_';
var SHIFT_DIRTY_KEY = 'SHIFT_SUMMARY_DIRTY'; // 集計を作り直す月（スクリプト プロパティ）
var LONG_HOLIDAY_DAYS = 3; // 土日祝がこの日数以上続くと「連休」（カレンダーで赤く表示）

// カレンダーの色（フォームは liff/css/style.css、集計シートはここ）
var DAY_COLORS = { weekday: '#ffffff', off: '#ffe0b2', long: '#f28b82' };

// ---- 祝日・連休 ----
// 「国民の祝日に関する法律」（2020年以降の内容）から計算する。法律が変わったらここを直す。
// 春分・秋分の日は、国立天文台の発表と一致する近似式（2099年まで）を使う。

var holidayCache_ = {};

/** その月の第n月曜日（日） */
function nthMonday_(year, month, n) {
  var first = new Date(year, month - 1, 1).getDay();
  return (8 - first) % 7 + 1 + (n - 1) * 7;
}

/** その年の祝日：{ 'yyyy-MM-dd': 祝日名 } */
function holidaysOf_(year) {
  if (holidayCache_[year]) return holidayCache_[year];
  var h = {};
  function add(m, d, name) { h[formatDate_(new Date(year, m - 1, d))] = name; }
  var base = year - 1980;
  add(1, 1, '元日');
  add(1, nthMonday_(year, 1, 2), '成人の日');
  add(2, 11, '建国記念の日');
  add(2, 23, '天皇誕生日');
  add(3, Math.floor(20.8431 + 0.242194 * base - Math.floor(base / 4)), '春分の日');
  add(4, 29, '昭和の日');
  add(5, 3, '憲法記念日');
  add(5, 4, 'みどりの日');
  add(5, 5, 'こどもの日');
  add(7, nthMonday_(year, 7, 3), '海の日');
  add(8, 11, '山の日');
  add(9, nthMonday_(year, 9, 3), '敬老の日');
  add(9, Math.floor(23.2488 + 0.242194 * base - Math.floor(base / 4)), '秋分の日');
  add(10, nthMonday_(year, 10, 2), 'スポーツの日');
  add(11, 3, '文化の日');
  add(11, 23, '勤労感謝の日');

  var dates = Object.keys(h).sort().map(function (k) {
    var p = k.split('-');
    return new Date(+p[0], p[1] - 1, +p[2]);
  });
  // 国民の休日：祝日にはさまれた日
  dates.forEach(function (d) {
    var mid = addDaysTo_(d, 1);
    if (h[formatDate_(addDaysTo_(d, 2))] && !h[formatDate_(mid)] && mid.getDay() !== 0) h[formatDate_(mid)] = '国民の休日';
  });
  // 振替休日：祝日が日曜日なら、その後の最初の祝日でない日
  dates.forEach(function (d) {
    if (d.getDay() !== 0) return;
    var next = addDaysTo_(d, 1);
    while (h[formatDate_(next)]) next = addDaysTo_(next, 1);
    h[formatDate_(next)] = '振替休日';
  });
  holidayCache_[year] = h;
  return h;
}

/** 祝日名（祝日でなければ ''） */
function holidayName_(d) {
  return holidaysOf_(d.getFullYear())[formatDate_(d)] || '';
}

function isOffDay_(d) {
  return d.getDay() === 0 || d.getDay() === 6 || !!holidayName_(d);
}

/**
 * その月の各日の種類。月をまたぐ連休（10/31〜11/2 など）も数える。
 * @return [{ day, weekday, holiday: 祝日名, type: 'weekday' | 'off'（土日祝） | 'long'（3連休以上） }]
 */
function monthCalendar_(year, month) {
  var days = [];
  for (var day = 1; day <= daysInMonth_(year, month); day++) {
    var d = new Date(year, month - 1, day);
    var type = 'weekday';
    if (isOffDay_(d)) {
      var run = 1;
      for (var p = addDaysTo_(d, -1); isOffDay_(p); p = addDaysTo_(p, -1)) run++;
      for (var n = addDaysTo_(d, 1); isOffDay_(n); n = addDaysTo_(n, 1)) run++;
      type = run >= LONG_HOLIDAY_DAYS ? 'long' : 'off';
    }
    days.push({ day: day, weekday: d.getDay(), holiday: holidayName_(d), type: type });
  }
  return days;
}

// ---- 月の計算 ----

/** 「2026-11」 */
function shiftMonthKey_(d) {
  return d.getFullYear() + '-' + pad2_(d.getMonth() + 1);
}

/** 「2026-11」「2026年11月」→ { year, month }。読めなければ null */
function parseShiftMonth_(s) {
  var m = /^(\d{4})(?:-|年)(\d{1,2})月?$/.exec(String(s || '').trim());
  if (!m || +m[2] < 1 || +m[2] > 12) return null;
  return { year: +m[1], month: +m[2] };
}

/** 「2026-11」→「2026年11月」（シートにはこの形で書く。日付に自動変換されないように） */
function shiftMonthLabel_(key) {
  var ym = parseShiftMonth_(key);
  return ym ? ym.year + '年' + ym.month + '月' : '';
}

function nextShiftMonth_(now) {
  return shiftMonthKey_(new Date(now.getFullYear(), now.getMonth() + 1, 1));
}

/** トークで「シフト」と送られたときに開く月：25日以降は翌月、それより前は今月 */
function defaultShiftMonth_(now) {
  return now.getDate() >= SHIFT_SEND_DAY ? nextShiftMonth_(now) : shiftMonthKey_(now);
}

/** 提出・変更を受け付ける月（今月と翌月） */
function shiftMonthAllowed_(key, now) {
  return key === shiftMonthKey_(now) || key === nextShiftMonth_(now);
}

function daysInMonth_(year, month) {
  return new Date(year, month, 0).getDate();
}

// ---- 判定・文面 ----

function isShiftTarget_(rec) {
  return !!rec.userId && rec.status === STATUS.ACTIVE;
}

/** 今、翌月分のシフト提出の案内を送るべきか（25日10時以降、まだ送っていない稼働可の人） */
function shiftRequestDue_(rec, now) {
  if (!isShiftTarget_(rec) || rec.blocked) return false;
  if (now.getDate() < SHIFT_SEND_DAY || (now.getDate() === SHIFT_SEND_DAY && now.getHours() < SHIFT_SEND_HOUR)) return false;
  return String(rec.shiftRequestedMonth || '') !== shiftMonthLabel_(nextShiftMonth_(now));
}

function shiftUrl_(key) {
  return registerUrl_() + '/shift.html?month=' + key;
}

function shiftButton_(key, text) {
  return buttonMessage_(text || shiftMonthLabel_(key) + 'のシフト（出勤できる日）は、こちらから提出・変更できます。',
    'シフトを提出する', shiftUrl_(key));
}

function shiftRequestMessages_(rec, key) {
  return [shiftButton_(key, fullName_(rec) + ' さん\n\n' + shiftMonthLabel_(key) + 'のシフト提出のお願いです。\n' +
    '出勤できる日を、下のボタンから入力してください（約1分）。提出後も月末まで変更できます。')];
}

/**
 * フォームの入力を、シート「シフト提出」に書く形に整える。
 * - その月の日数ぶんだけ「○」か「×」を入れる（それ以降の日は空欄）
 * - 今月分を変更するとき、過ぎた日は変えない（以前の値のまま）
 * @param input { days: { 1: '○', ... }, note }
 * @param existing 以前に提出した行（なければ null）
 */
function normalizeShift_(input, key, now, existing) {
  var ym = parseShiftMonth_(key);
  if (!ym || !shiftMonthAllowed_(key, now)) {
    throw new UserError('この月のシフトの受付は終了しました。トーク画面で「シフト」と送信して、最新のフォームを開いてください。');
  }
  var days = (input && input.days) || {};
  var last = daysInMonth_(ym.year, ym.month);
  var today = startOfDay_(now);
  var record = {};
  var count = 0;
  for (var d = 1; d <= 31; d++) {
    var v = '';
    if (d <= last) {
      var past = new Date(ym.year, ym.month - 1, d) < today;
      v = past ? String((existing && existing['d' + d]) || '') : (days[d] === SHIFT_OK ? SHIFT_OK : SHIFT_NG);
    }
    record['d' + d] = v;
    if (v === SHIFT_OK) count++;
  }
  var note = String((input && input.note) || '').trim();
  if (note.length > 300) throw new ValidationError({ note: '300文字以内で入力してください' });
  record.note = note;
  record.availableDays = count;
  return record;
}

/** 「大阪、京都」→ ['大阪', '京都'] */
function splitAreas_(s) {
  return String(s || '').split(LIST_SEPARATOR).map(function (a) { return a.trim(); }).filter(String);
}

/**
 * 日ごと・エリアごとの出勤可能な人数。
 * @param staff 対象のスタッフ（稼働可） [{ userId, name, areas: '大阪、京都' }]
 * @param shifts userId → シート「シフト提出」の行
 * @param areaOrder エリアの並び順（OPTIONS.areas）
 */
function shiftSummary_(staff, shifts, key, areaOrder) {
  var ym = parseShiftMonth_(key);
  var last = daysInMonth_(ym.year, ym.month);
  var areas = areaOrder.slice();
  var areaStaff = {};
  staff.forEach(function (s) {
    var list = splitAreas_(s.areas);
    if (!list.length) list = [SHIFT_NO_AREA];
    s.areaList = list;
    list.forEach(function (a) {
      if (areas.indexOf(a) < 0) areas.push(a);
      areaStaff[a] = (areaStaff[a] || 0) + 1;
    });
  });

  var calendar = monthCalendar_(ym.year, ym.month);
  var days = [];
  for (var d = 1; d <= last; d++) {
    var names = {};
    var all = [];
    areas.forEach(function (a) { names[a] = []; });
    staff.forEach(function (s) {
      var sh = shifts[s.userId];
      if (!sh || sh['d' + d] !== SHIFT_OK) return;
      all.push(s.name);
      s.areaList.forEach(function (a) { names[a].push(s.name); });
    });
    var cal = calendar[d - 1];
    days.push({ day: d, weekday: cal.weekday, holiday: cal.holiday, type: cal.type, names: names, all: all });
  }

  return {
    areas: areas,
    areaStaff: areaStaff,
    staffCount: staff.length,
    days: days,
    submitted: staff.filter(function (s) { return shifts[s.userId]; }),
    notSubmitted: staff.filter(function (s) { return !shifts[s.userId]; })
  };
}

// ---- シートの読み書き ----

function findShiftRow_(sh, header, userId, label) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var idCol = header['LINEユーザーID'];
  var monthCol = header[labelOf_(SHIFT_SHEET, 'month')];
  var values = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][idCol] === userId && String(values[i][monthCol]) === label) return i + 2;
  }
  return -1;
}

function readShift_(userId, key) {
  var sh = sheet_(SHIFT_SHEET);
  var header = headerMap_(sh);
  var row = findShiftRow_(sh, header, userId, shiftMonthLabel_(key));
  if (row < 0) return null;
  return rowToRecord_(SHIFT_SHEET, header, sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0]);
}

/** userId・月の行に書き込む（なければ追加） */
function writeShift_(userId, key, fields) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_(SHIFT_SHEET);
    var header = headerMap_(sh);
    var width = sh.getLastColumn();
    var label = shiftMonthLabel_(key);
    var row = findShiftRow_(sh, header, userId, label);
    var values = row > 0 ? sh.getRange(row, 1, 1, width).getValues()[0] : new Array(width).fill('');
    fields.userId = userId;
    fields.month = label;
    Object.keys(fields).forEach(function (k) {
      var i = header[labelOf_(SHIFT_SHEET, k)];
      if (i === undefined) {
        console.error('シート「' + SHIFT_SHEET + '」に列「' + labelOf_(SHIFT_SHEET, k) + '」がありません。setup を実行してください');
        throw new UserError('システムの設定に不備があり、保存できませんでした。お手数ですが、トークで担当者にお知らせください。');
      }
      values[i] = cellValue_(fields[k]);
    });
    if (row < 0) row = lastDataRow_(sh, header) + 1;
    sh.getRange(row, 1, 1, width).setValues([values]);
  } finally {
    lock.releaseLock();
  }
}

/** 次の runScheduler（1分以内）で集計を作り直す */
function markShiftSummaryDirty_(key) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var props = PropertiesService.getScriptProperties();
    var keys = (props.getProperty(SHIFT_DIRTY_KEY) || '').split(',').filter(String);
    if (keys.indexOf(key) < 0) keys.push(key);
    props.setProperty(SHIFT_DIRTY_KEY, keys.join(','));
  } finally {
    lock.releaseLock();
  }
}

function rebuildDirtyShiftSummaries_() {
  var props = PropertiesService.getScriptProperties();
  var dirty = props.getProperty(SHIFT_DIRTY_KEY);
  if (!dirty) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    dirty = props.getProperty(SHIFT_DIRTY_KEY) || '';
    props.deleteProperty(SHIFT_DIRTY_KEY);
  } finally {
    lock.releaseLock();
  }
  dirty.split(',').filter(String).forEach(function (key) {
    try {
      writeShiftSummary_(key);
    } catch (err) {
      console.error('shift summary failed', key, err && err.stack || err);
      markShiftSummaryDirty_(key); // 次の回にもう一度
    }
  });
}

/** 稼働可のスタッフ（スタッフ名簿＝シート「スタッフ登録」から） */
function shiftStaff_() {
  var sh = sheet_(REG_SHEET);
  if (sh.getLastRow() < 2) return [];
  var header = headerMap_(sh);
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues()
    .map(function (v) { return rowToRecord_(REG_SHEET, header, v); })
    .filter(isShiftTarget_)
    .map(function (rec) { return { userId: rec.userId, name: fullName_(rec), areas: rec.areas }; });
}

/** その月に提出されたシフト（userId → 行） */
function shiftsOfMonth_(key) {
  var sh = sheet_(SHIFT_SHEET);
  var map = {};
  if (sh.getLastRow() < 2) return map;
  var header = headerMap_(sh);
  var label = shiftMonthLabel_(key);
  sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().forEach(function (v) {
    var rec = rowToRecord_(SHIFT_SHEET, header, v);
    if (rec.userId && String(rec.month) === label) map[rec.userId] = rec;
  });
  return map;
}

/**
 * シート「シフト集計_2026年11月」を作り直す。
 * 人数のセルにメモで名前を付けるので、セルにカーソルを合わせると誰が出勤できるかわかる。
 */
function writeShiftSummary_(key) {
  var label = shiftMonthLabel_(key);
  var summary = shiftSummary_(shiftStaff_(), shiftsOfMonth_(key), key, OPTIONS.areas);
  var ss = spreadsheet_();
  var name = SHIFT_SUMMARY_PREFIX + label;
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearNote();
  sh.clear();

  var width = summary.areas.length + 3;
  function line(cells) {
    while (cells.length < width) cells.push('');
    return cells;
  }
  var rows = [];
  rows.push(line([label + ' 出勤可能な人数（勤務エリア別）']));
  rows.push(line(['更新：' + now_() + '　対象：ステータスが「' + STATUS.ACTIVE + '」のスタッフ ' + summary.staffCount + '人' +
    '（提出済み ' + summary.submitted.length + '人／未提出 ' + summary.notSubmitted.length + '人）']));
  rows.push(line(['※ 希望エリアは「' + REG_SHEET + '」シートの内容です。複数のエリアを希望している人はそれぞれのエリアに数えます（「合計」は実人数）。人数のセルのメモに名前があります。']));
  var headerRow = rows.length;
  rows.push(line(['日付', '曜日'].concat(summary.areas, ['合計（実人数）'])));
  rows.push(line(['エリアの登録人数', ''].concat(summary.areas.map(function (a) { return summary.areaStaff[a] || 0; }), [summary.staffCount])));
  var firstDayRow = rows.length;
  var notes = [];
  var ym = parseShiftMonth_(key);
  summary.days.forEach(function (d) {
    rows.push(line([ym.month + '/' + d.day, WEEKDAYS_JA[d.weekday] + (d.holiday ? '・' + d.holiday : '')].concat(
      summary.areas.map(function (a) { return d.names[a].length; }), [d.all.length])));
    notes.push(['', ''].concat(summary.areas.map(function (a) { return d.names[a].join('\n'); }), [d.all.join('\n')]));
  });
  rows.push(line(['']));
  var listRow = rows.length;
  rows.push(line(['未提出のスタッフ（' + summary.notSubmitted.length + '人）', '', '希望エリア']));
  summary.notSubmitted.forEach(function (s) { rows.push(line([s.name, '', s.areas || ''])); });

  sh.getRange(1, 1, rows.length, 2).setNumberFormat('@'); // 「11/1」が日付に変わらないように
  sh.getRange(1, 1, rows.length, width).setValues(rows);
  sh.getRange(firstDayRow + 1, 1, notes.length, width).setNotes(notes);

  sh.getRange(1, 1).setFontWeight('bold').setFontSize(12);
  sh.getRange(2, 1, 2, 1).setFontColor('#6f625b');
  sh.getRange(headerRow + 1, 1, 1, width).setFontWeight('bold').setBackground('#f3e5f5');
  sh.getRange(headerRow + 2, 1, 1, width).setFontColor('#6f625b').setBackground('#fafafa');
  sh.getRange(headerRow + 1, 3, rows.length - headerRow, width - 2).setHorizontalAlignment('center');
  // 平日は白、土日祝は薄いオレンジ、3連休以上は赤（フォームのカレンダーと同じ色）
  sh.getRange(firstDayRow + 1, 1, summary.days.length, width).setBackgrounds(summary.days.map(function (d) {
    return new Array(width).fill(DAY_COLORS[d.type]);
  }));
  sh.getRange(firstDayRow + 1, width, notes.length, 1).setFontWeight('bold');
  sh.getRange(listRow + 1, 1, 1, width).setFontWeight('bold');
  sh.setFrozenRows(headerRow + 1);
  sh.setColumnWidth(1, 120);
  sh.setColumnWidth(2, 120);
  return sh;
}

// ---- 送信 ----

function hasShiftRequestColumn_(header) {
  if (header[labelOf_(REG_SHEET, 'shiftRequestedMonth')] !== undefined) return true;
  console.error('シート「' + REG_SHEET + '」に列「' + labelOf_(REG_SHEET, 'shiftRequestedMonth') + '」がないため、シフト提出の案内を送れません。setup を実行してください');
  return false;
}

function sendShiftRequest_(rec, key) {
  if (pushMessage_(rec.userId, shiftRequestMessages_(rec, key))) {
    writeRecord_(REG_SHEET, rec.userId, { shiftRequestedMonth: shiftMonthLabel_(key) });
    return true;
  }
  return false;
}

// ---- フォームの API ----

function shiftTargetRecord_(userId) {
  var rec = readRecord_(REG_SHEET, userId);
  if (!rec) throw new UserError('先にスタッフ登録を行ってください。');
  if (!isShiftTarget_(rec)) {
    throw new UserError('シフトの提出は、お仕事を始められる状態になってからご案内します。');
  }
  return rec;
}

/** フォームの初期表示：対象の月と、提出済みならその内容 */
function apiShiftMe_(userId, data) {
  var rec = shiftTargetRecord_(userId);
  var now = new Date();
  var requested = String(data.month || '');
  var key = shiftMonthAllowed_(requested, now) ? requested : defaultShiftMonth_(now);
  var ym = parseShiftMonth_(key);
  var existing = readShift_(userId, key);
  var values = {};
  if (existing) for (var d = 1; d <= 31; d++) values[d] = existing['d' + d] || '';
  return {
    ok: true,
    name: fullName_(rec),
    month: key,
    label: shiftMonthLabel_(key),
    year: ym.year,
    monthNumber: ym.month,
    // 今月分なら、今日より前の日は変更できない
    firstEditableDay: key === shiftMonthKey_(now) ? now.getDate() : 1,
    closedMonth: requested && requested !== key ? shiftMonthLabel_(requested) : '',
    submitted: !!existing,
    calendar: monthCalendar_(ym.year, ym.month),
    values: values,
    note: existing ? String(existing.note || '').replace(/^'/, '') : ''
  };
}

function apiShift_(userId, data) {
  var rec = shiftTargetRecord_(userId);
  var key = String(data.month || '');
  var existing = parseShiftMonth_(key) ? readShift_(userId, key) : null;
  var record = normalizeShift_(data, key, new Date(), existing);
  var now = now_();
  record.name = fullName_(rec);
  record.areas = rec.areas;
  record.updatedAt = now;
  if (!existing) record.submittedAt = now;
  writeShift_(userId, key, record);
  markShiftSummaryDirty_(key);
  return { ok: true, label: shiftMonthLabel_(key), availableDays: record.availableDays, isNew: !existing };
}

// ---- メニュー ----

function updateShiftSummaryNextMonth() {
  showShiftSummary_(nextShiftMonth_(new Date()));
}

function updateShiftSummaryThisMonth() {
  showShiftSummary_(shiftMonthKey_(new Date()));
}

function showShiftSummary_(key) {
  var sh = writeShiftSummary_(key);
  sh.activate();
}

/** 25日を待たずに、翌月分のシフト提出の案内を送る（まだ送っていない稼働可の人だけ） */
function sendShiftRequestsNow() {
  var ui = SpreadsheetApp.getUi();
  var key = nextShiftMonth_(new Date());
  var label = shiftMonthLabel_(key);
  var sh = sheet_(REG_SHEET);
  var header = headerMap_(sh);
  if (!hasShiftRequestColumn_(header)) return ui.alert('「' + REG_SHEET + '」シートに列が足りません。Apps Script エディタで setup を実行してください。');
  var rows = sh.getLastRow() < 2 ? [] : sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var targets = rows.map(function (v) { return rowToRecord_(REG_SHEET, header, v); }).filter(function (rec) {
    return isShiftTarget_(rec) && !rec.blocked && String(rec.shiftRequestedMonth || '') !== label;
  });
  if (!targets.length) {
    return ui.alert(label + 'のシフト提出の案内を送っていない「' + STATUS.ACTIVE + '」のスタッフはいません。');
  }
  var answer = ui.alert(label + 'のシフト提出の案内を送る',
    targets.map(fullName_).join('、') + '\n\nの ' + targets.length + ' 人に、今すぐ案内を送ります。よろしいですか？',
    ui.ButtonSet.OK_CANCEL);
  if (answer !== ui.Button.OK) return;
  var failed = targets.filter(function (rec) { return !sendShiftRequest_(rec, key); });
  ui.alert(failed.length
    ? '送れなかった人がいます：' + failed.map(fullName_).join('、') + '（ブロックされている可能性があります）'
    : '送信しました。「シフト提出の案内（送信済みの月）」列で確認できます。');
}
