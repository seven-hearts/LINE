/*
 * スタッフマニュアル（縦スクロールのマンガ）
 *
 * - 目次と章の並びは manual.json（scripts/build-manual.js が「マニュアル原稿」の画像から作る）
 * - 前回読んだところを端末に覚えておき、「前回の続きから読む」で戻れる
 * - 閲覧数を Apps Script に送る（シート「マニュアル閲覧」「マニュアル集計」）。
 *   LINE のアプリで LIFF の URL（スタッフ用リッチメニュー）から開いたときは、だれが読んだかも記録する。
 *   記録に失敗しても、マンガはそのまま読める。
 */
(function () {
  'use strict';

  var VISITOR_KEY = 'sevenhearts_manual_visitor'; // 端末ごとの記号（閲覧した人数を数えるため）
  var POSITION_KEY = 'sevenhearts_manual_position'; // 前回読んだページ
  var READ_KEY = 'sevenhearts_manual_read';         // この端末で読み終えた章（章の名前）
  var LIFF_WAIT_MS = 4000;

  function $(id) { return document.getElementById(id); }

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 保存できない端末では覚えない */ }
  }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ---- 閲覧の記録 ----

  function randomId() {
    var s = '';
    for (var i = 0; i < 16; i++) s += Math.floor(Math.random() * 36).toString(36);
    return s;
  }

  var visitor = load(VISITOR_KEY);
  if (typeof visitor !== 'string' || !/^[a-z0-9]{16}$/.test(visitor)) {
    visitor = randomId();
    save(VISITOR_KEY, visitor);
  }

  /** どこから開いたか（リッチメニューの URL などに ?from=… を付けておく） */
  function openedFrom() {
    var params = new URLSearchParams(location.search);
    var from = params.get('from');
    // liff.line.me から開いた直後は、元の URL が liff.state に入っている
    if (!from && params.get('liff.state')) {
      var q = params.get('liff.state').split('?')[1] || '';
      from = new URLSearchParams(q).get('from');
    }
    return /^[a-z0-9_-]{1,20}$/.test(from || '') ? from : '';
  }
  var from = openedFrom();

  var inClient = false;
  /** LIFF で開いていれば、本人確認用の IDトークン（なければ空。待ちすぎないよう4秒で諦める） */
  var tokenReady = new Promise(function (resolve) {
    var config = window.APP_CONFIG || {};
    if (!window.liff || !config.LIFF_ID) return resolve('');
    setTimeout(function () { resolve(''); }, LIFF_WAIT_MS);
    liff.init({ liffId: config.LIFF_ID }).then(function () {
      inClient = liff.isInClient();
      if (inClient) $('close').hidden = false;
      resolve(liff.isLoggedIn() ? (liff.getIDToken() || '') : '');
    }, function () { resolve(''); });
  });

  var totalChapters = 0;
  function track(event, chapter) {
    var url = (window.APP_CONFIG || {}).GAS_URL;
    if (!url) return;
    tokenReady.then(function (token) {
      var body = JSON.stringify({
        action: 'manualView',
        idToken: token,
        data: {
          visitor: visitor,
          event: event,
          chapter: chapter ? chapter.no : 0,
          title: chapter ? chapter.title : '',
          total: totalChapters,
          from: from
        }
      });
      // text/plain で送る（Apps Script へ送るときに、事前の確認の通信が起きないように）
      try {
        if (navigator.sendBeacon && navigator.sendBeacon(url, body)) return;
      } catch (e) { /* 次の方法で送る */ }
      fetch(url, { method: 'POST', body: body, mode: 'no-cors', keepalive: true }).catch(function () {});
    });
  }

  // ---- 表示 ----

  var chapters = [];
  var pageInfo = {}; // ページの id → { chapter, index }
  var readTitles = load(READ_KEY);
  if (!Array.isArray(readTitles)) readTitles = [];

  function chapterLabel(c) { return '第' + c.no + '章'; }

  function tocItem(c, withThumb) {
    var li = el('li');
    var a = el('a');
    a.href = '#' + c.id;
    if (withThumb && c.thumb) {
      var img = el('img', 'thumb');
      img.src = c.thumb;
      img.alt = '';
      img.loading = 'lazy';
      img.width = 56;
      img.height = 84;
      a.appendChild(img);
    }
    var label = el('span', 'label');
    label.appendChild(el('span', 'no', chapterLabel(c)));
    label.appendChild(el('span', 'name', c.title));
    label.appendChild(el('span', 'pages', c.pages.length + 'ページ'));
    a.appendChild(label);
    var read = el('span', 'read', readTitles.indexOf(c.title) >= 0 ? '✓ 読んだ' : '');
    read.dataset.title = c.title;
    a.appendChild(read);
    li.appendChild(a);
    return li;
  }

  function render(data) {
    chapters = (data && data.chapters) || [];
    totalChapters = chapters.length;
    if (!chapters.length) {
      showMessage('マニュアルは準備中です。');
      return;
    }
    var toc = $('toc');
    var drawerToc = $('toc-drawer-list');
    var box = $('chapters');
    chapters.forEach(function (c, i) {
      toc.appendChild(tocItem(c, true));
      drawerToc.appendChild(tocItem(c, false));

      var section = el('section', 'chapter');
      section.id = c.id;
      var h2 = el('h2', 'chapter-title');
      h2.appendChild(el('span', 'no', chapterLabel(c)));
      h2.appendChild(document.createTextNode(c.title));
      section.appendChild(h2);

      c.pages.forEach(function (p, j) {
        var img = el('img', 'page');
        img.id = c.id + '-p' + (j + 1);
        img.src = p.src;
        img.width = p.width;
        img.height = p.height;
        img.alt = chapterLabel(c) + ' ' + c.title + '（' + (j + 1) + '/' + c.pages.length + 'ページ）';
        img.decoding = 'async';
        // 最初の章のはじめの2枚以外は、画面に近づいてから読み込む
        if (i > 0 || j > 1) img.loading = 'lazy';
        section.appendChild(img);
        pageInfo[img.id] = { chapter: c, index: j };
      });

      var next = chapters[i + 1];
      if (next) {
        var end = el('div', 'chapter-end');
        var a = el('a', 'next');
        a.href = '#' + next.id;
        a.appendChild(el('small', '', '次の章へ'));
        a.appendChild(document.createTextNode(chapterLabel(next) + '　' + next.title));
        end.appendChild(a);
        section.appendChild(end);
      }
      box.appendChild(section);
    });
    $('finish').hidden = false;

    showResume();
    jumpToHash();
    watchPages();
    track('open', null);
  }

  function showMessage(text) {
    var m = $('message');
    m.textContent = text;
    m.hidden = false;
  }

  /** 画面を作ったあとなので、URL の #ch02 などへは自分で移動する */
  function jumpToHash() {
    var id = decodeURIComponent(location.hash.slice(1));
    var target = id && document.getElementById(id);
    if (target && id !== 'top') target.scrollIntoView();
  }

  function showResume() {
    var pos = load(POSITION_KEY);
    if (location.hash || !pos || !pos.id || !document.getElementById(pos.id)) return;
    var info = pageInfo[pos.id];
    if (!info || (info.chapter.no === 1 && info.index === 0)) return;
    var button = $('resume');
    button.textContent = '前回の続きから読む（' + chapterLabel(info.chapter) + ' ' + (info.index + 1) + 'ページ目）';
    button.hidden = false;
    button.addEventListener('click', function () {
      document.getElementById(pos.id).scrollIntoView();
    });
  }

  // ---- 読んでいる場所 ----

  var sentChapters = {};
  var lastSaved = '';
  var dwellTimers = {};
  var DWELL_MS = 800; // 目次から移動するときなどに通り過ぎたページは「読んだ」に数えない

  function onPageVisible(id) {
    var info = pageInfo[id];
    if (!info) return;
    var c = info.chapter;
    $('bar-chapter').textContent = chapterLabel(c) + '　' + c.title;
    if (id !== lastSaved) {
      lastSaved = id;
      save(POSITION_KEY, { id: id, at: Date.now() });
    }
  }

  function onPageRead(id) {
    var info = pageInfo[id];
    if (!info) return;
    var c = info.chapter;
    // 章の最後のページまで来たら「読み終えた」
    if (info.index === c.pages.length - 1 && !sentChapters[c.id]) {
      sentChapters[c.id] = true;
      track('chapter', c);
      if (readTitles.indexOf(c.title) < 0) {
        readTitles.push(c.title);
        save(READ_KEY, readTitles);
        Array.prototype.forEach.call(document.querySelectorAll('.read'), function (e) {
          if (e.dataset.title === c.title) e.textContent = '✓ 読んだ';
        });
      }
    }
  }

  function watchPages() {
    var pages = document.querySelectorAll('.page');
    if (!('IntersectionObserver' in window)) return;
    // 画面の真ん中あたりを通ったページを「読んでいるページ」とする（縦に長い画像でも判定できるように）
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var id = e.target.id;
        clearTimeout(dwellTimers[id]);
        if (!e.isIntersecting) return;
        onPageVisible(id);
        dwellTimers[id] = setTimeout(function () { onPageRead(id); }, DWELL_MS);
      });
    }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 });
    Array.prototype.forEach.call(pages, function (p) { observer.observe(p); });

    // 表紙・目次が見えているときは、上のバーに章の名前を出さない
    var cover = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) $('bar-chapter').textContent = '';
    }, { threshold: 0.3 });
    cover.observe(document.querySelector('.cover'));
  }

  // ---- 進み具合のバー・先頭へ戻るボタン ----

  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var pct = max > 0 ? Math.min(100, Math.max(0, window.scrollY / max * 100)) : 0;
      $('progress').style.width = pct + '%';
      $('to-top').hidden = window.scrollY < 800;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  $('to-top').addEventListener('click', function () { window.scrollTo(0, 0); });

  // ---- 目次（右から出る） ----

  function openDrawer(open) {
    $('toc-drawer').hidden = !open;
    $('toc-open').setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : '';
  }
  $('toc-open').addEventListener('click', function () { openDrawer(true); });
  $('toc-close').addEventListener('click', function () { openDrawer(false); });
  $('toc-drawer').addEventListener('click', function (e) {
    if (e.target === e.currentTarget || e.target.closest('a')) openDrawer(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') openDrawer(false);
  });

  $('close').addEventListener('click', function () {
    if (window.liff && inClient) liff.closeWindow();
  });

  // ---- 読み込み ----

  // 目次のデータは毎回新しいものを確認する（画像はファイル名が変わるので、古いものが残らない）
  fetch('manual.json', { cache: 'no-cache' })
    .then(function (res) {
      if (!res.ok) throw new Error(res.status);
      return res.json();
    })
    .then(render)
    .catch(function () {
      showMessage('マニュアルを読み込めませんでした。\n電波の良い場所で、もう一度開いてください。');
    });
})();
