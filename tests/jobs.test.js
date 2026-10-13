// 案件の取り込み・配信（gas/Jobs.gs）の計算と判定を Node で検証する: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
for (const f of ['Options.gs', 'Validation.gs', 'Line.gs', 'Sheet.gs', 'Interview.gs', 'Jobs.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
}
const plain = (x) => JSON.parse(JSON.stringify(x));

// Claude が返す形（JOB_DETAIL_SCHEMA）の例：依頼文の「①神戸港フォークリフト…」
const kobe = {
  client_name: '', title: '神戸港フォークリフト荷役技能向上大会', venue: 'メリケンパーク', prefecture: '兵庫県',
  address_access: '〒650-0042 兵庫県神戸市中央区波止場町２ 阪神本線元町駅から徒歩10分',
  position: 'イベント運営（受付・誘導・準備片付け）', conditions: '男女不問、40代前半まで', gender: '男女可',
  dress: '上：白カッターシャツ／下：黒パンツ、華美でないスニーカー', belongings: '筆記用具、メモ、腕時計',
  meeting_time: '', meeting_place: '', contact: '',
  pay_basis: '拘束時間', unit_price: 1600, min_hours: null,
  transport_fee: 660, transport_note: '阪神大阪梅田〜阪神元町 往復', meal_fee: null, meal_note: '支給あり予定',
  notes: '時間が前後する可能性あり',
  shifts: [{ date: '2026-10-08', holiday: false, start: '8:30', end: '15:30', break_minutes: null, headcount: 3, note: '' }]
};

// ⑥：4時間の勤務で5時間保証、食費なし
const kusatsu = Object.assign({}, kobe, {
  title: '子供向けイベント', venue: 'ABCハウジング草津住宅公園', prefecture: '滋賀県',
  min_hours: 5, transport_fee: 2240, meal_fee: null, meal_note: 'なし',
  shifts: [{ date: '2026-10-11', holiday: false, start: '08:30', end: '12:30', break_minutes: null, headcount: 2, note: '' }]
});

// ものづくりワールド：単価の記載なし、3日間 各日8名、休憩あり（例として60分）
const monozukuri = Object.assign({}, kobe, {
  title: 'ものづくりワールド', venue: 'インテックス大阪', prefecture: '大阪府', pay_basis: '記載なし', unit_price: null,
  transport_fee: null, meal_fee: null, meal_note: '昼食支給', meeting_time: '7:45', meeting_place: '西ゲート ロータリー側チケット売り場前',
  shifts: ['2026-10-09', '2026-10-07', '2026-10-08'].map((d) => ({ date: d, holiday: false, start: '8:00', end: '17:00', break_minutes: 60, headcount: 8, note: '' }))
});

const rowsOf = (cases, client) => plain(ctx.jobRows_(cases.map(ctx.normalizeCase_), { client: client || '〇〇企画', importId: '261006120000', paymentMonthsAfter: 1 }));

test('1日1行にして、曜日・時間・金額・計上月を計算する', () => {
  const [r] = rowsOf([kobe]);
  assert.strictEqual(r.client, '〇〇企画');
  assert.strictEqual(r.date, '2026/10/08');
  assert.strictEqual(r.weekday, '木');
  assert.strictEqual(r.start, '08:30');
  assert.strictEqual(r.end, '15:30');
  assert.strictEqual(r.payBasis, undefined); // 「支払い」の列はない（売上の計算にだけ使う）
  assert.strictEqual(r.unit, '時給');
  assert.strictEqual(r.unitPrice, 1600);
  assert.strictEqual(r.sales, 1600 * 7 * 3);          // 拘束7時間 × 3名
  assert.strictEqual(r.transport, 660);
  assert.strictEqual(r.meal, '支給あり予定');
  assert.strictEqual(r.total, 1600 * 7 * 3 + 660 * 3);
  assert.strictEqual(r.workHours, '');                 // 休憩がわからないので空欄
  assert.strictEqual(r.salesMonth, '2026/10');
  assert.strictEqual(r.paymentMonth, '2026/11');
  assert.strictEqual(r.invoice, '未');
  assert.strictEqual(r.dress, '上：白カッターシャツ／下：黒パンツ、華美でないスニーカー');
  assert.strictEqual(r.belongings, '筆記用具、メモ、腕時計');
  assert.strictEqual(r.contactName, '');
  assert.strictEqual(r.contactPhone, '');
  assert.strictEqual(r.staffTransport, '¥660（阪神大阪梅田〜阪神元町 往復）');
  assert.strictEqual(r.recruit, '募集中');
  assert.strictEqual(r.work, 'イベント運営（受付・誘導・準備片付け）');
  assert.strictEqual(r.role, 'ST');
  assert.strictEqual(r.position, undefined);
  assert.strictEqual(r.caseId, '261006120000-1');
  assert.strictEqual(r.slotId, '261006120000-1-1');
});

test('保証時間があれば、短い勤務でも保証時間で売上を計算する', () => {
  const [r] = rowsOf([kusatsu]);
  assert.strictEqual(r.sales, 1600 * 5 * 2);
  assert.strictEqual(r.total, 1600 * 5 * 2 + 2240 * 2);
  assert.match(r.notes, /5時間保証/);
  assert.strictEqual(r.meal, 'なし');
});

test('日程は日付順に並べ、単価がなければ売上は空欄', () => {
  const rows = rowsOf([monozukuri]);
  assert.deepStrictEqual(rows.map((r) => r.date + r.weekday), ['2026/10/07水', '2026/10/08木', '2026/10/09金']);
  assert.ok(rows.every((r) => r.breakHours === 1 && r.workHours === 8 && r.headcount === 8));
  assert.ok(rows.every((r) => r.sales === '' && r.total === '' && r.unit === ''));
  assert.strictEqual(rows[0].meetingTime, '7:45');
  assert.deepStrictEqual(rows.map((r) => r.slotId), ['261006120000-1-1', '261006120000-1-2', '261006120000-1-3']);
});

test('実働時間払い・食費の金額・祝日・日をまたぐ勤務', () => {
  const night = Object.assign({}, kobe, {
    pay_basis: '実働時間', meal_fee: 700, meal_note: '',
    shifts: [{ date: '2026-10-12', holiday: true, start: '22:00', end: '6:00', break_minutes: 60, headcount: 2, note: '' }]
  });
  const [r] = rowsOf([night]);
  assert.strictEqual(r.weekday, '月祝');
  assert.strictEqual(r.workHours, 7);
  assert.strictEqual(r.sales, 1600 * 7 * 2);
  assert.strictEqual(r.meal, 700);
  assert.strictEqual(r.total, 1600 * 7 * 2 + (660 + 700) * 2);
});

test('取引先名は依頼文から読めたものを優先、不正な日付は捨てる', () => {
  const c = Object.assign({}, kobe, { client_name: '株式会社サンプル', shifts: kobe.shifts.concat([{ date: '10月8日', holiday: false, start: '', end: '', break_minutes: null, headcount: null, note: '' }]) });
  const rows = rowsOf([c], '');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].client, '株式会社サンプル');
});

test('確認画面で直した値（文字の数値・「2026/10/08」形式）も計算できる', () => {
  const c = ctx.normalizeCase_(kobe);
  c.unitPrice = '1,700';
  c.shifts[0].headcount = '4';
  c.shifts[0].breakHours = '0.5';
  const [r] = plain(ctx.jobRows_([c], { client: 'A', importId: 'X', paymentMonthsAfter: 2 }));
  assert.strictEqual(r.unitPrice, 1700);
  assert.strictEqual(r.sales, 1700 * 7 * 4);
  assert.strictEqual(r.workHours, 6.5);
  assert.strictEqual(r.paymentMonth, '2026/12');
});

test('年をまたぐ入金予定月', () => {
  assert.strictEqual(ctx.addMonths_('2026/12', 1), '2027/01');
  assert.strictEqual(ctx.addMonths_('2026/11', 3), '2027/02');
  assert.strictEqual(ctx.addMonths_('', 1), '');
});

test('時刻の正規化', () => {
  assert.strictEqual(ctx.normalizeTime_('8:00'), '08:00');
  assert.strictEqual(ctx.normalizeTime_('１３：３０'), '13:30');
  assert.strictEqual(ctx.normalizeTime_('9時'), '09:00');
  assert.strictEqual(ctx.normalizeTime_('未定'), '');
});

// ---- 配信 ----

const staff = [
  { userId: 'U1', status: '稼働可', areas: '大阪、兵庫', gender: '女性', weekdays: '土、日', lastName: '山田', firstName: '花子' },
  { userId: 'U2', status: '稼働可', areas: '京都', gender: '男性', weekdays: '月、祝', lastName: '佐藤', firstName: '太郎' },
  { userId: 'U3', status: '稼働可', areas: '大阪', gender: '男性', weekdays: '木', lastName: '鈴木', firstName: '一郎' },
  { userId: 'U4', status: '書類提出済', areas: '大阪', gender: '女性', weekdays: '木', lastName: '高橋', firstName: '恵' },
  { userId: 'U5', status: '稼働可', areas: '大阪', gender: '女性', weekdays: '木', blocked: 'ブロック中', lastName: '田中', firstName: '愛' }
];

const osakaFemale = rowsOf([Object.assign({}, kobe, { prefecture: '大阪府', gender: '女性のみ' })]);
const kyoto = rowsOf([Object.assign({}, kobe, { prefecture: '京都府', shifts: [Object.assign({}, kobe.shifts[0], { date: '2026-10-12', holiday: true })] })]);
kyoto.forEach((r) => { r.caseId = 'K'; r.slotId = 'K-1'; });

test('送信先：ステータス・ブロック・エリア・性別で絞る', () => {
  const req = { statuses: ['稼働可'], matchArea: true, matchGender: true, matchWeekday: false };
  const ids = (rows, r) => ctx.jobTargets_(staff, ctx.jobFilter_(rows, r || req)).map((s) => s.userId);
  assert.deepStrictEqual(ids(osakaFemale), ['U1']);
  assert.deepStrictEqual(ids(osakaFemale, Object.assign({}, req, { matchGender: false })), ['U1', 'U3']);
  assert.deepStrictEqual(ids(osakaFemale, Object.assign({}, req, { statuses: ['稼働可', '書類提出済'] })), ['U1', 'U4']);
  assert.deepStrictEqual(ids(kyoto), ['U2']);
  assert.deepStrictEqual(ids(kyoto, Object.assign({}, req, { matchArea: false, matchWeekday: true })), ['U2']); // 「月祝」→ 祝に〇
});

test('送信先は、受け取る案件の組み合わせごとにまとめる', () => {
  const req = { statuses: ['稼働可'], matchArea: false, matchGender: true, matchWeekday: false };
  const buckets = ctx.jobBuckets_(staff, [osakaFemale, kyoto], req);
  const view = buckets.map((b) => ({ titles: b.groups.map((g) => g[0].prefecture), ids: Array.from(b.userIds) }));
  assert.deepStrictEqual(plain(view), [
    { titles: ['大阪府', '京都府'], ids: ['U1'] },
    { titles: ['京都府'], ids: ['U2', 'U3'] }
  ]);
});

test('LINE のメッセージは上限（ボタンの文字数・postback・カルーセル）に収まる', () => {
  const many = rowsOf([Object.assign({}, monozukuri, {
    shifts: Array.from({ length: 10 }, (_, i) => ({ date: '2026-11-' + String(i + 1).padStart(2, '0'), holiday: false, start: '13:30', end: '18:45', break_minutes: null, headcount: 1, note: '' }))
  })]);
  many.forEach((r) => { r.staffPay = '時給1,200円'; });
  const msgs = plain(ctx.jobMessages_([osakaFemale, many]));
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].contents.type, 'carousel');
  assert.strictEqual(msgs[0].contents.contents.length, 3); // 1 + (8 + 2)
  assert.ok(msgs[0].altText.length <= 400);
  const buttons = msgs[0].contents.contents.flatMap((b) => b.footer.contents);
  assert.strictEqual(buttons.length, 11);
  buttons.forEach((b) => {
    assert.ok(b.action.label.length <= 40, b.action.label);
    assert.ok(b.action.data.length <= 300);
    assert.match(b.action.data, /^job=apply&s=/);
  });
  assert.strictEqual(buttons[1].action.label, '11/1(日) 13:30〜18:45');
  const text = JSON.stringify(msgs);
  assert.match(text, /時給1,200円/);
  assert.doesNotMatch(text, /1600|1,600/); // 請求単価はスタッフに見せない
  assert.doesNotMatch(text, /40代/);      // 年齢の条件も載せない
  assert.match(text, /女性スタッフ/);
  assert.ok(Buffer.byteLength(JSON.stringify(msgs[0].contents)) < 50000);
});

test('空の項目は LINE のメッセージに入れない（空の text は送信エラーになる）', () => {
  const bare = rowsOf([{ shifts: [{ date: '2026-10-20', start: '', end: '' }] }]);
  const msgs = plain(ctx.jobMessages_([bare]));
  const texts = [];
  const walk = (o) => { if (o && typeof o === 'object') { if (o.type === 'text') texts.push(o.text); if (o.type === 'box') assert.ok(o.contents.length); Object.values(o).forEach(walk); } };
  walk(msgs);
  assert.ok(texts.every((t) => typeof t === 'string' && t.length > 0), JSON.stringify(texts));
  assert.strictEqual(msgs[0].contents.footer.contents[0].action.label, '10/20(火)');
});

test('応募を受け付けるかの判定', () => {
  const slot = osakaFemale[0];
  const before = new Date(2026, 9, 8, 8, 29);
  assert.strictEqual(ctx.applyRejectReason_(slot, { userId: 'U1' }, false, before), '');
  assert.match(ctx.applyRejectReason_(slot, null, false, before), /スタッフ登録が済んだ方/);
  assert.match(ctx.applyRejectReason_(null, { userId: 'U1' }, false, before), /見つかりません/);
  assert.match(ctx.applyRejectReason_(slot, { userId: 'U1' }, true, before), /すでに応募/);
  assert.match(ctx.applyRejectReason_(slot, { userId: 'U1' }, false, new Date(2026, 9, 8, 8, 30)), /締め切りました/);
  assert.match(ctx.applyRejectReason_(Object.assign({}, slot, { recruit: '募集終了' }), { userId: 'U1' }, false, before), /締め切りました/);
});

test('応募・確定・見送りの文面', () => {
  const slot = Object.assign({}, osakaFemale[0], { staffPay: '時給1,200円', meetingTime: '8:15', meetingPlace: '正面入口' });
  assert.match(ctx.applyAcceptedText_(slot), /^応募を受け付けました。/);
  const app = { name: '山田 花子', title: slot.title, date: '2026/10/08', time: '08:30〜15:30' };
  const ok = ctx.applyConfirmedText_(app);
  assert.match(ok, /確定しました/);
  assert.match(ok, /詳細は、後日このトークでお送りします/);
  assert.doesNotMatch(ok, /1600/);
  assert.match(ctx.applyDeclinedText_(app), /定員に達したため/);
});

test('Claude に渡すスキーマは structured outputs の形（すべての項目が必須・追加の項目なし）', () => {
  const check = (s) => {
    if (s.type === 'object') {
      assert.strictEqual(s.additionalProperties, false);
      assert.deepStrictEqual(Array.from(s.required).sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(check);
    }
    if (s.type === 'array') check(s.items);
  };
  check(plain(ctx.JOB_DETAIL_SCHEMA));
  check(plain(ctx.JOB_LIST_SCHEMA));
  assert.match(ctx.jobSystemPrompt_(new Date(2026, 9, 6)), /今日は 2026\/10\/06（火）/);
});

// ---- Claude の呼び出し（UrlFetchApp をまねて確認） ----

function claudeCtx(responder) {
  const calls = [];
  const c = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ANTHROPIC_API_KEY: 'sk-test' }) }) },
    Utilities: { sleep: () => {} },
    UrlFetchApp: {
      fetchAll: (reqs) => reqs.map((r) => {
        const body = JSON.parse(r.payload);
        calls.push({ headers: r.headers, body });
        const [code, json] = responder(body, calls.length);
        return { getResponseCode: () => code, getContentText: () => JSON.stringify(json) };
      })
    }
  });
  for (const f of ['Options.gs', 'Validation.gs', 'Line.gs', 'Sheet.gs', 'Interview.gs', 'Code.gs', 'Jobs.gs', 'JobsApp.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), c, { filename: f });
  }
  return { c, calls };
}

const okText = (obj) => [200, { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(obj) }] }];

test('依頼文の読み取り：案件を数えてから、案件ごとに並列で読む', () => {
  const { c, calls } = claudeCtx((body) => {
    const ask = body.messages[0].content[1].text;
    if (/すべて挙げて/.test(ask)) return okText({ cases: [{ label: '①神戸港' }, { label: '⑥草津' }] });
    return okText(/「⑥草津」/.test(ask) ? kusatsu : kobe);
  });
  const r = plain(c.parseJobText('依頼文'));
  assert.deepStrictEqual(r.cases.map((x) => x.place), ['メリケンパーク', 'ABCハウジング草津住宅公園']);
  assert.strictEqual(calls.length, 3);
  const b = calls[0].body;
  assert.strictEqual(b.model, 'claude-opus-5-5');
  assert.strictEqual(b.output_config.effort, 'low');
  assert.strictEqual(b.output_config.format.type, 'json_schema');
  assert.strictEqual(b.fallbacks, 'default');
  assert.strictEqual(calls[0].headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.strictEqual(b.thinking, undefined);
  assert.strictEqual(b.temperature, undefined);
});

test('読み取り：混雑（529）は待ってやり直し、fallbacks を受け付けないときは外してやり直す', () => {
  const { c, calls } = claudeCtx((body, n) => {
    if (n === 1) return [529, { error: { message: 'Overloaded' } }];
    if (n === 2) return [400, { error: { message: 'fallbacks: unsupported' } }];
    return okText({ cases: [] });
  });
  assert.throws(() => c.parseJobText('依頼文'), /案件を読み取れませんでした/);
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(calls[2].body.fallbacks, undefined);
});

test('読み取り：APIキーの誤り・断られた・長すぎる', () => {
  assert.throws(() => claudeCtx(() => [401, { error: { message: 'invalid x-api-key' } }]).c.parseJobText('x'), /APIキー/);
  assert.throws(() => claudeCtx(() => [200, { stop_reason: 'refusal', content: [] }]).c.parseJobText('x'), /断りました/);
  assert.throws(() => claudeCtx(() => [200, { stop_reason: 'max_tokens', content: [] }]).c.parseJobText('x'), /分けて/);
  assert.throws(() => claudeCtx(() => okText({})).c.parseJobText('   '), /貼り付けてください/);
});

// ---- Gemini（無料枠）での読み取り ----

function geminiCtx(responder, props) {
  const calls = [];
  const sleeps = [];
  const c = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => Object.assign({ GEMINI_API_KEY: 'g-test', ANTHROPIC_API_KEY: '' }, props) }) },
    Utilities: { sleep: (ms) => sleeps.push(ms) },
    UrlFetchApp: {
      fetch: (url, opt) => {
        assert.strictEqual(opt.url, undefined);
        const body = JSON.parse(opt.payload);
        calls.push({ url, headers: opt.headers, body });
        const [code, json] = responder(body, calls.length);
        return { getResponseCode: () => code, getContentText: () => JSON.stringify(json) };
      },
      fetchAll: () => { throw new Error('Gemini では fetchAll を使わない'); }
    }
  });
  for (const f of ['Options.gs', 'Validation.gs', 'Line.gs', 'Sheet.gs', 'Interview.gs', 'Code.gs', 'Jobs.gs', 'JobsApp.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), c, { filename: f });
  }
  return { c, calls, sleeps };
}

const gemOk = (obj, raw) => [200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '考え中', thought: true }, { text: raw || JSON.stringify(obj) }] } }] }];

test('使う AI：AI_PROVIDER がなければ APIキーが入っているほう', () => {
  const { c } = geminiCtx(() => gemOk({}));
  assert.strictEqual(c.aiProvider_({ GEMINI_API_KEY: 'x' }), 'gemini');
  assert.strictEqual(c.aiProvider_({ ANTHROPIC_API_KEY: 'x' }), 'claude');
  assert.strictEqual(c.aiProvider_({ GEMINI_API_KEY: 'x', AI_PROVIDER: 'Claude' }), 'claude');
  assert.strictEqual(c.aiProvider_({}), 'claude');
});

test('Gemini：1回の問い合わせですべての案件を読む', () => {
  const { c, calls } = geminiCtx(() => gemOk({ cases: [kobe, kusatsu] }));
  const r = plain(c.parseJobText('依頼文'));
  assert.deepStrictEqual(r.cases.map((x) => x.place), ['メリケンパーク', 'ABCハウジング草津住宅公園']);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent');
  assert.strictEqual(calls[0].headers['x-goog-api-key'], 'g-test');
  const b = calls[0].body;
  assert.strictEqual(b.generationConfig.responseMimeType, 'application/json');
  assert.ok(b.generationConfig.responseJsonSchema.properties.cases);
  assert.match(b.systemInstruction.parts[0].text, /セブンハーツ/);
  assert.match(b.contents[0].parts[0].text, /^<依頼文>/);
  assert.match(b.contents[0].parts[1].text, /すべて取り出して cases/);
});

test('Gemini：スキーマ指定を受け付けないモデルなら、指示文で形を伝えてやり直す', () => {
  const { c, calls } = geminiCtx((body, n) => n === 1
    ? [400, { error: { code: 400, message: 'Invalid JSON payload received. Unknown name "responseJsonSchema"', status: 'INVALID_ARGUMENT' } }]
    : gemOk(null, '```json\n' + JSON.stringify({ cases: [kobe] }) + '\n```'));
  assert.strictEqual(plain(c.parseJobText('x')).cases.length, 1);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].body.generationConfig.responseJsonSchema, undefined);
  assert.match(calls[1].body.contents[0].parts[1].text, /JSON Schema に従った/);
});

test('Gemini：1分あたりの上限は指定の時間待ってやり直し、1日の上限はすぐに知らせる', () => {
  const perMin = [429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 10',
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }] } }];
  const a = geminiCtx((b, n) => n === 1 ? perMin : gemOk({ cases: [kobe] }));
  assert.strictEqual(plain(a.c.parseJobText('x')).cases.length, 1);
  assert.deepStrictEqual(a.sleeps, [12000]);

  const perDay = [429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded',
    details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } }];
  const d = geminiCtx(() => perDay, { GEMINI_FALLBACK_MODELS: 'off' });
  assert.throws(() => d.c.parseJobText('x'), /今日の無料枠を使い切りました/);
  assert.strictEqual(d.calls.length, 1);
});

test('Gemini：APIキーの誤り・モデル名の誤り・断られた・長すぎる・未設定', () => {
  const bad = [400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }];
  assert.throws(() => geminiCtx(() => bad).c.parseJobText('x'), /GEMINI_API_KEY/);
  assert.throws(() => geminiCtx(() => [404, { error: { code: 404, message: 'models/x is not found' } }], { GEMINI_MODEL: 'x', GEMINI_FALLBACK_MODELS: 'off' }).c.parseJobText('x'), /モデル「x」/);
  assert.throws(() => geminiCtx(() => [200, { promptFeedback: { blockReason: 'SAFETY' } }]).c.parseJobText('x'), /断りました/);
  assert.throws(() => geminiCtx(() => [200, { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }]).c.parseJobText('x'), /分けて/);
  assert.throws(() => geminiCtx(() => gemOk({ cases: [] })).c.parseJobText('x'), /読み取れませんでした/);
  assert.throws(() => geminiCtx(() => gemOk({}), { GEMINI_API_KEY: '', AI_PROVIDER: 'gemini' }).c.parseJobText('x'), /GEMINI_API_KEY を設定/);
});

// ---- 詳細連絡と、交通費・出発時間の返信 ----

// 依頼の例（ロハスミーツ高槻）を「案件一覧」の行にしたもの
const lohas = [['2026/09/21', '月祝'], ['2026/09/22', '火祝']].map(([date, weekday], i) => ({
  title: 'ロハスミーツ高槻', work: 'お菓子ボウリングの運営', place: '安満遺跡公園',
  address: '〒569-0096 大阪府高槻市八丁畷町１２−３', date, weekday, start: '09:00', end: '17:30',
  notes: '時間が前後する可能性あり', meetingPlace: '安満遺跡公園東広場にある\nスターバックス コーヒー 高槻安満遺跡公園店前に',
  meetingTime: '開始10分前', contactName: '前田', contactPhone: '090-7873-8978', dress: '黒ズボン、華美でない上着、スニーカー', belongings: '筆記用具、メモ、腕時計',
  staffPay: '時給1180円', meal: 500, caseId: 'L-1', slotId: 'L-1-' + (i + 1)
}));

test('詳細連絡の文面（依頼の例と同じ形）', () => {
  const f = plain(ctx.detailDefaults_(lohas[0]));
  assert.strictEqual(f.pay, '時給1180円＋交通費');
  assert.strictEqual(f.meal, '500円支給');
  assert.strictEqual(f.dress, '黒ズボン、華美でない上着、スニーカー');
  assert.strictEqual(f.belongings, '筆記用具、メモ、腕時計');
  assert.strictEqual(f.place, '〒569-0096 大阪府高槻市八丁畷町１２−３　安満遺跡公園');
  assert.strictEqual(f.contactName, '前田');
  assert.strictEqual(f.contactPhone, '090-7873-8978');
  assert.deepStrictEqual(plain(f.images), []);
  assert.strictEqual(ctx.detailText_(f, lohas), [
    'ロハスミーツ高槻の詳細です。', '', '内容をよく読んで交通費と出発時間をお調べください。', '',
    '■タイトル', 'ロハスミーツ高槻', '',
    '■業務内容', 'お菓子ボウリングの運営', '',
    '■日程', '9月21日(月祝)・9月22日(火祝)', '',
    '■場所', '〒569-0096 大阪府高槻市八丁畷町１２−３　安満遺跡公園', '',
    '■時間', '9:00~17:30', '※多少前後する可能性があります。', '',
    '■集合場所', '安満遺跡公園東広場にある', 'スターバックス コーヒー 高槻安満遺跡公園店前に', '',
    '■集合時間', '開始10分前', '',
    '■集合担当：前田', '090-7873-8978', '',
    '■服装', '黒ズボン、華美でない上着、スニーカー', '',
    '■ギャランティ', '時給1180円＋交通費', '',
    '■昼食', '500円支給', '',
    '■持ち物', '筆記用具、メモ、腕時計'
  ].join('\n'));
  // 確定した日だけ・日によって時間が違えば日ごとに
  const one = ctx.detailText_(f, [lohas[1]]);
  assert.match(one, /■日程\n9月22日\(火祝\)\n/);
  const diff = ctx.detailText_(Object.assign({}, f, { timeNote: '' }), [lohas[0], Object.assign({}, lohas[1], { start: '08:00', end: '18:00' })]);
  assert.match(diff, /■時間\n9月21日\(月祝\) 9:00~17:30\n9月22日\(火祝\) 8:00~18:00\n\n/);
  // 空の項目は出さない
  assert.doesNotMatch(ctx.detailText_(Object.assign({}, f, { meal: '', contactName: '', contactPhone: '' }), lohas), /■昼食|■集合担当/);
  assert.match(ctx.detailText_(Object.assign({}, f, { contactName: '' }), lohas), /■集合担当\n090-7873-8978\n/);
  assert.match(ctx.travelRequestText_('ロハスミーツ高槻'), /「ロハスミーツ高槻」の交通費（往復）と出発時間/);
});

test('交通費と出発時間の返信を読む', () => {
  const p = (t) => plain(ctx.parseTravelReply_(t));
  assert.deepStrictEqual(p('交通費：1,060円\n出発時間：7:30'), { fare: 1060, departure: '07:30' });
  assert.deepStrictEqual(p('交通費(往復) ８４０円　出発時間 ６時４５分'), { fare: 840, departure: '06:45' });
  assert.deepStrictEqual(p('1060円です。7時半に出発します'), { fare: 1060, departure: '07:30' });
  assert.deepStrictEqual(p('往復1,320円、出発は8時'), { fare: 1320, departure: '08:00' });
  assert.deepStrictEqual(p('交通費は¥680です'), { fare: 680, departure: '' });
  assert.deepStrictEqual(p('出発時間：7:05'), { fare: null, departure: '07:05' });
  assert.deepStrictEqual(p('了解しました！よろしくお願いします'), { fare: null, departure: '' });
  assert.deepStrictEqual(p('明日は9時集合ですか？'), { fare: null, departure: '' });
});

test('返信を待っている応募：確定・詳細連絡済み・未返信・今日以降、日程の早い案件から', () => {
  const now = new Date(2026, 8, 20, 12, 0);
  const app = (o) => Object.assign({ userId: 'U1', status: '確定', workStatus: '詳細送付済', detailSentAt: '2026/09/19 10:00:00', fare: '', departure: '', title: 'ロハスミーツ高槻' }, o);
  const apps = [
    app({ caseId: 'B', date: '2026/09/25', title: '別の案件' }),
    app({ caseId: 'L', date: '2026/09/22' }),
    app({ caseId: 'L', date: '2026/09/21' }),
    app({ caseId: 'X', date: '2026/09/19' }),                    // 過ぎた
    app({ caseId: 'Y', date: '2026/09/23', detailSentAt: '' }),  // 詳細連絡をまだ送っていない
    app({ caseId: 'Z', date: '2026/09/23', status: '応募' }),
    app({ caseId: 'Q', date: '2026/09/23', workStatus: '' }),       // 詳細連絡をまだ送っていない状態
    app({ caseId: 'W', date: '2026/09/23', fare: 500, departure: '07:00' }), // 返信済み
    app({ caseId: 'V', date: '2026/09/23', userId: 'U2' })
  ];
  const groups = ctx.travelPending_(apps, 'U1', now);
  assert.deepStrictEqual(plain(groups.map((g) => g.map((a) => a.caseId + a.date))), [['L2026/09/21', 'L2026/09/22'], ['B2026/09/25']]);
  const text = ctx.travelReplyText_(groups[0], 1060, '07:30', groups[1]);
  assert.match(text, /「ロハスミーツ高槻」（9月21日\(月\)・9月22日\(火\)）の\n交通費（往復）：¥1,060\n出発時間：7:30/);
  assert.match(text, /続けて「別の案件」/);
  assert.match(ctx.travelReplyText_(groups[0], 1060, '', null), /出発時間も送ってください/);
  assert.match(ctx.travelReplyText_(groups[0], null, '07:30', null), /交通費（往復）も送ってください/);
});

test('返信をシート「案件応募」に書き込む（Webhook）', () => {
  const { c } = geminiCtx(() => gemOk({}));
  const header = c.COLUMNS[c.APPLY_SHEET].map((x) => x[1]);
  const rows = [
    { userId: 'U1', status: '確定', workStatus: '詳細送付済', caseId: 'L', slotId: 'L-1', title: 'ロハスミーツ高槻', date: '2099/09/21', detailSentAt: '2099/09/19 10:00:00', fare: '', departure: '' },
    { userId: 'U1', status: '確定', workStatus: '詳細送付済', caseId: 'L', slotId: 'L-2', title: 'ロハスミーツ高槻', date: '2099/09/22', detailSentAt: '2099/09/19 10:00:00', fare: '', departure: '' }
  ];
  const replies = [];
  Object.assign(c, { __rows: rows, __replies: replies });
  vm.runInContext(`
    readAll_ = function () { return __rows.map(function (r, i) { return { rec: Object.assign({}, r), row: i + 2 }; }); };
    updateCells_ = function (sheet, row, f) { Object.assign(__rows[row - 2], f); };
    withLock_ = function (fn) { return fn(); };
    replyMessage_ = function (t, m) { __replies.push(m[0].text); };
    now_ = function () { return '2099/09/20 09:00:00'; };
  `, c);
  assert.strictEqual(c.handleTravelReply_({ replyToken: 'r' }, 'U1', '交通費：1,060円'), true);
  assert.deepStrictEqual(rows.map((r) => [r.fare, r.departure, r.travelRepliedAt || '']), [[1060, '', ''], [1060, '', '']]);
  assert.deepStrictEqual(rows.map((r) => r.workStatus), ['詳細送付済', '詳細送付済']); // 交通費だけでは変わらない
  assert.match(replies[0], /出発時間も送ってください/);
  assert.strictEqual(c.handleTravelReply_({ replyToken: 'r' }, 'U1', '出発時間 7:30'), true);
  assert.deepStrictEqual(rows.map((r) => [r.fare, r.departure, r.travelRepliedAt]), [[1060, '07:30', '2099/09/20 09:00:00'], [1060, '07:30', '2099/09/20 09:00:00']]);
  assert.deepStrictEqual(rows.map((r) => r.workStatus), ['出発時間確認済', '出発時間確認済']);
  assert.match(replies[1], /受け付けました。ありがとうございます/);
  // 返信を待っていない人・関係ない文章は受け付けない（担当者が手で対応）
  assert.strictEqual(c.handleTravelReply_({ replyToken: 'r' }, 'U1', '交通費：900円'), false);
  assert.strictEqual(c.handleTravelReply_({ replyToken: 'r' }, 'U2', '交通費：900円'), false);
  assert.strictEqual(c.handleTravelReply_({ replyToken: 'r' }, 'U1', 'よろしくお願いします'), false);
  assert.strictEqual(replies.length, 2);
});

test('以前の「案件一覧」：D列「ポジション」→「仕事内容」にして、隣に新しい「ポジション」を入れる', () => {
  const { c } = geminiCtx(() => gemOk({}));
  const grid = [['取引先名', 'タイトル', '場所', 'ポジション', '日程'], ['A', 'パン祭り', 'X', '案内業務', '2026/10/08'], ['', '', '', '', '']];
  const sheet = {
    getLastColumn: () => grid[0].length,
    getLastRow: () => grid.filter((r) => r.some((v) => v !== '')).length,
    getRange: (r, col, nr, nc) => ({
      getValues: () => grid.slice(r - 1, r - 1 + (nr || 1)).map((row) => row.slice(col - 1, col - 1 + (nc || 1))),
      setValue: (v) => { grid[r - 1][col - 1] = v; },
      setValues: (vals) => vals.forEach((v, k) => { grid[r - 1 + k].splice(col - 1, v.length, ...v); })
    }),
    insertColumnAfter: (col) => grid.forEach((row) => row.splice(col, 0, ''))
  };
  c.migrateWorkColumn_(sheet);
  assert.deepStrictEqual(grid[0], ['取引先名', 'タイトル', '場所', '仕事内容', 'ポジション', '日程']);
  assert.deepStrictEqual(grid[1], ['A', 'パン祭り', 'X', '案内業務', 'ST', '2026/10/08']);
  c.migrateWorkColumn_(sheet); // 2回目は何もしない
  assert.strictEqual(grid[0].length, 6);
});

test('集合担当を名前と電話番号に分ける', () => {
  const sp = (t) => plain(ctx.splitContact_(t));
  assert.deepStrictEqual(sp('前田\n090-7873-8978'), { name: '前田', phone: '090-7873-8978' });
  assert.deepStrictEqual(sp('大岡（090-6757-3808）'), { name: '大岡', phone: '090-6757-3808' });
  assert.deepStrictEqual(sp('集合担当 山本 TEL：０８０－１２３４－５６７８'), { name: '集合担当 山本', phone: '080-1234-5678' });
  assert.deepStrictEqual(sp('前田'), { name: '前田', phone: '' });
  assert.deepStrictEqual(sp(''), { name: '', phone: '' });
  assert.strictEqual(ctx.joinContact_('前田', '090-7873-8978'), '前田 090-7873-8978');
  assert.strictEqual(ctx.joinContact_('', '090-7873-8978'), '090-7873-8978');
  // 保存した形からも元に戻せる
  assert.deepStrictEqual(sp(ctx.joinContact_('前田', '090-7873-8978')), { name: '前田', phone: '090-7873-8978' });
});

test('詳細連絡のメッセージ：本文 → 画像（3枚まで）→ 返信のお願い（LINE の上限5通以内）', () => {
  const f = Object.assign(plain(ctx.detailDefaults_(Object.assign({}, lohas[0], { detailImages: 'img1, img2,img3,img4' }))));
  assert.deepStrictEqual(f.images, ['img1', 'img2', 'img3', 'img4']);
  const msgs = plain(ctx.detailMessages_(f, lohas));
  assert.deepStrictEqual(msgs.map((m) => m.type), ['text', 'image', 'image', 'image', 'text']);
  assert.ok(msgs.length <= 5);
  assert.match(msgs[0].text, /^ロハスミーツ高槻の詳細です。/);
  assert.deepStrictEqual(msgs[1], { type: 'image', originalContentUrl: 'https://lh3.googleusercontent.com/d/img1', previewImageUrl: 'https://lh3.googleusercontent.com/d/img1' });
  assert.match(msgs[4].text, /^【ご返信のお願い】/);
  assert.deepStrictEqual(plain(ctx.detailMessages_(Object.assign({}, f, { images: [] }), lohas)).map((m) => m.type), ['text', 'text']);
});

test('依頼文の集合担当は、名前と連絡先に分けて「案件一覧」に入る', () => {
  const [r] = rowsOf([Object.assign({}, monozukuri, { contact: '大岡（090-6757-3808）' })]);
  assert.strictEqual(r.contactName, '大岡');
  assert.strictEqual(r.contactPhone, '090-6757-3808');
  assert.strictEqual(r.unit, '');
  const [k] = rowsOf([kobe]);
  assert.strictEqual(k.unit, '時給');
  const [d] = rowsOf([Object.assign({}, kobe, { pay_basis: '日給', unit_price: 12000 })]);
  assert.strictEqual(d.unit, '日給');
  assert.strictEqual(d.sales, 12000 * 3);
  assert.ok(plain(ctx.UNITS).includes('時給') && plain(ctx.UNITS).includes('日給'));
});

test('詳細連絡：以前の形（服装の列に持ち物も・連絡先が1つの欄）の行にも対応', () => {
  const old = Object.assign({}, lohas[0], { dress: '服装：黒ズボン\n持ち物：腕時計', belongings: '', contactName: '前田 090-7873-8978', contactPhone: '' });
  const f = plain(ctx.detailDefaults_(old));
  assert.deepStrictEqual([f.dress, f.belongings, f.contactName, f.contactPhone], ['黒ズボン', '腕時計', '前田', '090-7873-8978']);
});

test('以前の「案件一覧」の列を今の形にする：服装／持ち物、集合担当者名／連絡先、「支払い」を消す', () => {
  const { c } = geminiCtx(() => gemOk({}));
  const grid = [
    ['取引先名', 'タイトル', '服装　持ち物', '支払い', '単位', '現場連絡先', '備考'],
    ['A', 'パン祭り', '服装：白シャツ\n持ち物：腕時計', '拘束時間', '時給', '大岡（090-6757-3808）', 'x'],
    ['A', 'パン祭り', '', '', '時給', '', '']
  ];
  const sheet = {
    getLastColumn: () => grid[0].length,
    getLastRow: () => grid.length,
    getRange: (r, col, nr, nc) => ({
      getValues: () => grid.slice(r - 1, r - 1 + (nr || 1)).map((row) => row.slice(col - 1, col - 1 + (nc || 1))),
      setValue: (v) => { grid[r - 1][col - 1] = v; },
      setValues: (vals) => vals.forEach((v, k) => { grid[r - 1 + k].splice(col - 1, v.length, ...v); }),
      clearDataValidations: () => {}
    }),
    insertColumnAfter: (col) => grid.forEach((row) => row.splice(col, 0, '')),
    getMaxRows: () => grid.length,
    deleteColumn: (col) => grid.forEach((row) => row.splice(col - 1, 1))
  };
  c.migrateJobColumns_(sheet);
  assert.deepStrictEqual(grid[0], ['取引先名', 'タイトル', '服装', '持ち物', '単位', '集合担当者名', '集合担当連絡先', '備考']);
  assert.deepStrictEqual(grid[1], ['A', 'パン祭り', '白シャツ', '腕時計', '時給', '大岡', '090-6757-3808', 'x']);
  assert.deepStrictEqual(grid[2], ['A', 'パン祭り', '', '', '時給', '', '', '']);
  c.migrateJobColumns_(sheet); // 2回目は何もしない
  assert.strictEqual(grid[0].length, 8);
  // 今の列の並び（新しく作るシート）：服装・持ち物・単位が並び、「支払い」はない
  const labels = plain(c.COLUMNS[c.JOB_SHEET].map((x) => x[1]));
  assert.deepStrictEqual(labels.slice(11, 14), ['服装', '持ち物', '単位']);
  assert.ok(!labels.includes('支払い'));
  assert.strictEqual(labels[labels.indexOf('集合担当者名') + 1], '集合担当連絡先');
});

// ---- 出発確認 ----

const depApp = (o) => Object.assign({
  userId: 'U1', name: '山田 花子', phone: '090-1111-2222', title: 'ロハスミーツ高槻', slotId: 'L-1-1',
  date: '2026/10/21', start: '09:00', end: '17:30', departure: '07:30', status: '確定', workStatus: '出発時間確認済'
}, o);

test('出発確認：出発時間になったら送る（60分過ぎたら送らない）、10分返信がなければメール', () => {
  const t = (h, m, d) => new Date(2026, 9, d || 21, h, m);
  const act = (o, now) => ctx.departureAction_(depApp(o), now);
  assert.strictEqual(act({}, t(7, 29)), '');
  assert.strictEqual(act({}, t(7, 30)), 'check');
  assert.strictEqual(act({}, t(8, 29)), 'check');
  assert.strictEqual(act({}, t(8, 30)), '');
  assert.strictEqual(act({ departCheckSentAt: '2026/10/21 07:30:05' }, t(7, 31)), '');
  assert.strictEqual(act({ workStatus: '詳細送付済' }, t(7, 30)), '');
  assert.strictEqual(act({ status: '辞退' }, t(7, 30)), '');
  // 送ったあと
  const sent = { workStatus: '出発確認中', departCheckSentAt: '2026/10/21 07:30:05' };
  assert.strictEqual(act(sent, t(7, 39)), '');
  assert.strictEqual(act(sent, t(7, 41)), 'alert');
  assert.strictEqual(act(Object.assign({ departAlertAt: '2026/10/21 07:40:10' }, sent), t(7, 45)), '');
  assert.strictEqual(act(Object.assign({ departAnswer: 'いいえ' }, sent), t(7, 45)), '');
  assert.strictEqual(act(Object.assign({}, sent, { workStatus: '出発確認済', departAnswer: 'はい' }), t(7, 45)), '');
  // 開始より遅い出発時間は前日（深夜の勤務）
  const night = depApp({ date: '2026/10/22', start: '06:00', departure: '23:30' });
  assert.strictEqual(ctx.departureAt_(night).getDate(), 21);
  assert.strictEqual(ctx.departureAt_(depApp({ departure: '' })), null);
});

test('出発確認のメッセージ：決まった文面と「はい」「いいえ」のボタン', () => {
  const m = plain(ctx.departureCheckMessage_(depApp({})));
  assert.strictEqual(m.template.type, 'confirm');
  assert.strictEqual(m.template.text, 'おはようございます。出発時間になりました。\n\n予定通り出発しましたでしょうか？');
  assert.ok(m.template.text.length <= 240);
  assert.deepStrictEqual(m.template.actions.map((a) => [a.label, a.data, a.displayText]),
    [['はい', 'dep=yes&s=L-1-1', 'はい'], ['いいえ', 'dep=no&s=L-1-1', 'いいえ']]);
  const mail = ctx.departureAlertMail_(depApp({}), '返信がありません', 'https://sheet');
  assert.match(mail.subject, /出発確認：山田 花子 さん（返信がありません）/);
  assert.match(mail.body, /日程：2026\/10\/21 9:00〜17:30\n出発時間：7:30\n電話番号：090-1111-2222/);
});

test('「案件応募」の日程・開始時間・終了時間は「案件一覧」に合わせる', () => {
  const slots = { A: { date: '2026/10/21', start: '09:30', end: '18:00' }, B: { date: '2026/10/22', start: '09:00', end: '17:30' } };
  const apps = [
    { _row: 2, slotId: 'A', date: '2026/10/21', start: '09:00', end: '17:30' },
    { _row: 3, slotId: 'B', date: '2026/10/22', start: '9:00', end: '17:30' },
    { _row: 4, slotId: 'X', date: '2026/10/22', start: '', end: '' }
  ];
  assert.deepStrictEqual(plain(ctx.applyTimeChanges_(apps, slots)), [{ row: 2, fields: { start: '09:30', end: '18:00' } }]);
});

function applyFlowCtx(rows) {
  const { c } = geminiCtx(() => gemOk({}));
  const pushes = [], replies = [], mails = [];
  const header = {};
  c.COLUMNS[c.APPLY_SHEET].forEach((x, i) => { header[x[1]] = i; });
  Object.assign(c, { __rows: rows, __pushes: pushes, __replies: replies, __mails: mails, __header: header, __time: '2026/10/21 07:30:00' });
  vm.runInContext(`
    spreadsheet_ = function () { return { getSheetByName: function () { return {}; }, getUrl: function () { return 'https://sheet'; } }; };
    headerMap_ = function () { return __header; };
    readAll_ = function (sheet) {
      if (sheet === JOB_SHEET) return [];
      return __rows.map(function (r, i) { return { rec: Object.assign({}, r), row: i + 2 }; });
    };
    updateCells_ = function (sheet, row, f) { Object.assign(__rows[row - 2], f); };
    withLock_ = function (fn) { return fn(); };
    pushMessage_ = function (id, m) { __pushes.push([id, m]); return {}; };
    replyMessage_ = function (t, m) { __replies.push(m[0].text); };
    now_ = function () { return __time; };
    MailApp = { sendEmail: function (to, s, b) { __mails.push([to, s, b]); } };
  `, c);
  return { c, pushes, replies, mails };
}

test('出発確認の流れ：送る→「はい」で出発確認済／返信なしで10分後にメール／「いいえ」はすぐメール', () => {
  const rows = [depApp({}), depApp({ userId: 'U2', name: '佐藤 太郎', slotId: 'L-1-2' }), depApp({ userId: 'U3', name: '鈴木 一郎', slotId: 'L-1-3' })];
  const { c, pushes, replies, mails } = applyFlowCtx(rows);
  vm.runInContext("PropertiesService = { getScriptProperties: function () { return { getProperties: function () { return { ADMIN_EMAIL: 'boss@example.com' }; } }; } };", c);

  c.runJobScheduler_(new Date(2026, 9, 21, 7, 30));
  assert.strictEqual(pushes.length, 3);
  assert.strictEqual(pushes[0][1][0].template.type, 'confirm');
  assert.deepStrictEqual(rows.map((r) => r.workStatus), ['出発確認中', '出発確認中', '出発確認中']);
  c.runJobScheduler_(new Date(2026, 9, 21, 7, 31));
  assert.strictEqual(pushes.length, 3); // 2回は送らない

  // U1：ボタンで「はい」
  c.onDeparturePostback_({ replyToken: 'r' }, 'U1', { dep: 'yes', s: 'L-1-1' });
  assert.strictEqual(rows[0].workStatus, '出発確認済');
  assert.strictEqual(rows[0].departAnswer, 'はい');
  assert.match(replies[0], /お気をつけてお越しください/);

  // U2：文字で「いいえ」→ すぐメール
  assert.strictEqual(c.handleDepartureText_({ replyToken: 'r' }, 'U2', 'いいえ'), true);
  assert.strictEqual(rows[1].workStatus, '出発確認中');
  assert.strictEqual(rows[1].departAnswer, 'いいえ');
  assert.strictEqual(mails.length, 1);
  assert.match(mails[0][1], /佐藤 太郎 さん（出発確認に「いいえ」と回答がありました）/);
  assert.strictEqual(mails[0][0], 'boss@example.com');

  // U3：返信なし → 10分後に1回だけメール
  c.__time = '2026/10/21 07:40:00';
  c.runJobScheduler_(new Date(2026, 9, 21, 7, 39));
  assert.strictEqual(mails.length, 1);
  c.runJobScheduler_(new Date(2026, 9, 21, 7, 40));
  c.runJobScheduler_(new Date(2026, 9, 21, 7, 41));
  assert.strictEqual(mails.length, 2);
  assert.match(mails[1][1], /鈴木 一郎 さん（出発確認を送ってから10分たっても返信がありません）/);
  assert.match(mails[1][2], /電話番号：090-1111-2222/);

  // 出発確認中でない人の「はい」は受け付けない（ほかの処理・担当者の対応へ）
  assert.strictEqual(c.handleDepartureText_({ replyToken: 'r' }, 'U1', 'はい'), false);
  assert.strictEqual(c.handleDepartureText_({ replyToken: 'r' }, 'U3', 'はい、わかりました'), false);
});

test('「案件応募」の列がそろっていない（setup 前）ときは出発確認を送らない', () => {
  const rows = [depApp({})];
  const { c, pushes } = applyFlowCtx(rows);
  vm.runInContext("headerMap_ = function () { return { '状態': 1 }; };", c);
  c.runJobScheduler_(new Date(2026, 9, 21, 7, 30));
  assert.strictEqual(pushes.length, 0);
});

test('以前の「案件応募」：G列「時間」を「開始時間」「終了時間」に分ける', () => {
  const { c } = geminiCtx(() => gemOk({}));
  const grid = [['応募日時', '状態', '枠ID', '案件ID', 'タイトル', '日程', '時間', '氏名'],
    ['x', '出発確認済', 'A', 'a', 't', '2026/10/21', '08:30〜15:30', '山田'],
    ['x', '見送り', 'B', 'a', 't', '2026/10/21', '08:30〜15:30', '佐藤']];
  const sheet = {
    getLastColumn: () => grid[0].length,
    getLastRow: () => grid.length,
    getRange: (r, col, nr, nc) => ({
      getValues: () => grid.slice(r - 1, r - 1 + (nr || 1)).map((row) => row.slice(col - 1, col - 1 + (nc || 1))),
      setValues: (vals) => vals.forEach((v, k) => { grid[r - 1 + k].splice(col - 1, v.length, ...v); }),
      clearDataValidations: () => {}
    }),
    insertColumnAfter: (col) => grid.forEach((row) => row.splice(col, 0, '')),
    getMaxRows: () => grid.length
  };
  c.migrateApplyColumns_(sheet);
  assert.deepStrictEqual(grid[0], ['応募日時', '状態', '勤務ステータス', '枠ID', '案件ID', 'タイトル', '日程', '開始時間', '終了時間', '氏名']);
  assert.deepStrictEqual(grid[1], ['x', '確定', '出発確認済', 'A', 'a', 't', '2026/10/21', '08:30', '15:30', '山田']);
  assert.deepStrictEqual(grid[2].slice(1, 3), ['見送り', '']);
  c.migrateApplyColumns_(sheet); // 2回目は何もしない
  assert.strictEqual(grid[0].length, 10);
  // 選択肢：状態は4つ、勤務ステータスは8つ
  assert.deepStrictEqual(Object.values(plain(c.APPLY_STATUS)), ['応募', '確定', '見送り', '辞退']);
  assert.deepStrictEqual(Object.values(plain(c.WORK_STATUS)),
    ['詳細送付済', '出発時間確認済', '出発確認済', '出発確認中', '出勤', '遅刻', '連絡欠勤', '無断欠勤']);
  const labels = plain(c.COLUMNS[c.APPLY_SHEET].map((x) => x[1]));
  assert.deepStrictEqual(labels.slice(1, 3), ['状態', '勤務ステータス']); // B列・C列
});

test('詳細連絡を送ると「詳細送付済」になり、前の返信・出発確認は消える（送り直し）', () => {
  const rows = [
    { userId: 'U1', name: '山田 花子', status: '確定', caseId: 'L-1', slotId: 'L-1-1', title: 'ロハスミーツ高槻', date: '2099/09/21' },
    { userId: 'U2', name: '佐藤 太郎', status: '確定', workStatus: '出発時間確認済', caseId: 'L-1', slotId: 'L-1-1', title: 'ロハスミーツ高槻', date: '2099/09/21',
      detailSentAt: 'x', fare: 1060, departure: '07:30', travelRepliedAt: 'y' },
    { userId: 'U3', name: '鈴木 一郎', status: '見送り', caseId: 'L-1', slotId: 'L-1-1', title: 'ロハスミーツ高槻', date: '2099/09/21' }
  ];
  const { c, pushes } = applyFlowCtx(rows);
  const job = Object.assign({}, lohas[0], { date: '2099/09/21', slotId: 'L-1-1', caseId: 'L-1' });
  Object.assign(c, { __job: job });
  vm.runInContext(`
    var __readApply = readAll_;
    readAll_ = function (sheet) { return sheet === JOB_SHEET ? [{ rec: Object.assign({}, __job), row: 2 }] : __readApply(sheet); };
  `, c);
  vm.runInContext('SpreadsheetApp = { getActiveSheet: function () { return null; } };', c);
  const init = plain(c.detailSendInit());
  assert.deepStrictEqual(init.cases[0].staff.map((s) => s.name), ['山田 花子', '佐藤 太郎']); // 見送りは出ない
  const r = plain(c.detailSend({ caseId: 'L-1', userIds: ['U1', 'U2'], fields: init.cases[0].fields }));
  assert.deepStrictEqual(r.sent, ['山田 花子', '佐藤 太郎']);
  assert.strictEqual(pushes.length, 2);
  assert.deepStrictEqual(rows.map((x) => x.status), ['確定', '確定', '見送り']);
  assert.deepStrictEqual(rows.map((x) => x.workStatus || ''), ['詳細送付済', '詳細送付済', '']);
  assert.deepStrictEqual([rows[1].fare, rows[1].departure, rows[1].travelRepliedAt], ['', '', '']);
});

// ---- 終了確認 ----

test('終了確認：勤務終了予定時間に送る（確定・欠勤でない・60分以内・1回だけ）', () => {
  const t = (h, m, d) => new Date(2026, 9, d || 21, h, m);
  const due = (o, now) => ctx.endCheckDue_(depApp(o), now);
  assert.strictEqual(due({}, t(17, 29)), false);
  assert.strictEqual(due({}, t(17, 30)), true);
  assert.strictEqual(due({ workStatus: '出勤' }, t(17, 30)), true);
  assert.strictEqual(due({ workStatus: '' }, t(17, 30)), true);
  assert.strictEqual(due({}, t(18, 30)), false);
  assert.strictEqual(due({ endCheckSentAt: '2026/10/21 17:30:02' }, t(17, 31)), false);
  assert.strictEqual(due({ workStatus: '連絡欠勤' }, t(17, 30)), false);
  assert.strictEqual(due({ workStatus: '無断欠勤' }, t(17, 30)), false);
  assert.strictEqual(due({ status: '辞退' }, t(17, 30)), false);
  // 日をまたぐ勤務は翌日の終了時刻
  assert.strictEqual(due({ start: '22:00', end: '05:00' }, t(5, 0, 21)), false);
  assert.strictEqual(due({ start: '22:00', end: '05:00' }, t(5, 0, 22)), true);
  assert.strictEqual(ctx.endCheckText_(), 'お疲れ様です。勤務終了予定時間になりました。\n\n本日の業務開始時間、終了時間、休憩時間\nお弁当支給の有無、日払い希望かどうかを返信してください。');
  assert.strictEqual(ctx.endThanksText_(), '返信ありがとうございます。本日もご勤務お疲れ様でした。\n\nお気をつけておかえりください');
});

test('終了確認の流れ：送る→返信を「終了報告」に記録してお礼→続けて送ったものは足すだけ', () => {
  const rows = [
    depApp({ workStatus: '出勤' }),
    depApp({ userId: 'U2', name: '佐藤 太郎', slotId: 'L-1-2', workStatus: '無断欠勤' }),
    // 同じ人が別の案件の交通費の返信待ち（終了報告の「お弁当500円」を交通費と取り違えない）
    { userId: 'U1', status: '確定', workStatus: '詳細送付済', detailSentAt: 'x', caseId: 'B', slotId: 'B-1-1', title: '別の案件', date: '2099/01/01', fare: '', departure: '' }
  ];
  const { c, pushes, replies } = applyFlowCtx(rows);
  c.__time = '2026/10/21 17:30:00';
  c.runJobScheduler_(new Date(2026, 9, 21, 17, 30));
  assert.strictEqual(pushes.length, 1);
  assert.strictEqual(pushes[0][0], 'U1');
  assert.strictEqual(pushes[0][1][0].text, ctx.endCheckText_());
  assert.strictEqual(rows[0].endCheckSentAt, '2026/10/21 17:30:00');
  c.runJobScheduler_(new Date(2026, 9, 21, 17, 31));
  assert.strictEqual(pushes.length, 1);

  // 返信（テストの「今」は実際の日時なので、受付時間内になるよう送信日時を合わせる）
  const stamp = (d) => d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':00';
  rows[0].endCheckSentAt = stamp(new Date(Date.now() - 5 * 60000));
  c.__time = stamp(new Date());
  const ev = { replyToken: 'r' };
  assert.strictEqual(c.handleEndReport_(ev, 'U1', '開始9:00 終了17:30 休憩1時間\nお弁当500円支給あり'), true);
  assert.strictEqual(rows[0].endReport, '開始9:00 終了17:30 休憩1時間\nお弁当500円支給あり');
  assert.strictEqual(rows[0].endReportAt, c.__time);
  assert.deepStrictEqual(replies, [ctx.endThanksText_()]);
  assert.strictEqual(rows[2].fare, ''); // 交通費として読まれていない
  // 続けて送ったもの → 足すだけ（お礼は1回）
  assert.strictEqual(c.handleEndReport_(ev, 'U1', '日払い希望です'), true);
  assert.strictEqual(rows[0].endReport, '開始9:00 終了17:30 休憩1時間\nお弁当500円支給あり\n日払い希望です');
  assert.strictEqual(replies.length, 1);
  // 30分を過ぎたら終了報告としては受け付けない
  rows[0].endReportAt = stamp(new Date(Date.now() - 31 * 60000));
  assert.strictEqual(c.handleEndReport_(ev, 'U1', 'ありがとうございました'), false);
  // 終了確認を送っていない人
  assert.strictEqual(c.handleEndReport_(ev, 'U2', 'お疲れ様です'), false);
});

test('Webhook：終了報告は交通費の返信より先に受け付ける', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Webhook.gs'), 'utf8');
  const order = ['handleDepartureText_', 'handleEndReport_', 'handleTravelReply_'].map((f) => src.indexOf(f + '(ev'));
  assert.ok(order.every((i) => i > 0));
  assert.deepStrictEqual(order.slice().sort((a, b) => a - b), order);
});

test('LINE の送信エラーの理由を日本語で示す', () => {
  const e = (code, body) => ctx.lineErrorText_(code, JSON.stringify(body));
  assert.match(e(429, { message: 'You have reached your monthly limit.' }), /今月のメッセージ送信数の上限/);
  assert.match(e(429, { message: 'Too Many Requests' }), /混み合って/);
  assert.match(e(401, { message: 'Authentication failed' }), /チャネルアクセストークン/);
  assert.match(e(400, { message: 'The request body has 1 error(s)', details: [{ message: 'must be non-empty https url', property: 'messages[1].originalContentUrl' }] }), /画像を送れませんでした/);
  assert.match(e(400, { message: 'The request body has 1 error(s)', details: [{ message: 'Invalid to', property: 'to' }] }), /LINE ユーザーIDが正しくありません/);
  assert.match(e(400, { message: 'Failed to send messages' }), /LINE が受け付けませんでした（400：Failed to send messages）/);
  assert.doesNotMatch(e(400, { message: 'x', details: [{ message: 'size must be up to 5', property: 'messages' }] }), /ユーザーID/);
  assert.match(ctx.lineErrorText_(500, 'oops'), /500：oops/);
  // 実際に起きたエラー（画像のプレビューの項目名の誤り）
  assert.match(e(400, { message: 'The request body has 1 error(s)', details: [{ message: 'May not be empty', property: 'messages[1].previewImageUrl' }] }), /画像を送れませんでした/);
});

test('Gemini が混み合っている（503）：5秒・15秒待ってやり直し、だめなら予備のモデルで読む', () => {
  const busy = [503, { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } }];
  // 2回目のやり直しで成功
  const a = geminiCtx((b, n) => n < 3 ? busy : gemOk({ cases: [kobe] }));
  const ra = plain(a.c.parseJobText('x'));
  assert.strictEqual(ra.cases.length, 1);
  assert.strictEqual(ra.note, '');
  assert.deepStrictEqual(a.sleeps, [5000, 15000]);

  // 最初のモデルはずっと混雑 → 予備のモデル（gemini-flash-lite-latest）で読む
  const b = geminiCtx((body, n) => n <= 3 ? busy : gemOk({ cases: [kobe] }));
  const rb = plain(b.c.parseJobText('x'));
  assert.strictEqual(rb.cases.length, 1);
  assert.deepStrictEqual(b.calls.map((x) => x.url.replace(/.*models\//, '').replace(/:.*/, '')),
    ['gemini-flash-latest', 'gemini-flash-latest', 'gemini-flash-latest', 'gemini-flash-lite-latest']);
  assert.match(rb.note, /gemini-flash-lite-latest で読み取りました/);

  // すべて混雑 → わかりやすいメッセージ
  const c = geminiCtx(() => busy);
  assert.throws(() => c.c.parseJobText('x'), /Gemini（Google）が混み合っていて読み取れませんでした（AIが混み合っています（503））。数分おいてから/);
  assert.strictEqual(c.calls.length, 6);

  // 今日の無料枠を使い切った → 待たずに予備のモデルへ
  const perDay = [429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } }];
  const d = geminiCtx((body, n) => n === 1 ? perDay : gemOk({ cases: [kobe] }));
  assert.strictEqual(plain(d.c.parseJobText('x')).cases.length, 1);
  assert.deepStrictEqual(d.sleeps, []);

  // 予備のモデルの指定
  assert.deepStrictEqual(plain(d.c.geminiFallbackModels_('')), ['gemini-flash-lite-latest']);
  assert.deepStrictEqual(plain(d.c.geminiFallbackModels_('off')), []);
  assert.deepStrictEqual(plain(d.c.geminiFallbackModels_('gemini-2.5-flash, gemini-2.5-flash-lite')), ['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
});

test('Gemini がすべて混み合っていても、Claude の APIキーがあれば Claude で読む', () => {
  const busy = [503, { error: { code: 503, message: 'overloaded' } }];
  const { c } = geminiCtx(() => busy, { ANTHROPIC_API_KEY: 'sk-test' });
  const claudeCalls = [];
  c.UrlFetchApp.fetchAll = (reqs) => reqs.map((r) => {
    const body = JSON.parse(r.payload);
    claudeCalls.push(body);
    const ask = body.messages[0].content[1].text;
    const [code, json] = /すべて挙げて/.test(ask) ? okText({ cases: [{ label: '①神戸港' }] }) : okText(kobe);
    return { getResponseCode: () => code, getContentText: () => JSON.stringify(json) };
  });
  const r = plain(c.parseJobText('x'));
  assert.strictEqual(r.cases.length, 1);
  assert.match(r.note, /Claude で読み取りました/);
  assert.strictEqual(claudeCalls.length, 2);
  // APIキーの誤りなど、混雑以外のエラーでは Claude に切り替えない
  const bad = geminiCtx(() => [400, { error: { code: 400, message: 'API key not valid.' } }], { ANTHROPIC_API_KEY: 'sk-test' });
  assert.throws(() => bad.c.parseJobText('x'), /GEMINI_API_KEY/);
});
