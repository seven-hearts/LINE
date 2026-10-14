// スタッフマニュアルの閲覧数（gas/Manual.gs）・スタッフ用リッチメニュー（gas/RichMenu.gs）・
// 画像の変換（scripts/build-manual.js）の、シートや LINE に触れない部分を検証する: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
for (const f of ['Sheet.gs', 'Line.gs', 'Manual.gs', 'RichMenu.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
}
const build = require('../scripts/build-manual.js');

// vm の中で作った配列・オブジェクトを、assert.deepStrictEqual で比べられる形にする
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---- 閲覧の記録 ----

const VISITOR = 'abcdefgh12345678';

test('開いた記録を受け付ける（どこから開いたかを名前にする）', () => {
  const r = ctx.manualViewRecord_({ visitor: VISITOR, event: 'open', chapter: 0, total: 4, from: 'staffmenu' });
  assert.deepStrictEqual(plain(r), { visitor: VISITOR, event: '開いた', chapter: '', title: '', total: 4, from: 'スタッフ用リッチメニュー' });
  assert.strictEqual(ctx.manualViewRecord_({ visitor: VISITOR, event: 'open', total: 4 }).from, 'URLから直接');
  assert.strictEqual(ctx.manualViewRecord_({ visitor: VISITOR, event: 'open', total: 4, from: 'flyer' }).from, 'flyer');
});

test('章を読み終えた記録は章の番号と名前を残す', () => {
  const r = ctx.manualViewRecord_({ visitor: VISITOR, event: 'chapter', chapter: 2, title: ' 出勤前の準備\n', total: 4 });
  assert.strictEqual(r.event, '章を読み終えた');
  assert.strictEqual(r.chapter, 2);
  assert.strictEqual(r.title, '出勤前の準備');
});

test('おかしな記録は受け付けない', () => {
  const bad = [
    null,
    { visitor: 'short', event: 'open' },
    { visitor: VISITOR, event: 'delete' },
    { visitor: VISITOR, event: 'toString' },
    { visitor: VISITOR, event: 'chapter', chapter: 0 },
    { visitor: VISITOR, event: 'chapter', chapter: 1.5 },
    { visitor: VISITOR, event: 'chapter', chapter: 1000 },
    { visitor: VISITOR, event: 'open', total: -1 }
  ];
  bad.forEach((d) => assert.strictEqual(ctx.manualViewRecord_(d), null, JSON.stringify(d)));
  // 変な from は「URLから直接」として受け付ける
  assert.strictEqual(ctx.manualViewRecord_({ visitor: VISITOR, event: 'open', from: '<script>' }).from, 'URLから直接');
});

// ---- 集計 ----

function row(at, visitor, event, extra) {
  return Object.assign({ at: at, date: at.slice(0, 10), visitor: visitor, userId: '', name: '', event: event, chapter: '', title: '', total: 3, from: 'URLから直接' }, extra || {});
}
const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccc';

const rows = [
  // A さん：最初は URL から、そのあと同じ端末でスタッフ用リッチメニューから。全章を読む
  row('2026/10/01 10:00:00', A, '開いた'),
  row('2026/10/01 10:01:00', A, '章を読み終えた', { chapter: 1, title: 'はじめに' }),
  row('2026/10/12 09:00:00', A, '開いた', { userId: 'U-a', from: 'スタッフ用リッチメニュー' }),
  row('2026/10/12 09:02:00', A, '章を読み終えた', { userId: 'U-a', chapter: 2, title: '出勤前' }),
  row('2026/10/12 09:04:00', A, '章を読み終えた', { userId: 'U-a', chapter: 3, title: '現場で' }),
  // B さん：スタッフ用リッチメニューから。第1章だけ
  row('2026/10/13 20:00:00', B, '開いた', { userId: 'U-b', from: 'スタッフ用リッチメニュー' }),
  row('2026/10/13 20:01:00', B, '章を読み終えた', { userId: 'U-b', chapter: 1, title: 'はじめに' }),
  // だれかわからない人（応募者など）
  row('2026/10/14 08:00:00', C, '開いた'),
  row('2026/10/14 08:30:00', C, '開いた')
];
const staff = [
  { userId: 'U-a', name: '山田 花子', status: '稼働可' },
  { userId: 'U-b', name: '佐藤 次郎', status: '採用' },
  { userId: 'U-c', name: '鈴木 三郎', status: '稼働可' }
];

test('全体：同じ端末の LIFF でない記録も同じ人として数える', () => {
  const s = ctx.manualSummary_(rows, staff, '2026/10/14');
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.opens, 5);
  assert.strictEqual(s.viewers, 3); // A・B・C
  assert.strictEqual(s.opens7, 4);  // 10/08 以降
  assert.strictEqual(s.viewers7, 3);
  assert.strictEqual(s.finished, 1); // A さんだけ全章
});

test('章ごとに読み終えた人数と割合', () => {
  const s = ctx.manualSummary_(rows, staff, '2026/10/14');
  assert.deepStrictEqual(plain(s.chapters.map((c) => [c.no, c.title, c.readers])), [[1, 'はじめに', 2], [2, '出勤前', 1], [3, '現場で', 1]]);
  assert.strictEqual(Math.round(s.chapters[0].rate * 100), 67);
});

test('スタッフ別：最近読んだ順、まだ開いていない人は下', () => {
  const s = ctx.manualSummary_(rows, staff, '2026/10/14');
  assert.deepStrictEqual(plain(s.staff.map((r) => [r.name, r.opens, r.lastAt, r.read, r.finished])), [
    ['佐藤 次郎', 1, '2026/10/13 20:00:00', [1], false],
    ['山田 花子', 2, '2026/10/12 09:00:00', [1, 2, 3], true],
    ['鈴木 三郎', 0, '', [], false]
  ]);
});

test('開いた場所と日ごとの数', () => {
  const s = ctx.manualSummary_(rows, staff, '2026/10/14');
  assert.deepStrictEqual(plain(s.from), [{ from: 'URLから直接', opens: 3 }, { from: 'スタッフ用リッチメニュー', opens: 2 }]);
  assert.strictEqual(s.days.length, 30);
  assert.deepStrictEqual(plain(s.days[0]), { date: '2026/10/14', opens: 2, viewers: 1 });
  assert.deepStrictEqual(plain(s.days[1]), { date: '2026/10/13', opens: 1, viewers: 1 });
  assert.strictEqual(s.days[29].date, '2026/09/15');
});

test('記録がなくても集計の表を作れる', () => {
  const s = ctx.manualSummary_([], [], '2026/10/14');
  assert.strictEqual(s.opens, 0);
  assert.strictEqual(s.chapters.length, 0);
  const t = ctx.manualSummaryRows_(s, '2026/10/14 06:00:00');
  assert.ok(t.rows.every((r) => r.length === 6));
  assert.ok(t.rows.some((r) => r[0] === '（まだ記録がありません）'));
});

test('集計の表：章とスタッフの行', () => {
  const t = ctx.manualSummaryRows_(ctx.manualSummary_(rows, staff, '2026/10/14'), '2026/10/14 06:00:00');
  const find = (first) => t.rows.find((r) => r[0] === first);
  assert.deepStrictEqual(plain(find('第1章')), ['第1章', 'はじめに', 2, '67%', '', '']);
  assert.deepStrictEqual(plain(find('山田 花子')), ['山田 花子', '稼働可', 2, '2026/10/12 09:00:00', '第1章・第2章・第3章', '○']);
  assert.deepStrictEqual(plain(find('鈴木 三郎')), ['鈴木 三郎', '稼働可', 0, 'まだ開いていません', '', '']);
});

test('日付の計算は月をまたいでも正しい', () => {
  assert.strictEqual(ctx.manualDayBefore_('2026/03/01', 1), '2026/02/28');
  assert.strictEqual(ctx.manualDayBefore_('2026/01/01', 1), '2025/12/31');
  assert.strictEqual(ctx.manualDayBefore_('2026/10/14', 0), '2026/10/14');
});

// ---- スタッフ用リッチメニュー ----

const MANUAL = 'https://liff.line.me/1234567890-AbCdEfGh/manual/?from=staffmenu';

function settings(extra) {
  return ctx.richMenuSettings_(ctx.RICHMENU_DEFAULTS.concat(Object.entries(extra || {}).map(([k, v]) => [k, v, ''])));
}

test('初めの設定（大・3×2）でボタンを6等分する', () => {
  const def = ctx.richMenuDefinition_(settings(), { width: 2500, height: 1686 }, MANUAL);
  assert.deepStrictEqual(plain(def.errors), []);
  const m = def.menu;
  assert.deepStrictEqual(plain(m.size), { width: 2500, height: 1686 });
  assert.strictEqual(m.selected, true);
  assert.strictEqual(m.chatBarText, 'メニュー');
  assert.strictEqual(m.areas.length, 5); // ボタン6は空欄
  assert.deepStrictEqual(plain(m.areas[0]), { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: 'uri', label: 'マニュアル', uri: MANUAL } });
  assert.deepStrictEqual(plain(m.areas[1].bounds), { x: 833, y: 0, width: 834, height: 843 });
  assert.deepStrictEqual(plain(m.areas[1].action), { type: 'message', label: 'シフト', text: 'シフト' });
  assert.deepStrictEqual(plain(m.areas[3].bounds), { x: 0, y: 843, width: 833, height: 843 });
  // 端まですき間なく分かれている
  assert.strictEqual(m.areas[2].bounds.x + m.areas[2].bounds.width, 2500);
  assert.deepStrictEqual(plain(def.buttons), ['ボタン1：マニュアルを開く', 'ボタン2：「シフト」と送る', 'ボタン3：「登録状況」と送る', 'ボタン4：「変更」と送る', 'ボタン5：「書類」と送る']);
});

test('URL のボタン・最初は閉じておく・使われないボタンの注意', () => {
  const s = settings({ 'ボタン7': 'シフト' });
  s['横のボタンの数'] = 2;
  s['縦のボタンの数'] = 1;
  s['ボタン2'] = 'https://example.com/faq';
  s['最初から開く'] = 'いいえ';
  const def = ctx.richMenuDefinition_(s, { width: 2500, height: 843 }, MANUAL);
  assert.deepStrictEqual(plain(def.errors), []);
  assert.strictEqual(def.menu.selected, false);
  assert.deepStrictEqual(plain(def.menu.areas[1].action), { type: 'uri', label: 'ボタン2', uri: 'https://example.com/faq' });
  assert.ok(def.warnings.some((w) => /ボタン3は使われません/.test(w)));
  assert.ok(def.warnings.some((w) => /ボタン7は使われません/.test(w)));
});

test('画像や設定がおかしいときは理由を返す', () => {
  const e = (s, size) => ctx.richMenuDefinition_(s, size, MANUAL).errors.join('\n');
  assert.match(e(settings(), null), /画像の大きさを読み取れません/);
  assert.match(e(settings(), { width: 3000, height: 2000 }), /幅は800〜2500/);
  assert.match(e(settings(), { width: 1200, height: 1200 }), /縦に長すぎます/);
  const s = settings();
  s['横のボタンの数'] = 5;
  s['メニューの文字'] = 'とても長いメニューの文字です十五文字';
  assert.match(e(s, { width: 2500, height: 1686 }), /横のボタンの数/);
  assert.match(e(s, { width: 2500, height: 1686 }), /14文字以内/);
  const empty = settings();
  for (let i = 1; i <= 6; i++) empty['ボタン' + i] = '';
  assert.match(e(empty, { width: 2500, height: 1686 }), /ボタンが1つもありません/);
  const http = settings();
  http['ボタン2'] = 'http://example.com';
  assert.match(e(http, { width: 2500, height: 1686 }), /https:\/\//);
});

test('Google ドライブの URL からファイルIDを取り出す', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  assert.strictEqual(ctx.driveFileId_('https://drive.google.com/file/d/' + id + '/view?usp=sharing'), id);
  assert.strictEqual(ctx.driveFileId_('https://drive.google.com/open?id=' + id), id);
  assert.strictEqual(ctx.driveFileId_(' ' + id + ' '), id);
  assert.strictEqual(ctx.driveFileId_('画像.png'), '');
});

test('PNG・JPEG の画像の大きさを読む（Apps Script の符号付きの値でも）', () => {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(2500, 16);
  png.writeUInt32BE(1686, 20);
  const signed = Array.from(png).map((b) => (b > 127 ? b - 256 : b));
  assert.deepStrictEqual(plain(ctx.imageSize_(signed)), { width: 2500, height: 1686 });

  // SOI, APP0（長さ16）, SOF0（高さ843・幅2500）
  const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10].concat(new Array(14).fill(0))
    .concat([0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x4b, 0x09, 0xc4, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepStrictEqual(plain(ctx.imageSize_(jpeg)), { width: 2500, height: 843 });
  assert.strictEqual(ctx.imageSize_([0x47, 0x49, 0x46, 0x38]), null);
});

test('スタッフ用リッチメニューを表示するステータス', () => {
  assert.strictEqual(ctx.isStaffMenuTarget_({ userId: 'U1', status: '稼働可' }), true);
  assert.strictEqual(ctx.isStaffMenuTarget_({ userId: 'U1', status: '採用' }), true);
  assert.strictEqual(ctx.isStaffMenuTarget_({ userId: 'U1', status: '仮登録' }), false);
  assert.strictEqual(ctx.isStaffMenuTarget_({ userId: 'U1', status: '退会' }), false);
  assert.strictEqual(ctx.isStaffMenuTarget_(null), false);
});

// ---- 画像の変換（並び順） ----

test('章のフォルダ名から順番と名前を読む', () => {
  assert.deepStrictEqual(build.parseChapterDir('01_はじめに'), { order: 1, title: 'はじめに' });
  assert.deepStrictEqual(build.parseChapterDir('2 現場での動き'), { order: 2, title: '現場での動き' });
  assert.deepStrictEqual(build.parseChapterDir('10-困ったとき'), { order: 10, title: '困ったとき' });
  assert.deepStrictEqual(build.parseChapterDir('03'), { order: 3, title: '第3章' });
  assert.deepStrictEqual(build.parseChapterDir('おまけ'), { order: null, title: 'おまけ' });
});

test('章とページの並び：数字の順・下書きと画像以外は除く', () => {
  const plan = build.planChapters([
    { name: '10_おわりに', files: ['1.png'] },
    { name: '2_出勤前', files: ['10.png', '2.png', '1.PNG', 'メモ.txt'] },
    { name: '_下書き', files: ['1.png'] },
    { name: 'おまけ', files: ['1.jpg'] },
    { name: '1_はじめに', files: ['01.png'] },
    { name: '3_空', files: ['README.md'] }
  ]);
  assert.deepStrictEqual(plan.map((c) => c.title), ['はじめに', '出勤前', 'おわりに', 'おまけ']);
  assert.deepStrictEqual(plan[1].files, ['1.PNG', '2.png', '10.png']);
});
