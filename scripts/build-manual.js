#!/usr/bin/env node
/**
 * スタッフマニュアル（マンガ）の画像を、公開用に変換する: npm run build:manual
 *
 * 「マニュアル原稿/」の章ごとのフォルダにある画像（PNG / JPEG）を WebP に変換して小さくし、
 * 「liff/manual/pages/」と目次のデータ「liff/manual/manual.json」を作り直す。
 * GitHub に画像を入れると、GitHub Actions（.github/workflows/manual.yml）が自動でこれを実行する。
 *
 *   マニュアル原稿/01_はじめに/01.png, 02.png …  →  第1章「はじめに」
 *   マニュアル原稿/02_現場での動き/01.png …      →  第2章「現場での動き」
 *
 * - 章の順番はフォルダ名の先頭の数字、ページの順番はファイル名の数字の順
 * - フォルダ名の先頭が「_」のものは公開しない（下書き用）
 * - 変換後のファイル名には画像の内容から作った記号を付ける（画像を差し替えると名前が変わり、古い画像が表示され続けない）
 *
 * 使い方: node scripts/build-manual.js [原稿フォルダ] [出力フォルダ]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DEFAULT_SRC = path.join(ROOT, 'マニュアル原稿');
const DEFAULT_OUT = path.join(ROOT, 'liff', 'manual');

const MAX_WIDTH = 1080;   // これより大きい画像は縮める（スマホでは十分な大きさ）
const THUMB_WIDTH = 320;  // 目次に出す表紙の小さい画像
const QUALITY = 82;       // WebP の画質（0〜100）。マンガの線がつぶれない程度
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/** 「ファイル10」が「ファイル2」より後ろになるように、数字は数として比べる */
function naturalCompare(a, b) {
  return a.localeCompare(b, 'ja', { numeric: true, sensitivity: 'base' });
}

/** 「01_はじめに」→ { order: 1, title: 'はじめに' }。数字がなければ order は null */
function parseChapterDir(name) {
  const normalized = name.normalize('NFC');
  const m = /^\s*(\d+)\s*[_\-－ー.．、　\s]*(.*)$/.exec(normalized);
  if (!m) return { order: null, title: normalized.trim() };
  return { order: Number(m[1]), title: m[2].trim() || '第' + Number(m[1]) + '章' };
}

/** 公開するフォルダか（「_」「.」で始まるものは下書き・システム用として除く） */
function isPublishedDir(name) {
  return !/^[_.]/.test(name);
}

/**
 * 原稿フォルダの中身から、章とページの並びを決める（ファイルは読まない）。
 * @param {{name: string, files: string[]}[]} dirs
 * @return {{order: number|null, title: string, dir: string, files: string[]}[]}
 */
function planChapters(dirs) {
  return dirs
    .filter((d) => isPublishedDir(d.name))
    .map((d) => Object.assign({ dir: d.name, files: d.files.filter((f) => IMAGE_EXT.test(f)).sort(naturalCompare) }, parseChapterDir(d.name)))
    .filter((c) => c.files.length)
    .sort((a, b) => {
      if (a.order !== null && b.order !== null && a.order !== b.order) return a.order - b.order;
      if (a.order === null && b.order !== null) return 1;
      if (a.order !== null && b.order === null) return -1;
      return naturalCompare(a.dir, b.dir);
    });
}

function hashOf(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 10);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function listSource(src) {
  if (!fs.existsSync(src)) return [];
  return fs.readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, files: fs.readdirSync(path.join(src, e.name)).filter((f) => !f.startsWith('.')) }));
}

async function build(src, out) {
  // sharp（画像の変換）は、変換するときだけ読み込む（テストでは使わないため）
  const sharp = require('sharp');
  const plan = planChapters(listSource(src));
  const pagesDir = path.join(out, 'pages');
  const files = []; // [出力先, 中身]
  const chapters = [];

  for (let i = 0; i < plan.length; i++) {
    const c = plan[i];
    const id = 'ch' + pad(i + 1);
    const pages = [];
    let thumb = '';
    for (let j = 0; j < c.files.length; j++) {
      const input = fs.readFileSync(path.join(src, c.dir, c.files[j]));
      const hash = hashOf(input);
      let image;
      try {
        image = sharp(input).rotate();
        const meta = await image.metadata();
        if (meta.width > MAX_WIDTH) image = image.resize({ width: MAX_WIDTH });
      } catch (err) {
        throw new Error(`画像を読み込めませんでした：${c.dir}/${c.files[j]}（${err.message}）`);
      }
      const { data, info } = await image.webp({ quality: QUALITY, effort: 6 }).toBuffer({ resolveWithObject: true });
      const name = `${id}/${pad(j + 1)}-${hash}.webp`;
      files.push([name, data]);
      pages.push({ src: 'pages/' + name, width: info.width, height: info.height });

      if (j === 0) {
        const t = await sharp(input).rotate().resize({ width: THUMB_WIDTH }).webp({ quality: 75 }).toBuffer();
        const thumbName = `${id}/thumb-${hash}.webp`;
        files.push([thumbName, t]);
        thumb = 'pages/' + thumbName;
      }
    }
    chapters.push({ id: id, no: i + 1, title: c.title, thumb: thumb, pages: pages });
  }

  // すべて変換できてから、古いファイルを消して書き出す（途中で失敗しても公開中のものは壊さない）
  fs.rmSync(pagesDir, { recursive: true, force: true });
  for (const [name, data] of files) {
    fs.mkdirSync(path.dirname(path.join(pagesDir, name)), { recursive: true });
    fs.writeFileSync(path.join(pagesDir, name), data);
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'manual.json'), JSON.stringify({ chapters: chapters }, null, 2) + '\n');
  return chapters;
}

if (require.main === module) {
  const src = path.resolve(process.argv[2] || DEFAULT_SRC);
  const out = path.resolve(process.argv[3] || DEFAULT_OUT);
  build(src, out).then((chapters) => {
    if (!chapters.length) console.log('公開する画像がありません（' + path.relative(ROOT, src) + ' に章のフォルダを作って画像を入れてください）');
    chapters.forEach((c) => console.log(`第${c.no}章 ${c.title}：${c.pages.length}ページ`));
  }, (err) => {
    console.error('変換に失敗しました：' + err.message);
    process.exit(1);
  });
}

module.exports = { naturalCompare, parseChapterDir, isPublishedDir, planChapters };
