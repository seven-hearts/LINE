/**
 * 案件の取り込みと LINE 配信（シート・LINE・AI とのやりとり）。
 * 読み取りに使う AI は Gemini（無料枠あり）か Claude。スクリプト プロパティで切り替える（getConfig_ の aiProvider）。
 * 判定や文面は Jobs.gs、画面は JobImport.html / JobSend.html。
 *
 * - メニュー「セブンハーツ > 案件を取り込む」：依頼文を貼り付け → AI が読み取り → 確認・修正 → 「案件一覧」に追加
 * - メニュー「セブンハーツ > 案件をLINEで配信」：案件を選ぶ → 条件に合うスタッフに一斉送信（応募ボタン付き）
 * - スタッフが応募ボタンを押す → 「案件応募」に追加（onJobPostback_）
 * - 「案件応募」の状態を「確定」「見送り」にする → 本人に LINE で連絡（onApplyEdit_）
 */

var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
var ANTHROPIC_VERSION = '2023-06-01';
// 安全上の理由で断られたときに、別のモデルで自動でやり直す
var ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** 「案件一覧」などのシートを用意する（setup から呼ぶ。何度実行しても安全） */
function setupJobSheets_(ss) {
  migrateWorkColumn_(ss.getSheetByName(JOB_SHEET));
  migrateJobColumns_(ss.getSheetByName(JOB_SHEET));
  var jobs = ensureSheet_(ss, JOB_SHEET);
  migrateApplyColumns_(ss.getSheetByName(APPLY_SHEET));
  ensureSheet_(ss, APPLY_SHEET);
  ensureSheet_(ss, IMPORT_SHEET);

  var h = headerMap_(jobs);
  var rows = jobs.getMaxRows() - 1;
  var col = function (label) { return jobs.getRange(2, h[label] + 1, rows, 1); };
  ['単価', '売上', '交通費', '食費', '総支払額'].forEach(function (l) { col(l).setNumberFormat('¥#,##0'); });
  ['休憩時間', '実働時間'].forEach(function (l) { col(l).setNumberFormat('0.##'); });
  col('請求書').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(INVOICE_OPTIONS, true).build());
  col('募集状況').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList([RECRUIT.OPEN, RECRUIT.CLOSED], true).build());
  col('ポジション').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(ROLES, true).build());
  col('単位').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(UNITS, true).build());
  applyPartnerValidation_(ss);

  var apply = ss.getSheetByName(APPLY_SHEET);
  var statusValues = Object.keys(APPLY_STATUS).map(function (k) { return APPLY_STATUS[k]; });
  var workValues = Object.keys(WORK_STATUS).map(function (k) { return WORK_STATUS[k]; });
  apply.getRange(2, headerMap_(apply)['勤務ステータス'] + 1, apply.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(workValues, true).setAllowInvalid(false).build());
  apply.getRange(2, headerMap_(apply)['状態'] + 1, apply.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(statusValues, true).setAllowInvalid(false).build());
  var ah = headerMap_(apply);
  var acol = function (label) { return apply.getRange(2, ah[label] + 1, apply.getMaxRows() - 1, 1); };
  ['交通費（往復）', '単価', '給与額'].forEach(function (l) { acol(l).setNumberFormat('¥#,##0'); });
  ['休憩時間', '実働時間'].forEach(function (l) { acol(l).setNumberFormat('0.##'); });
  acol('給与形態').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(UNITS, true).build());
  fillApplyPayTerms_();
}

/**
 * 以前の「案件一覧」を今の列の形にする（何度実行しても安全）。
 * - 「服装　持ち物」→「服装」と「持ち物」に分ける
 * - 「現場連絡先」→「集合担当者名」と「集合担当連絡先」に分ける
 * - 「支払い」の列を消す
 */
function migrateJobColumns_(sh) {
  if (!sh || !sh.getLastColumn()) return;
  splitColumn_(sh, '服装　持ち物', '服装', '持ち物', function (v) {
    var d = splitDress_(v);
    return [d.dress, d.belongings];
  });
  splitColumn_(sh, '現場連絡先', '集合担当者名', '集合担当連絡先', function (v) {
    var c = splitContact_(v);
    return [c.name, c.phone];
  });
  var header = headerMap_(sh);
  if (header['支払い'] !== undefined) sh.deleteColumn(header['支払い'] + 1);
  // 「確定人数」を「応募人数」のすぐ右に足す
  header = headerMap_(sh);
  if (header['応募人数'] !== undefined && header['確定人数'] === undefined) {
    var col = header['応募人数'] + 1;
    sh.insertColumnAfter(col);
    if (sh.getMaxRows() > 1) sh.getRange(2, col + 1, sh.getMaxRows() - 1, 1).clearDataValidations();
    sh.getRange(1, col + 1, 1, 1).setValues([['確定人数']]);
  }
}

/** 「案件一覧」の応募人数・確定人数を「案件応募」から数え直す（変わった行だけ書く） */
function recountSlots_() {
  var jobs = readAll_(JOB_SHEET).map(function (x) { x.rec._row = x.row; return x.rec; });
  var apps = readAll_(APPLY_SHEET).map(function (x) { return x.rec; });
  slotCountChanges_(jobs, apps).forEach(function (c) { updateCells_(JOB_SHEET, c.row, c.fields); });
}

/** 見出し oldLabel の列を、newLabel とその右隣の nextLabel の2列に分ける（split が値を2つに分ける） */
function splitColumn_(sh, oldLabel, newLabel, nextLabel, split) {
  var header = headerMap_(sh);
  if (header[oldLabel] === undefined || header[nextLabel] !== undefined) return;
  if (newLabel !== oldLabel && header[newLabel] !== undefined) return;
  var col = header[oldLabel] + 1;
  sh.insertColumnAfter(col);
  // 入れた列は左の列の入力規則（選択肢）を引き継ぐため、いったん外す（setup で付け直す）
  if (sh.getMaxRows() > 1) sh.getRange(2, col + 1, sh.getMaxRows() - 1, 1).clearDataValidations();
  sh.getRange(1, col, 1, 2).setValues([[newLabel, nextLabel]]);
  var n = sh.getLastRow() - 1;
  if (n < 1) return;
  var values = sh.getRange(2, col, n, 1).getValues().map(function (r) { return split(str_(r[0])); });
  sh.getRange(2, col, n, 2).setValues(values);
}

/**
 * 以前の「案件一覧」（D列が「ポジション」で仕事内容が入っていたもの）を、
 * D列「仕事内容」＋その隣に新しい「ポジション」（D / AD / ST）の形にする。何度実行しても安全。
 */
function migrateWorkColumn_(sh) {
  if (!sh || !sh.getLastColumn()) return;
  var header = headerMap_(sh);
  if (header['仕事内容'] !== undefined || header['ポジション'] === undefined) return;
  var col = header['ポジション'] + 1;
  sh.getRange(1, col).setValue('仕事内容');
  sh.insertColumnAfter(col);
  sh.getRange(1, col + 1).setValue('ポジション');
  if (sh.getLastRow() >= 2) {
    var n = sh.getLastRow() - 1;
    // 入力済みの行は「ST」にしておく（違う人だけ担当者が直す）
    var titles = sh.getRange(2, header['タイトル'] + 1, n, 1).getValues();
    sh.getRange(2, col + 1, n, 1).setValues(titles.map(function (t) { return [t[0] ? DEFAULT_ROLE : '']; }));
  }
}

// ---- 取引先の選択肢（シート「取引先一覧」。Freee.gs の freeeLoadPartners で freee から読み込む） ----

/** 「取引先一覧」の取引先（まだ読み込んでいなければ空） */
function partnerList_() {
  var sh = spreadsheet_().getSheetByName(PARTNER_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  return readAll_(PARTNER_SHEET).map(function (x) { return x.rec; }).filter(function (p) { return str_(p.name); });
}

/** 「案件一覧」の取引先名を、「取引先一覧」から選ぶプルダウンにする（一覧にない名前は入れられない） */
function applyPartnerValidation_(ss) {
  var partners = ss.getSheetByName(PARTNER_SHEET);
  var jobs = ss.getSheetByName(JOB_SHEET);
  if (!partners || partners.getLastRow() < 2 || !jobs) return;
  var col = headerMap_(jobs)['取引先名'];
  if (col === undefined) return;
  jobs.getRange(2, col + 1, jobs.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(partners.getRange(2, 1, partners.getMaxRows() - 1, 1), true)
    .setAllowInvalid(false)
    .setHelpText('freee の取引先から選んでください（一覧はメニュー「freee の取引先を読み込む」で更新できます）')
    .build());
}

/** 「案件一覧」の取引先名を freee の書き方にそろえる。そろえた行数と、見つからなかった名前を返す */
function alignClientNames_(partners) {
  var fixed = 0, unknown = {};
  readAll_(JOB_SHEET).forEach(function (x) {
    var c = str_(x.rec.client);
    if (!c) return;
    var name = matchPartnerName_(partners, c);
    if (!name) unknown[c] = true;
    else if (name !== c) { updateCells_(JOB_SHEET, x.row, { client: name }); fixed++; }
  });
  return { fixed: fixed, unknown: Object.keys(unknown) };
}

function jobSheets_() {
  var ss = spreadsheet_();
  if (!ss.getSheetByName(JOB_SHEET) || !ss.getSheetByName(APPLY_SHEET) || !ss.getSheetByName(IMPORT_SHEET)) setupJobSheets_(ss);
}

// ---- シートの読み書き（行を見出し名で扱う） ----

/** シートの全行を { rec, row } で返す（row はシートの行番号） */
function readAll_(sheetName) {
  var sh = sheet_(sheetName);
  if (sh.getLastRow() < 2) return [];
  var header = headerMap_(sh);
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().map(function (v, i) {
    return { rec: rowToRecord_(sheetName, header, v), row: i + 2 };
  });
}

function appendRecords_(sheetName, recs) {
  if (!recs.length) return 0;
  var sh = sheet_(sheetName);
  var header = headerMap_(sh);
  var width = sh.getLastColumn();
  var values = recs.map(function (rec) {
    var v = new Array(width).fill('');
    Object.keys(rec).forEach(function (k) {
      var i = header[labelOf_(sheetName, k)];
      if (i !== undefined) v[i] = cellValue_(rec[k]);
    });
    return v;
  });
  var start = sh.getLastRow() + 1;
  var need = start + values.length - 1 - sh.getMaxRows();
  if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need); // 書式と入力規則は上の行から引き継がれる
  sh.getRange(start, 1, values.length, width).setValues(values);
  return start;
}

/** 指定した行の列だけを書き換える */
function updateCells_(sheetName, row, fields) {
  var sh = sheet_(sheetName);
  var header = headerMap_(sh);
  Object.keys(fields).forEach(function (k) {
    var i = header[labelOf_(sheetName, k)];
    if (i !== undefined) sh.getRange(row, i + 1).setValue(cellValue_(fields[k]));
  });
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new UserError('ただいま混み合っています。少し時間をおいて、もう一度お試しください。');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---- Claude ----

function claudeRequest_(cfg, system, text, instruction, schema, maxTokens, withFallback) {
  var body = {
    model: cfg.claudeModel,
    max_tokens: maxTokens,
    system: system,
    // 読み取りは単純な作業なので low。Apps Script の1回の通信（約60秒）に収まるようにする
    output_config: { effort: 'low', format: { type: 'json_schema', schema: schema } },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '<依頼文>\n' + text + '\n</依頼文>' },
        { type: 'text', text: instruction }
      ]
    }]
  };
  var headers = { 'x-api-key': cfg.anthropicApiKey, 'anthropic-version': ANTHROPIC_VERSION };
  if (withFallback) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = ANTHROPIC_FALLBACK_BETA;
  }
  return {
    url: ANTHROPIC_URL, method: 'post', contentType: 'application/json',
    headers: headers, payload: JSON.stringify(body), muteHttpExceptions: true
  };
}

/** Claude の応答 → { data } または { error, retry } */
function claudeResult_(res) {
  var code = res.getResponseCode();
  var body;
  try {
    body = JSON.parse(res.getContentText());
  } catch (e) {
    return { error: 'AIからの応答を読めませんでした（' + code + '）', retry: true };
  }
  if (code !== 200) {
    var msg = body && body.error && body.error.message || '';
    if (code === 401) return { error: 'Claude の APIキー（ANTHROPIC_API_KEY）が正しくありません' };
    if (code === 400 && /fallback/i.test(msg)) return { error: msg, noFallback: true };
    if (code === 429 || code >= 500) return { error: 'AIが混み合っています（' + code + '）', retry: true };
    return { error: 'AIでの読み取りに失敗しました（' + code + '）：' + msg };
  }
  if (body.stop_reason === 'refusal') return { error: 'AIがこの文章の読み取りを断りました。内容を確認してください' };
  if (body.stop_reason === 'max_tokens') return { error: '文章が長すぎて読み取りきれませんでした。案件を分けて貼り付けてください' };
  var block = (body.content || []).filter(function (b) { return b.type === 'text'; })[0];
  if (!block) return { error: 'AIからの応答が空でした', retry: true };
  try {
    return { data: JSON.parse(block.text) };
  } catch (e) {
    return { error: 'AIからの応答を読めませんでした', retry: true };
  }
}

/**
 * Claude に並列で問い合わせる。混雑などで失敗したものは1回だけやり直す。
 * @param {Array<{instruction: string, schema: Object, maxTokens: number}>} asks
 */
function askClaude_(text, asks) {
  var cfg = getConfig_();
  if (!cfg.anthropicApiKey) throw new Error('Claude の APIキーが未設定です。スクリプト プロパティ ANTHROPIC_API_KEY を設定してください（README参照）');
  var system = jobSystemPrompt_(new Date());
  var results = new Array(asks.length);
  var pending = asks.map(function (a, i) { return i; });
  var withFallback = true;

  for (var attempt = 0; attempt < 3 && pending.length; attempt++) {
    if (attempt > 0) Utilities.sleep(3000);
    var responses;
    try {
      responses = UrlFetchApp.fetchAll(pending.map(function (i) {
        return claudeRequest_(cfg, system, text, asks[i].instruction, asks[i].schema, asks[i].maxTokens, withFallback);
      }));
    } catch (err) {
      throw new Error('AIの応答に時間がかかりすぎました。案件をいくつかに分けて貼り付けてください（' + err.message + '）');
    }
    var next = [];
    responses.forEach(function (res, k) {
      var i = pending[k];
      var r = claudeResult_(res);
      results[i] = r;
      if (r.noFallback) withFallback = false;
      if (r.retry || r.noFallback) next.push(i);
    });
    pending = next;
  }
  results.forEach(function (r) { if (r.error) throw new Error(r.error); });
  return results.map(function (r) { return r.data; });
}

// ---- Gemini ----

var GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

function geminiRequest_(cfg, text, withSchema) {
  var instruction = jobAllPrompt_();
  var gen = { responseMimeType: 'application/json', maxOutputTokens: 32768 };
  if (withSchema) gen.responseJsonSchema = JOB_ALL_SCHEMA;
  else instruction += '\n\n次の JSON Schema に従った JSON だけを返してください：\n' + JSON.stringify(JOB_ALL_SCHEMA);
  return {
    url: GEMINI_URL + encodeURIComponent(cfg.geminiModel) + ':generateContent',
    options: {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-goog-api-key': cfg.geminiApiKey },
      payload: JSON.stringify({
        systemInstruction: { parts: [{ text: jobSystemPrompt_(new Date()) }] },
        contents: [{ role: 'user', parts: [{ text: '<依頼文>\n' + text + '\n</依頼文>' }, { text: instruction }] }],
        generationConfig: gen
      })
    }
  };
}

/** Gemini の応答 → { data } または { error, retry, waitMs, noSchema } */
function geminiResult_(res, model) {
  var code = res.getResponseCode();
  var body;
  try {
    body = JSON.parse(res.getContentText());
  } catch (e) {
    return { error: 'AIからの応答を読めませんでした（' + code + '）', retry: true };
  }
  if (code !== 200) {
    var err = (body && body.error) || {};
    var msg = err.message || '';
    if (/API key not valid|API_KEY_INVALID/i.test(msg + JSON.stringify(err.details || ''))) {
      return { error: 'Gemini の APIキー（GEMINI_API_KEY）が正しくありません' };
    }
    if (code === 400 && /response_?json_?schema|schema/i.test(msg)) return { error: msg, noSchema: true };
    if (code === 403) return { error: 'Gemini の APIキーに使う権限がありません（' + msg + '）' };
    if (code === 404) return { error: 'Gemini のモデル「' + model + '」が見つかりません。スクリプト プロパティ GEMINI_MODEL を確認してください', nextModel: true };
    if (code === 429) {
      if (/per ?day|PerDay|daily/i.test(msg + JSON.stringify(err.details || ''))) {
        return { error: 'Gemini の今日の無料枠を使い切りました。明日（日本時間の夕方ごろ）になると使えます（お急ぎの場合は README の「AIの切り替え」を参照）', nextModel: true };
      }
      // 1分あたりの上限：指定された時間だけ待ってやり直す
      var wait = 20000;
      (err.details || []).forEach(function (d) {
        var m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay || '');
        if (m) wait = Math.ceil(+m[1] * 1000);
      });
      return { error: 'Gemini の1分あたりの上限に達しました。1分ほど待ってからもう一度お試しください', retry: true, busy: true, waitMs: Math.min(wait, 50000) };
    }
    if (code >= 500) return { error: 'AIが混み合っています（' + code + '）', retry: true, busy: true };
    return { error: 'AIでの読み取りに失敗しました（' + code + '）：' + msg };
  }
  if (body.promptFeedback && body.promptFeedback.blockReason) return { error: 'AIがこの文章の読み取りを断りました。内容を確認してください' };
  var cand = body.candidates && body.candidates[0];
  if (!cand) return { error: 'AIからの応答が空でした', retry: true };
  if (cand.finishReason === 'MAX_TOKENS') return { error: '文章が長すぎて読み取りきれませんでした。案件を分けて貼り付けてください' };
  if (cand.finishReason && cand.finishReason !== 'STOP') return { error: 'AIがこの文章の読み取りを断りました（' + cand.finishReason + '）' };
  var text = ((cand.content && cand.content.parts) || []).filter(function (p) { return p.text && !p.thought; })
    .map(function (p) { return p.text; }).join('').trim()
    .replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try {
    return { data: JSON.parse(text) };
  } catch (e) {
    return { error: 'AIからの応答を読めませんでした', retry: true };
  }
}

/**
 * Gemini で依頼文の案件をすべて読む（1回の問い合わせ。無料枠は1日の回数が少ないため）。
 * - 混雑（503 など）・1分あたりの上限：待ってやり直す（5秒 → 15秒）
 * - それでも混雑・今日の無料枠を使い切った・モデルが見つからない：予備のモデル（GEMINI_FALLBACK_MODELS）に切り替える
 * - JSON Schema の指定を受け付けないモデルなら、指示文で形を伝える
 * @return {{data: Object, model: string}}
 */
function askGemini_(text) {
  var cfg = getConfig_();
  if (!cfg.geminiApiKey) throw new Error('Gemini の APIキーが未設定です。スクリプト プロパティ GEMINI_API_KEY を設定してください（README参照）');
  var models = [cfg.geminiModel].concat(cfg.geminiFallbackModels).filter(function (m, i, all) { return m && all.indexOf(m) === i; });
  var started = Date.now();
  var waits = [5000, 15000];
  var last = null;
  for (var mi = 0; mi < models.length; mi++) {
    var mcfg = Object.assign({}, cfg, { geminiModel: models[mi] });
    var withSchema = true;
    for (var attempt = 0; attempt <= waits.length; attempt++) {
      var req = geminiRequest_(mcfg, text, withSchema);
      var res;
      try {
        res = UrlFetchApp.fetch(req.url, req.options);
      } catch (err) {
        throw new Error('AIの応答に時間がかかりすぎました。案件をいくつかに分けて貼り付けてください（' + err.message + '）');
      }
      var r = geminiResult_(res, mcfg.geminiModel);
      if (r.data) return { data: r.data, model: mcfg.geminiModel };
      last = r;
      if (r.noSchema && withSchema) { withSchema = false; attempt--; continue; }
      if (r.nextModel) break;                 // 今日の無料枠を使い切った・モデルがない → 次のモデル
      if (!r.retry) throw new Error(r.error); // APIキーの誤り・断られた・長すぎる など
      // 画面の待ち時間が長くなりすぎないよう、合計4分を超えそうならやめる
      var wait = Math.max(r.waitMs || 0, waits[attempt] || 0);
      if (attempt === waits.length || Date.now() - started + wait > 4 * 60000) break;
      Utilities.sleep(wait);
    }
  }
  var e = new Error(last && last.busy
    ? 'Gemini（Google）が混み合っていて読み取れませんでした（' + last.error + '）。数分おいてから、もう一度「読み取る」を押してください'
    : (last ? last.error : 'AIでの読み取りに失敗しました'));
  e.busy = !!(last && (last.busy || last.nextModel));
  throw e;
}

// ---- 案件の取り込み（JobImport.html から呼ぶ） ----

function showJobImport() {
  jobSheets_();
  var html = HtmlService.createHtmlOutputFromFile('JobImport').setWidth(1100).setHeight(760);
  SpreadsheetApp.getUi().showModalDialog(html, '案件を取り込む');
}

/** 画面を開いたとき：これまでの取引先名（入力候補） */
function jobImportInit() {
  var partners = partnerList_();
  if (partners.length) return { clients: partners.map(function (p) { return str_(p.name); }), partnersOnly: true };
  var seen = {};
  readAll_(JOB_SHEET).forEach(function (x) { if (x.rec.client) seen[x.rec.client] = true; });
  return { clients: Object.keys(seen).sort(), partnersOnly: false };
}

/** 依頼文を読み取って、確認画面に出す案件の一覧を返す */
function parseJobText(text) {
  text = String(text || '').trim();
  if (!text) throw new Error('依頼文を貼り付けてください');
  if (text.length > 30000) throw new Error('文章が長すぎます。案件をいくつかに分けて貼り付けてください');

  var cfg = getConfig_();
  if (cfg.aiProvider === 'gemini') {
    var got;
    try {
      got = askGemini_(text);
    } catch (err) {
      // Gemini が混み合っている・無料枠を使い切ったときは、Claude の APIキーがあれば Claude で読む
      if (!err.busy || !cfg.anthropicApiKey) throw err;
      var viaClaude = parseWithClaude_(text);
      viaClaude.note = 'Gemini が混み合っていたため、Claude で読み取りました';
      return viaClaude;
    }
    var all = (got.data.cases || []).filter(function (c) { return c && typeof c === 'object'; });
    if (!all.length) throw new Error('案件を読み取れませんでした。日程や場所が書かれた依頼文か確認してください');
    return {
      cases: all.map(normalizeCase_),
      note: got.model !== cfg.geminiModel ? 'Gemini（' + cfg.geminiModel + '）が混み合っていた（または無料枠を使い切った）ため、' + got.model + ' で読み取りました' : ''
    };
  }
  return parseWithClaude_(text);
}

/** Claude で読む：案件を数えてから、案件ごとに並列で詳しく読む */
function parseWithClaude_(text) {
  // 1回目：どんな案件が含まれているか（短い応答なのですぐ終わる）
  var list = askClaude_(text, [{ instruction: jobListPrompt_(), schema: JOB_LIST_SCHEMA, maxTokens: 4000 }])[0];
  var labels = (list.cases || []).map(function (c) { return str_(c.label); }).filter(Boolean);
  if (!labels.length) throw new Error('案件を読み取れませんでした。日程や場所が書かれた依頼文か確認してください');
  if (labels.length > 20) throw new Error('案件が多すぎます（' + labels.length + '件）。20件以下に分けて貼り付けてください');

  // 2回目：案件ごとに並列で詳しく読む（1回で全部読むより速く、時間切れになりにくい）
  var details = askClaude_(text, labels.map(function (label) {
    return { instruction: jobDetailPrompt_(label, labels), schema: JOB_DETAIL_SCHEMA, maxTokens: 8000 };
  }));
  return { cases: details.map(normalizeCase_) };
}

/** 確認画面で「シートに追加」を押したとき */
function saveJobs(payload) {
  var cases = (payload && payload.cases) || [];
  var client = str_(payload && payload.client);
  if (!cases.length) throw new Error('追加する案件がありません');
  // freee の取引先を読み込んでいれば、その中から選んだ名前だけ受け付ける（請求書でエラーにならないように）
  var partners = partnerList_();
  if (partners.length) {
    var name = matchPartnerName_(partners, client);
    if (!name) throw new UserError(client ? '取引先「' + client + '」は freee に登録されていません。一覧から選んでください（freee に追加したら、メニュー「freee の取引先を読み込む」を実行してください）' : '取引先名を一覧から選んでください');
    client = name;
  }
  var importId = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyMMddHHmmss');
  if (!cases.some(function (c) { return (c.shifts || []).length; })) throw new Error('日程が1つもありません。日程を入れてから追加してください');

  var rows;
  var start = withLock_(function () {
    jobSheets_();
    // 案件ID は「2026-10-0001」：登録した月の通し番号（ロックの中で数えて、同時に取り込んでも重ならないように）
    var prefix = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM');
    var used = readAll_(JOB_SHEET).map(function (x) { return x.rec.caseId; });
    rows = jobRows_(cases, {
      client: client, importId: importId, paymentMonthsAfter: getConfig_().paymentMonthsAfter,
      caseIdPrefix: prefix, firstCaseNo: nextCaseNo_(used, prefix)
    });
    var first = appendRecords_(JOB_SHEET, rows);
    appendRecords_(IMPORT_SHEET, [{
      importId: importId, at: now_(), client: client || rows[0].client, cases: cases.length, rows: rows.length,
      text: String(payload.text || '').slice(0, 45000)
    }]);
    return first;
  });
  var sh = sheet_(JOB_SHEET);
  sh.activate();
  sh.setActiveRange(sh.getRange(start, 1, rows.length, sh.getLastColumn()));
  return { rows: rows.length, cases: cases.length };
}

// ---- LINE 配信（JobSend.html から呼ぶ） ----

function showJobSend() {
  jobSheets_();
  var html = HtmlService.createHtmlOutputFromFile('JobSend').setWidth(900).setHeight(760);
  SpreadsheetApp.getUi().showModalDialog(html, '案件をLINEで配信');
}

/** 募集中で、まだ始まっていない枠を案件IDごとにまとめる */
function openJobGroups_(now) {
  var groups = {};
  var order = [];
  readAll_(JOB_SHEET).forEach(function (x) {
    var r = x.rec;
    if (!r.slotId || !r.caseId) return;
    if (applyRejectReason_(r, {}, false, now)) return; // 募集終了・開始済み
    if (!groups[r.caseId]) { groups[r.caseId] = []; order.push(r.caseId); }
    r._row = x.row;
    groups[r.caseId].push(r);
  });
  return order.map(function (id) { return groups[id]; });
}

/** 画面を開いたとき：配信できる案件と、シートで選んでいた案件 */
function jobSendInit() {
  var now = new Date();
  var selected = {};
  var sh = SpreadsheetApp.getActiveSheet();
  if (sh && sh.getName() === JOB_SHEET) {
    var header = headerMap_(sh);
    var list = sh.getActiveRangeList();
    (list ? list.getRanges() : []).forEach(function (range) {
      if (range.getRow() < 2) return;
      sh.getRange(range.getRow(), header['案件ID'] + 1, range.getNumRows(), 1).getValues()
        .forEach(function (v) { if (v[0]) selected[v[0]] = true; });
    });
  }
  return {
    statuses: Object.keys(STATUS).map(function (k) { return STATUS[k]; }),
    defaultStatuses: [STATUS.ACTIVE],
    groups: openJobGroups_(now).map(function (rows) {
      var f = rows[0];
      return {
        caseId: f.caseId, title: f.title, client: f.client, place: f.place, area: areaOf_(f.prefecture),
        genderReq: f.genderReq, conditions: f.conditions, staffPay: f.staffPay, staffTransport: f.staffTransport,
        sentAt: f.sentAt ? String(f.sentAt) : '', selected: !!selected[f.caseId],
        slots: rows.map(function (r) {
          return { label: slotLabel_(r), headcount: r.headcount, applied: r.applied || 0 };
        })
      };
    })
  };
}

function selectedGroups_(caseIds) {
  var groups = openJobGroups_(new Date()).filter(function (rows) { return caseIds.indexOf(rows[0].caseId) >= 0; });
  if (!groups.length) throw new Error('配信する案件を選んでください（募集中で、まだ始まっていない日程のみ配信できます）');
  return groups;
}

function staffRecords_() {
  return readAll_(REG_SHEET).map(function (x) { return x.rec; });
}

/** 送信先の人数と一覧（送る前の確認。画面で1人ずつ選べるようにする） */
function jobSendPreview(req) {
  var groups = selectedGroups_(req.caseIds || []);
  var staff = staffRecords_();
  var buckets = jobBuckets_(staff, groups, req);
  var byId = {};
  staff.forEach(function (r) { byId[r.userId] = r; });
  var users = [];
  buckets.forEach(function (b) {
    b.userIds.forEach(function (id) {
      var r = byId[id];
      users.push({
        id: id,
        name: r.lastName + ' ' + r.firstName,
        kana: str_(r.lastNameKana) + ' ' + str_(r.firstNameKana),
        status: r.status, gender: r.gender, areas: str_(r.areas),
        cases: b.groups.map(function (rows) { return rows[0].title; })
      });
    });
  });
  return {
    count: users.length,
    users: users,
    perCase: groups.map(function (rows) {
      var n = 0;
      buckets.forEach(function (b) { if (b.groups.indexOf(rows) >= 0) n += b.userIds.length; });
      return { title: rows[0].title, count: n, filter: jobFilter_(rows, req) };
    })
  };
}

/** 一斉送信する。給与・交通費の表示はシートにも保存する */
function jobSend(req) {
  var edits = req.edits || {};
  // 先に表示内容をシートに保存してから、読み直して送る
  readAll_(JOB_SHEET).forEach(function (x) {
    var e = edits[x.rec.caseId];
    if (!e) return;
    if (str_(e.staffPay) !== str_(x.rec.staffPay) || str_(x.rec.staffTransport) !== STAFF_TRANSPORT) {
      updateCells_(JOB_SHEET, x.row, { staffPay: str_(e.staffPay), staffTransport: STAFF_TRANSPORT });
    }
  });
  var groups = selectedGroups_(req.caseIds || []);
  var noPay = groups.filter(function (rows) { return !str_(rows[0].staffPay); });
  if (noPay.length) throw new Error('スタッフ向け給与を入れてください：' + noPay.map(function (rows) { return rows[0].title; }).join('、'));
  // 画面で選んだ人だけに送る（条件に合う人の中から選ぶので、条件に合わない人には送らない）
  var buckets = restrictBuckets_(jobBuckets_(staffRecords_(), groups, req), req.userIds);
  if (!buckets.length) throw new Error('送信先のスタッフがいません。条件を変えるか、送る人にチェックを入れてください');

  // 同じ案件の組み合わせを受け取る人ごとにまとめて送る（エリア・性別の条件が案件ごとに違うため）
  var sent = 0, failed = 0, lastError = '';
  var sentPerCase = {};
  buckets.forEach(function (b) {
    var messages = jobMessages_(b.groups);
    for (var i = 0; i < b.userIds.length; i += MULTICAST_LIMIT) {
      var to = b.userIds.slice(i, i + MULTICAST_LIMIT);
      if (multicastMessage_(to, messages)) {
        sent += to.length;
        b.groups.forEach(function (rows) { sentPerCase[rows[0].caseId] = (sentPerCase[rows[0].caseId] || 0) + to.length; });
      } else {
        failed += to.length;
        logError_('案件の配信', '', new Error('LINE への送信に失敗しました（' + to.length + '人分）：' + lastLineError_));
        lastError = lastLineError_;
      }
    }
  });
  if (!sent) throw new Error('LINE への送信に失敗しました：' + (lastError || 'シート「エラーログ」と checkSettings を確認してください'));

  var at = now_();
  groups.forEach(function (rows) {
    var n = sentPerCase[rows[0].caseId];
    if (!n) return;
    rows.forEach(function (r) {
      updateCells_(JOB_SHEET, r._row, { sentAt: at, sentCount: (toNum_(r.sentCount) || 0) + n });
    });
  });
  return { sent: sent, failed: failed };
}

// ---- 応募（LINE の応募ボタン） ----

function findSlot_(slotId) {
  var all = readAll_(JOB_SHEET);
  for (var i = 0; i < all.length; i++) if (all[i].rec.slotId === slotId) return all[i];
  // 枠IDを振り直す前に送った応募ボタンなど
  for (var k = 0; k < all.length; k++) if (slotId && all[k].rec.oldSlotId === slotId) return all[k];
  return null;
}

/** メニュー「案件ID・枠IDを新しい形式にする」：以前の形式の ID を「2026-10-0001」「2026-10-0001-01」に振り直す */
function migrateJobIds() {
  var ui = SpreadsheetApp.getUi();
  var answer = ui.alert('案件ID・枠IDを新しい形式にする',
    '以前の形式の案件ID・枠ID（例：261006120000-1-1）を、「2026-10-0001」「2026-10-0001-01」の形式に振り直します。\n' +
    '「案件応募」の ID も合わせて変わります。もとの枠IDは「旧枠ID」の列に残すので、すでに送った応募ボタンもそのまま使えます。\n\nよろしいですか？',
    ui.ButtonSet.OK_CANCEL);
  if (answer !== ui.Button.OK) return;
  var n = withLock_(function () {
    jobSheets_();
    if (headerMap_(sheet_(JOB_SHEET))['旧枠ID'] === undefined) ensureSheet_(spreadsheet_(), JOB_SHEET);
    var jobs = readAll_(JOB_SHEET).map(function (x) { x.rec._row = x.row; return x.rec; });
    var apps = readAll_(APPLY_SHEET).map(function (x) { x.rec._row = x.row; return x.rec; });
    var m = jobIdMigration_(jobs, apps);
    m.jobs.forEach(function (f) { updateCells_(JOB_SHEET, f.row, { caseId: f.caseId, slotId: f.slotId, oldSlotId: f.oldSlotId }); });
    m.apps.forEach(function (f) { updateCells_(APPLY_SHEET, f.row, { caseId: f.caseId, slotId: f.slotId }); });
    return m.jobs.length;
  });
  ui.alert(n ? n + '行の ID を新しい形式にしました。' : '以前の形式の ID はありませんでした。');
}

function onJobPostback_(ev, userId, params) {
  if (params.job !== 'apply' || !params.s) return;
  var staff = readRecord_(REG_SHEET, userId);
  var reply = withLock_(function () {
    var slot = findSlot_(params.s);
    var apps = readAll_(APPLY_SHEET);
    var already = apps.some(function (x) {
      return x.rec.slotId === params.s && x.rec.userId === userId && x.rec.status !== APPLY_STATUS.CANCELLED;
    });
    var reason = applyRejectReason_(slot && slot.rec, staff, already, new Date());
    if (reason) return reason;

    var s = slot.rec;
    appendRecords_(APPLY_SHEET, [{
      appliedAt: now_(), status: APPLY_STATUS.APPLIED, slotId: s.slotId, caseId: s.caseId, title: s.title,
      date: s.date, start: s.start, end: s.end,
      payUnit: (staffPayTerms_(s.staffPay) || {}).unit || '', payRate: (staffPayTerms_(s.staffPay) || {}).rate || '',
      name: fullName_(staff), phone: staff.phone, userId: userId
    }]);
    var count = apps.filter(function (x) { return x.rec.slotId === s.slotId && x.rec.status !== APPLY_STATUS.CANCELLED; }).length + 1;
    updateCells_(JOB_SHEET, slot.row, { applied: count });
    return applyAcceptedText_(s);
  });
  replyMessage_(ev.replyToken, [textMessage_(reply)]);
  if (reply.indexOf('応募を受け付けました') === 0) notifyAdmin_('案件への応募', fullName_(staff));
}

/** 「案件応募」を編集したとき（onStatusEdit から）。実働時間・給与額を計算し、確定・見送りを本人に知らせる */
function onApplyEdit_(e) {
  var sh = e.range.getSheet();
  var header = headerMap_(sh);
  updateWorkPay_(sh, header, e.range);
  var statusCol = header['状態'] + 1;
  if (e.range.getColumn() > statusCol || e.range.getLastColumn() < statusCol) return;
  var firstRow = Math.max(e.range.getRow(), 2);
  var lastRow = e.range.getLastRow();
  if (lastRow < firstRow) return;
  var rows = sh.getRange(firstRow, 1, lastRow - firstRow + 1, sh.getLastColumn()).getValues();

  // 同じ人が同じ日にすでに確定していたら、確定を取り消して元に戻す（確定の連絡も送らない）
  var editedRows = rows.map(function (v, k) { return firstRow + k; });
  var blocked = {};
  var all = readAll_(APPLY_SHEET).map(function (x) { x.rec._row = x.row; return x.rec; });
  confirmConflicts_(all, editedRows).forEach(function (c) {
    var app = all.filter(function (a) { return a._row === c.row; })[0];
    var back = editedRows.length === 1 && e.oldValue && e.oldValue !== APPLY_STATUS.CONFIRMED ? e.oldValue : APPLY_STATUS.APPLIED;
    updateCells_(APPLY_SHEET, c.row, { status: back, adminMemo: appendMemo_(app.adminMemo, confirmConflictMemo_(c.other)) });
    blocked[c.row] = true;
    try {
      e.source.toast(app.name + ' さんは ' + confirmConflictMemo_(c.other) + '。', '確定できません', 15);
    } catch (err) {
      // 通知が出せなくても、管理メモには残る
    }
  });

  rows.forEach(function (values, k) {
    if (blocked[firstRow + k]) return;
    var app = rowToRecord_(APPLY_SHEET, header, values);
    if (!app.userId || app.notifiedAt) return;
    if (app.status !== APPLY_STATUS.CONFIRMED && app.status !== APPLY_STATUS.DECLINED) return;
    try {
      var text = app.status === APPLY_STATUS.CONFIRMED ? applyConfirmedText_(app) : applyDeclinedText_(app);
      if (pushMessage_(app.userId, [textMessage_(text)])) {
        updateCells_(APPLY_SHEET, firstRow + k, { notifiedAt: now_() });
      } else {
        updateCells_(APPLY_SHEET, firstRow + k, { adminMemo: appendMemo_(app.adminMemo, '連絡を送れませんでした：' + lastLineError_) });
      }
    } catch (err) {
      console.error('onApplyEdit failed', app.userId, err && err.stack || err);
      logError_('案件応募：' + app.status, app.userId, err);
    }
  });
  recountSlots_(); // 「案件一覧」の応募人数・確定人数
}

/** 勤務時間・休憩・給与形態・単価を編集した行の、実働時間と給与額を計算し直す */
function updateWorkPay_(sh, header, range) {
  if (header['給与額'] === undefined || header['実働時間'] === undefined) return;
  var from = range.getColumn(), to = range.getLastColumn();
  var touched = PAY_INPUT_LABELS.some(function (l) { return header[l] !== undefined && header[l] + 1 >= from && header[l] + 1 <= to; });
  if (!touched) return;
  var firstRow = Math.max(range.getRow(), 2), lastRow = range.getLastRow();
  if (lastRow < firstRow) return;
  var values = sh.getRange(firstRow, 1, lastRow - firstRow + 1, sh.getLastColumn()).getValues();
  values.forEach(function (v, k) {
    var r = workPay_(rowToRecord_(APPLY_SHEET, header, v));
    sh.getRange(firstRow + k, header['実働時間'] + 1).setValue(r.actualHours);
    sh.getRange(firstRow + k, header['給与額'] + 1).setValue(r.pay);
  });
}

/** setup から：給与形態・単価が空欄の応募に、「案件一覧」のスタッフ向け給与を入れる */
function fillApplyPayTerms_() {
  var slots = {};
  readAll_(JOB_SHEET).forEach(function (x) { if (x.rec.slotId) slots[x.rec.slotId] = x.rec; });
  readAll_(APPLY_SHEET).forEach(function (x) {
    var a = x.rec;
    if (str_(a.payUnit) || str_(a.payRate) || !slots[a.slotId]) return;
    var t = staffPayTerms_(slots[a.slotId].staffPay);
    if (t) updateCells_(APPLY_SHEET, x.row, { payUnit: t.unit, payRate: t.rate });
  });
}

// ---- 「案件応募」に手で追加する（ManualApply.html から呼ぶ） ----

function showManualApply() {
  jobSheets_();
  var html = HtmlService.createHtmlOutputFromFile('ManualApply').setWidth(760).setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, '案件応募に手動で追加');
}

/** 画面を開いたとき：選べる日程（2か月前〜）と、スタッフの一覧 */
function manualApplyInit() {
  withLock_(fixDuplicateSlotIds_);
  var now = new Date();
  var from = ymd_(new Date(now.getFullYear(), now.getMonth() - 2, now.getDate()));
  var slots = readAll_(JOB_SHEET).map(function (x) { return x.rec; }).filter(function (r) {
    var d = parseYmd_(r.date);
    return r.slotId && d && ymd_(d) >= from;
  }).sort(function (a, b) {
    var da = ymd_(parseYmd_(a.date)) + normalizeTime_(a.start), db = ymd_(parseYmd_(b.date)) + normalizeTime_(b.start);
    return da < db ? -1 : da > db ? 1 : 0;
  }).map(function (r) {
    return {
      slotId: r.slotId, label: slotLabel_(r) + ' ' + str_(r.title), client: str_(r.client), role: str_(r.role),
      headcount: toNum_(r.headcount), confirmed: toNum_(r.confirmed) || 0, past: ymd_(parseYmd_(r.date)) < ymd_(now)
    };
  });
  var staff = staffRecords_().filter(function (s) { return s.userId && s.lastName; }).map(function (s) {
    return { userId: s.userId, name: fullName_(s), kana: str_(s.lastNameKana) + ' ' + str_(s.firstNameKana), status: s.status, blocked: !!s.blocked };
  });
  // LINE 未登録の人を、取引先（freee から読み込んだ「取引先一覧」）から選べるように
  var partners = partnerList_().map(function (p) { return str_(p.name); });
  return { slots: slots, staff: staff, partners: partners, today: ymd_(now) };
}

/** 選んだ日程（複数可）に1人を追加する。追加できなかった日程は理由を返し、ほかの日程は追加する */
function manualApplyAdd(req) {
  req = req || {};
  var slotIds = (req.slotIds || (req.slotId ? [req.slotId] : [])).filter(Boolean);
  if (!slotIds.length) throw new UserError('日程を選んでください');
  var staff = req.userId ? readRecord_(REG_SHEET, req.userId) : null;
  if (req.userId && !staff) throw new UserError('選んだスタッフが「スタッフ登録」に見つかりません');
  var results = withLock_(function () {
    var jobs = readAll_(JOB_SHEET);
    var apps = readAll_(APPLY_SHEET).map(function (x) { return x.rec; });
    var out = slotIds.map(function (id) {
      var slot = null;
      for (var i = 0; i < jobs.length && !slot; i++) if (jobs[i].rec.slotId === id) slot = jobs[i];
      var label = slot ? slotLabel_(slot.rec) + ' ' + str_(slot.rec.title) : id;
      var error = manualApplyError_(apps, slot && slot.rec, staff, req);
      if (error) return { label: label, error: error };
      var rec = manualApplyRecord_(slot.rec, staff, req, now_());
      var row = appendRecords_(APPLY_SHEET, [rec]);
      apps.push(rec); // 同じ日に2つ確定にしないよう、続きの判定に入れる
      return { label: label, row: row, rec: rec };
    });
    recountSlots_(); // 「案件一覧」の応募人数・確定人数
    return out;
  });

  // 確定の連絡は、まとめて1回で送る（1回に5通まで）
  var added = results.filter(function (r) { return r.rec; });
  var notify = staff && req.notify && req.status === APPLY_STATUS.CONFIRMED && added.length;
  var sent = true;
  if (notify) {
    var texts = added.map(function (r) { return textMessage_(applyConfirmedText_(r.rec)); });
    for (var i = 0; i < texts.length; i += 5) {
      if (!pushMessage_(staff.userId, texts.slice(i, i + 5))) sent = false;
    }
    added.forEach(function (r) {
      updateCells_(APPLY_SHEET, r.row, sent ? { notifiedAt: now_() }
        : { notifiedAt: '連絡なし（手動で追加）', adminMemo: appendMemo_(r.rec.adminMemo, '確定の連絡を送れませんでした：' + lastLineError_) });
    });
  }
  var name = staff ? fullName_(staff) : str_(req.name);
  var lines = results.map(function (r) {
    return r.rec ? '✓ ' + r.label + '（' + r.row + '行目）' : '✗ ' + r.label + '：' + r.error;
  });
  return {
    ok: added.length,
    failed: results.length - added.length,
    text: name + ' さんを「' + req.status + '」で' + added.length + '件追加しました。' +
      (notify ? (sent ? 'LINE で確定の連絡を送りました。' : 'LINE の連絡は送れませんでした（管理メモを確認してください）。') : '') +
      '\n' + lines.join('\n')
  };
}

// ---- 詳細連絡（DetailSend.html から呼ぶ） ----

function showDetailSend() {
  jobSheets_();
  var html = HtmlService.createHtmlOutputFromFile('DetailSend').setWidth(1000).setHeight(780);
  SpreadsheetApp.getUi().showModalDialog(html, '確定した人に詳細連絡を送る');
}

/** 確定した応募を、案件ごと・スタッフごとにまとめる（日程が過ぎたものは除く） */
function confirmedByCase_(now) {
  var today = ymd_(now);
  var slots = {};
  readAll_(JOB_SHEET).forEach(function (x) { if (x.rec.slotId) slots[x.rec.slotId] = x.rec; });
  var cases = {};
  var order = [];
  readAll_(APPLY_SHEET).forEach(function (x) {
    var a = x.rec;
    a._row = x.row;
    if (a.status !== APPLY_STATUS.CONFIRMED || !a.userId || !slots[a.slotId]) return;
    var d = parseYmd_(a.date);
    if (d && ymd_(d) < today) return;
    if (!cases[a.caseId]) { cases[a.caseId] = { caseId: a.caseId, staff: {}, staffOrder: [] }; order.push(a.caseId); }
    var c = cases[a.caseId];
    if (!c.staff[a.userId]) { c.staff[a.userId] = { userId: a.userId, name: a.name, apps: [] }; c.staffOrder.push(a.userId); }
    c.staff[a.userId].apps.push(a);
  });
  return order.map(function (id) {
    var c = cases[id];
    c.staffList = c.staffOrder.map(function (u) {
      var s = c.staff[u];
      s.slots = s.apps.map(function (a) { return slots[a.slotId]; });
      return s;
    });
    c.first = c.staffList[0].slots[0];
    return c;
  });
}

/** 画面を開いたとき：送れる案件と、入力欄の初期値 */
function detailSendInit() {
  var selected = {};
  var sh = SpreadsheetApp.getActiveSheet();
  if (sh && sh.getName() === APPLY_SHEET) {
    var header = headerMap_(sh);
    (sh.getActiveRangeList() ? sh.getActiveRangeList().getRanges() : []).forEach(function (range) {
      if (range.getRow() < 2) return;
      sh.getRange(range.getRow(), header['案件ID'] + 1, range.getNumRows(), 1).getValues()
        .forEach(function (v) { if (v[0]) selected[v[0]] = true; });
    });
  }
  return {
    cases: confirmedByCase_(new Date()).map(function (c) {
      return {
        caseId: c.caseId, title: c.first.title, selected: !!selected[c.caseId], fields: detailDefaults_(c.first),
        staff: c.staffList.map(function (s) {
          var sent = s.apps.filter(function (a) { return a.detailSentAt; }).length === s.apps.length;
          return {
            userId: s.userId, name: s.name, dates: s.slots.map(jpDate_).join('・'), sent: sent,
            fare: s.apps[0].fare === '' ? '' : String(s.apps[0].fare), departure: String(s.apps[0].departure || '')
          };
        })
      };
    })
  };
}

function findConfirmedCase_(caseId) {
  var c = confirmedByCase_(new Date()).filter(function (x) { return x.caseId === caseId; })[0];
  if (!c) throw new Error('確定した人がいない案件です（「案件応募」で状態を「確定」にしてから送ってください）');
  return c;
}

/** 文面のプレビュー（選んだスタッフ、いなければ最初のスタッフの日程で） */
function detailPreview(req) {
  var c = findConfirmedCase_(req.caseId);
  var s = c.staffList.filter(function (x) { return x.userId === req.userId; })[0] || c.staffList[0];
  var images = (req.fields.images || []).slice(0, DETAIL_MAX_IMAGES);
  return {
    name: s.name, text: detailText_(req.fields, s.slots), request: travelRequestText_(str_(req.fields.title)),
    images: images.map(driveImageUrl_)
  };
}

/** 詳細連絡と、交通費・出発時間の返信のお願いを送る */
function detailSend(req) {
  var c = findConfirmedCase_(req.caseId);
  var ids = req.userIds || [];
  var targets = c.staffList.filter(function (s) { return ids.indexOf(s.userId) >= 0; });
  if (!targets.length) throw new Error('送る人を選んでください');
  var f = req.fields;
  if ((f.images || []).length > DETAIL_MAX_IMAGES) throw new Error('画像は' + DETAIL_MAX_IMAGES + '枚までです');

  // 集合場所などは「案件一覧」にも保存しておく（次に送るときの初期値になる）
  readAll_(JOB_SHEET).forEach(function (x) {
    if (x.rec.caseId !== c.caseId) return;
    var changes = {};
    var saved = { meetingPlace: str_(f.meetingPlace), meetingTime: str_(f.meetingTime),
      contactName: str_(f.contactName), contactPhone: str_(f.contactPhone), detailImages: (f.images || []).join(',') };
    Object.keys(saved).forEach(function (k) {
      if (saved[k] !== str_(x.rec[k])) changes[k] = saved[k];
    });
    if (Object.keys(changes).length) updateCells_(JOB_SHEET, x.row, changes);
  });

  var sent = [], failed = [];
  targets.forEach(function (s) {
    var ok = pushMessage_(s.userId, detailMessages_(f, s.slots));
    if (ok) {
      sent.push(s.name);
      // 送り直したときは、前の返信を消して、もう一度返信してもらう
      s.apps.forEach(function (a) {
        updateCells_(APPLY_SHEET, a._row, {
          workStatus: WORK_STATUS.DETAIL_SENT, detailSentAt: now_(), fare: '', departure: '', travelRepliedAt: '',
          departCheckSentAt: '', departAnswer: '', departAnsweredAt: '', departAlertAt: ''
        });
      });
    } else {
      failed.push(s.name + ' さん：' + (lastLineError_ || '理由はシート「エラーログ」を確認してください'));
      logError_('詳細連絡：' + s.name, s.userId, new Error(lastLineError_ || 'LINE への送信に失敗しました'));
    }
  });
  return { sent: sent, failed: failed };
}

/** 詳細連絡の画像を保存するドライブのフォルダ（提出書類とは別。中の画像は「リンクを知っている全員」が見られる） */
function detailImageFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('DETAIL_IMAGE_FOLDER_ID');
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (err) {
      // 消された場合は作り直す
    }
  }
  var folder = DriveApp.createFolder('セブンハーツ_詳細連絡の画像');
  props.setProperty('DETAIL_IMAGE_FOLDER_ID', folder.getId());
  return folder;
}

/** 画面で選んだ画像（画面で縮小済みの JPEG / PNG）をドライブに保存し、LINE で送れるようにする */
function uploadDetailImage(img) {
  var type = str_(img && img.mimeType);
  if (['image/jpeg', 'image/png'].indexOf(type) < 0) throw new Error('画像は JPEG か PNG にしてください');
  var bytes = Utilities.base64Decode(String(img.data || ''));
  if (bytes.length > 10 * 1024 * 1024) throw new Error('画像が大きすぎます（10MBまで）');
  var file = detailImageFolder_().createFile(Utilities.newBlob(bytes, type, str_(img.name) || 'image'));
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    file.setTrashed(true);
    throw new Error('画像を「リンクを知っている全員」に共有できませんでした。Google Workspace の管理者がリンクでの共有を禁止している可能性があります（' + err.message + '）');
  }
  return { id: file.getId(), url: driveImageUrl_(file.getId()) };
}

// ---- 交通費・出発時間の返信（Webhook の onText_ から） ----

/** 返信として受け付けたら true（返信を待っていない人や、読めない文章なら false で、担当者が手で対応する） */
function handleTravelReply_(ev, userId, text) {
  var r = parseTravelReply_(text);
  if (r.fare === null && !r.departure) return false;
  var reply = withLock_(function () {
    var apps = readAll_(APPLY_SHEET).map(function (x) { x.rec._row = x.row; return x.rec; });
    var groups = travelPending_(apps, userId, new Date());
    if (!groups.length) return '';
    var target = groups[0];
    var fare = r.fare !== null ? r.fare : toNum_(target[0].fare);
    var departure = r.departure || normalizeTime_(target[0].departure);
    target.forEach(function (a) {
      var f = {};
      if (fare !== null) f.fare = fare;
      if (departure) f.departure = departure;
      if (fare !== null && departure) f.travelRepliedAt = now_();
      // 出発時間がわかったら「出発時間確認済」（出発時間になると出発確認を送る）
      if (departure) f.workStatus = WORK_STATUS.DEPART_TIME_OK;
      updateCells_(APPLY_SHEET, a._row, f);
    });
    var done = fare !== null && departure;
    return travelReplyText_(target, fare, departure, done && groups[1] ? groups[1] : null);
  });
  if (!reply) return false;
  replyMessage_(ev.replyToken, [textMessage_(reply)]);
  return true;
}

// ---- 「案件応募」の列の移行・時間の同期・出発確認 ----

/** 以前の「案件応募」（G列「時間」に「08:30〜15:30」）を「開始時間」「終了時間」の2列にする */
function migrateApplyColumns_(sh) {
  if (!sh || !sh.getLastColumn()) return;
  splitColumn_(sh, '時間', '開始時間', '終了時間', function (v) {
    var p = v.split(/[〜~～-]/);
    return [normalizeTime_(p[0]), normalizeTime_(p[1] || '')];
  });
  // 「状態」に入っていた勤務の進み具合（詳細送付済など）を、隣の「勤務ステータス」に移す
  splitColumn_(sh, '状態', '状態', '勤務ステータス', function (v) {
    return applyStatusSplit_(v);
  });
  // 予定の時間と実際の時間を区別する：「開始時間」「終了時間」→「開始予定時間」「終了予定時間」
  [['開始時間', '開始予定時間'], ['終了時間', '終了予定時間']].forEach(function (p) {
    var h = headerMap_(sh);
    if (h[p[0]] !== undefined && h[p[1]] === undefined) sh.getRange(1, h[p[0]] + 1, 1, 1).setValues([[p[1]]]);
  });
  // 実際の勤務・給与の列を「終了予定時間」の右に足す
  var prev = '終了予定時間';
  APPLY_WORK_LABELS.forEach(function (label) {
    var h = headerMap_(sh);
    if (h[prev] === undefined) return;
    if (h[label] === undefined) {
      var col = h[prev] + 1;
      sh.insertColumnAfter(col);
      // 入れた列は左の列の入力規則・書式を引き継ぐため、いったん外す（setup で付け直す）
      if (sh.getMaxRows() > 1) sh.getRange(2, col + 1, sh.getMaxRows() - 1, 1).clearDataValidations();
      sh.getRange(1, col + 1, 1, 1).setValues([[label]]);
    }
    prev = label;
  });
}

/** 「案件応募」の日程・開始時間・終了時間を「案件一覧」に合わせる（案件一覧を編集したとき・1分ごと） */
function syncApplyTimes_() {
  var ss = spreadsheet_();
  if (!ss.getSheetByName(APPLY_SHEET) || !ss.getSheetByName(JOB_SHEET)) return;
  fixDuplicateSlotIds_();
  var slots = {};
  readAll_(JOB_SHEET).forEach(function (x) { if (x.rec.slotId) slots[x.rec.slotId] = x.rec; });
  var apps = readAll_(APPLY_SHEET).map(function (x) { x.rec._row = x.row; return x.rec; });
  applyTimeChanges_(apps, slots).forEach(function (c) { updateCells_(APPLY_SHEET, c.row, c.fields); });
  recountSlots_();
}

/** 行のコピーで同じになった枠IDを付け直す（「案件一覧」の編集時・1分ごと・手動追加の画面を開いたとき） */
function fixDuplicateSlotIds_() {
  var jobs = readAll_(JOB_SHEET).map(function (x) { x.rec._row = x.row; return x.rec; });
  var apps = readAll_(APPLY_SHEET).map(function (x) { x.rec._row = x.row; return x.rec; });
  var fixes = duplicateSlotFixes_(jobs, apps);
  fixes.jobs.forEach(function (f) { updateCells_(JOB_SHEET, f.row, { slotId: f.slotId }); });
  fixes.apps.forEach(function (f) { updateCells_(APPLY_SHEET, f.row, { slotId: f.slotId }); });
  return fixes.jobs.length;
}

/** 「案件一覧」を手で編集したとき（onStatusEdit から） */
function onJobSheetEdit_(e) {
  var header = headerMap_(e.range.getSheet());
  var cols = ['日程', '開始時間', '終了時間', '枠ID'].map(function (l) { return header[l] + 1; });
  var from = e.range.getColumn(), to = e.range.getLastColumn();
  if (!cols.some(function (c) { return c >= from && c <= to; })) return;
  syncApplyTimes_();
}

/** 1分ごと（runScheduler から）：時間の同期と出発確認 */
function runJobScheduler_(now) {
  var ss = spreadsheet_();
  var apply = ss.getSheetByName(APPLY_SHEET);
  if (!apply) return;
  var header = headerMap_(apply);
  // setup を実行し直していない（列がない）と送信の記録が残せず、1分ごとに送り続けてしまうため何もしない
  // 予定の時間の列名が以前のまま（setup 前）なら、ここで直す
  if (header['開始時間'] !== undefined && header['開始予定時間'] === undefined) {
    migrateApplyColumns_(apply);
    header = headerMap_(apply);
  }
  var needed = ['勤務ステータス', '開始予定時間', '出発確認の送信日時', '担当者への通知日時', '終了確認の送信日時', '終了報告の日時'];
  if (needed.some(function (l) { return header[l] === undefined; })) return;
  syncApplyTimes_();
  readAll_(APPLY_SHEET).forEach(function (x) {
    var app = x.rec;
    if (!app.userId) return;
    if (endCheckDue_(app, now)) {
      try {
        // 送れなかったときも記録して、1分ごとに送り直し続けないようにする
        var ok = pushMessage_(app.userId, [textMessage_(endCheckText_())]);
        var f = { endCheckSentAt: now_() };
        if (!ok) f.adminMemo = appendMemo_(app.adminMemo, '終了確認を送れませんでした：' + lastLineError_);
        updateCells_(APPLY_SHEET, x.row, f);
      } catch (err) {
        logError_('終了確認', app.userId, err);
      }
    }
    var action = departureAction_(app, now);
    if (!action) return;
    try {
      if (action === 'check') {
        if (pushMessage_(app.userId, [departureCheckMessage_(app)])) {
          updateCells_(APPLY_SHEET, x.row, { workStatus: WORK_STATUS.DEPART_CHECKING, departCheckSentAt: now_() });
        } else {
          updateCells_(APPLY_SHEET, x.row, { departCheckSentAt: now_(), adminMemo: appendMemo_(app.adminMemo, '出発確認を送れませんでした：' + lastLineError_) });
          sendDepartureAlert_(app, '出発確認を LINE で送れませんでした');
        }
      } else if (action === 'alert') {
        sendDepartureAlert_(app, '出発確認を送ってから' + DEPART_ALERT_MINUTES + '分たっても返信がありません');
        updateCells_(APPLY_SHEET, x.row, { departAlertAt: now_() });
      }
    } catch (err) {
      console.error('departure check failed', action, app.userId, err && err.stack || err);
      logError_('出発確認：' + action, app.userId, err);
    }
  });
}

/** 担当者（ADMIN_EMAIL）にメールで知らせる。未設定ならエラーログに残す */
function sendDepartureAlert_(app, reason) {
  var to = getConfig_().adminEmail;
  var mail = departureAlertMail_(app, reason, spreadsheet_().getUrl());
  if (!to) {
    logError_('出発確認（ADMIN_EMAIL が未設定のためメールを送れません）', app.userId, new Error(mail.subject));
    return;
  }
  MailApp.sendEmail(to, mail.subject, mail.body);
}

/** 出発確認への回答（ボタン「はい」「いいえ」、または「はい」「いいえ」と文字で送ったとき） */
function answerDeparture_(ev, userId, slotId, yes) {
  // 枠IDを振り直す前に送った出発確認のボタンでも答えられるように、今の枠IDに直す
  if (slotId) { var found = findSlot_(slotId); if (found) slotId = found.rec.slotId; }
  var result = withLock_(function () {
    var target = null;
    readAll_(APPLY_SHEET).forEach(function (x) {
      var a = x.rec;
      if (a.userId !== userId || a.status !== APPLY_STATUS.CONFIRMED || a.workStatus !== WORK_STATUS.DEPART_CHECKING) return;
      if (slotId && a.slotId !== slotId) return;
      a._row = x.row;
      // 文字で答えたときは、いちばん最近に確認を送ったものへの回答とみなす
      if (!target || str_(a.departCheckSentAt) > str_(target.departCheckSentAt)) target = a;
    });
    if (!target) return null;
    var fields = { departAnswer: yes ? 'はい' : 'いいえ', departAnsweredAt: now_() };
    if (yes) fields.workStatus = WORK_STATUS.DEPART_OK;
    updateCells_(APPLY_SHEET, target._row, fields);
    return target;
  });
  if (!result) return false;
  replyMessage_(ev.replyToken, [textMessage_(yes ? departureYesText_() : departureNoText_())]);
  if (!yes) {
    try {
      sendDepartureAlert_(result, '出発確認に「いいえ」と回答がありました');
      updateCells_(APPLY_SHEET, result._row, { departAlertAt: now_() });
    } catch (err) {
      logError_('出発確認：いいえ', userId, err);
    }
  }
  return true;
}

/** ボタンが押されたとき（Webhook の onPostback_ から） */
function onDeparturePostback_(ev, userId, params) {
  if (params.dep !== 'yes' && params.dep !== 'no') return;
  if (!answerDeparture_(ev, userId, params.s, params.dep === 'yes')) {
    replyMessage_(ev.replyToken, [textMessage_('ご回答ありがとうございます。')]);
  }
}

/** 終了確認への返信（Webhook の onText_ から）。終了報告として受け付けたら true */
function handleEndReport_(ev, userId, text) {
  var hit = withLock_(function () {
    var apps = readAll_(APPLY_SHEET).map(function (x) { x.rec._row = x.row; return x.rec; });
    var t = endReportTarget_(apps, userId, new Date());
    if (!t) return null;
    var report = t.mode === 'report' ? text : str_(t.app.endReport) + '\n' + text;
    var f = { endReport: report.slice(0, 2000) };
    if (t.mode === 'report') f.endReportAt = now_();
    updateCells_(APPLY_SHEET, t.app._row, f);
    return t;
  });
  if (!hit) return false;
  if (hit.mode === 'report') replyMessage_(ev.replyToken, [textMessage_(endThanksText_())]);
  return true;
}

/** 「はい」「いいえ」と文字で送ったとき。出発確認中でなければ false（ほかの処理・担当者の対応へ） */
function handleDepartureText_(ev, userId, text) {
  var m = /^\s*(はい|いいえ)[。！!、\s]*$/.exec(text);
  if (!m) return false;
  return answerDeparture_(ev, userId, '', m[1] === 'はい');
}

