/* スタッフ登録フォーム（新規登録と登録内容の変更。新規登録ではトークで答えたお名前が入る） */
(function () {
  'use strict';

  var form = App.$('#screen-form');
  var submit = App.$('#submit-button');
  var isEdit = false;
  var ready = false;   // LINEログインと登録状況の読み込みが終わったか
  var touched = false; // 読み込み中に入力が始まったか

  // 面接の時刻の選択肢（30分刻み）
  var INTERVIEW_FIRST_TIME = '09:00';
  var INTERVIEW_LAST_TIME = '22:00';
  var INTERVIEW_MAX_DAYS = 90;
  var INTERVIEW_MIN_LEAD_MINUTES = 60; // 現在時刻から1時間後以降
  var WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addOption(select, value, label) {
    var o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    select.appendChild(o);
  }
  function field(name) { return App.$('[name="' + name + '"]', form); }

  // 選択肢はフォームに同梱（js/options.js）しているので、サーバーの応答を待たずにすぐ表示する
  App.renderOptions(form, window.FORM_OPTIONS);
  setupBirthSelects();
  setupInterviewSelects();
  setupInterview();
  App.show('screen-form');
  form.addEventListener('input', function () { touched = true; });
  form.addEventListener('change', function () { touched = true; });

  // 入力途中の内容を端末に一時保存し、通信エラーや画面を閉じたときに消えないようにする
  var DRAFT_KEY = 'sevenhearts_register_draft';
  restoreDraft();
  form.addEventListener('input', saveDraft);
  form.addEventListener('change', saveDraft);

  // LINEログインと登録状況の取得は裏で行う。失敗してもフォームは消さず、再読み込みのボタンを出す
  var initPromise = null;
  function load() {
    App.$('#load-error').hidden = true;
    App.busy(submit, true, '読み込み中…');
    initPromise = initPromise || App.init();
    initPromise
      .then(function () { return App.api('me'); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error);
        if (res.privacyPolicyUrl) App.$('#privacy-link').href = res.privacyPolicyUrl;
        if (res.registration) {
          isEdit = true;
          // 読み込み中にすでに入力を始めていたら、入力済みの欄は上書きしない
          fill(res.registration, touched);
          // 登録時に同意済み
          App.$all('input[data-consent]', form).forEach(function (el) { el.checked = true; });
          App.$('#edit-notice').hidden = false;
          App.$('#new-notice').hidden = true;
          setupInterview();
        } else if (res.draft) {
          fill(res.draft, true); // トークで答えたお名前（空欄のときだけ入れる）
        }
        ready = true;
        App.busy(submit, false);
        submit.textContent = isEdit ? '更新する' : '登録する';
      })
      .catch(function (err) {
        initPromise = null;
        App.$('#load-error-message').textContent = (err && err.message) || '通信に失敗しました。';
        App.$('#load-error').hidden = false;
        App.busy(submit, false);
        submit.textContent = '読み込みに失敗しました（上のボタンで再読み込み）';
        submit.disabled = true;
        App.$('#load-error').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
  }
  App.$('#retry-button').addEventListener('click', load);
  load();

  function saveDraft() {
    try {
      var data = App.collect(form);
      Object.keys(data).forEach(function (k) {
        if (Array.isArray(data[k])) data[k] = data[k].join('、');
        if (typeof data[k] === 'boolean') delete data[k]; // 同意欄は保存しない
      });
      localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
    } catch (e) { /* 保存できない環境では何もしない */ }
  }

  function restoreDraft() {
    try {
      var data = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (data) App.fill(form, data);
      for (var n = 1; n <= 4; n++) refreshTimes(n); // 過ぎてしまった時刻は選び直してもらう
      updateBirthDays();
      syncSelectsFromHidden();
    } catch (e) { /* 読めなければ何もしない */ }
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* 何もしない */ }
  }

  /** onlyEmpty なら、まだ入力されていない欄だけに入れる */
  function fill(data, onlyEmpty) {
    if (!onlyEmpty) {
      App.fill(form, data);
      syncSelectsFromHidden();
      return;
    }
    var empty = {};
    Object.keys(data).forEach(function (name) {
      var els = App.$all('[name="' + name + '"]', form);
      var filled = els.some(function (el) {
        return (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value !== '';
      });
      if (!filled) empty[name] = data[name];
    });
    App.fill(form, empty);
    syncSelectsFromHidden();
  }

  // ---- 生年月日（年・月・日のプルダウン → 送信用の birthDate） ----

  function setupBirthSelects() {
    var thisYear = new Date().getFullYear();
    for (var y = thisYear - 15; y >= thisYear - 80; y--) addOption(field('birthYear'), y, y + '年');
    for (var m = 1; m <= 12; m++) addOption(field('birthMonth'), m, m + '月');
    updateBirthDays();
    ['birthYear', 'birthMonth', 'birthDay'].forEach(function (name) {
      field(name).addEventListener('change', function () {
        updateBirthDays();
        syncBirthDate();
      });
    });
  }

  /** 月（うるう年を含む）に合わせて「日」の選択肢を 28〜31 日にする */
  function updateBirthDays() {
    var y = Number(field('birthYear').value) || 2000;
    var m = Number(field('birthMonth').value) || 1;
    var last = new Date(y, m, 0).getDate();
    var daySelect = field('birthDay');
    var current = daySelect.value;
    while (daySelect.options.length > 1) daySelect.remove(1);
    for (var d = 1; d <= last; d++) addOption(daySelect, d, d + '日');
    daySelect.value = Number(current) <= last ? current : '';
  }

  function syncBirthDate() {
    var y = field('birthYear').value, m = field('birthMonth').value, d = field('birthDay').value;
    field('birthDate').value = y && m && d ? y + '-' + pad(Number(m)) + '-' + pad(Number(d)) : '';
  }

  // ---- 面接の希望日時（日付・時刻のプルダウン → 送信用の interviewN） ----

  /** その日に選べる時刻（30分刻み）。今日なら現在時刻から INTERVIEW_MIN_LEAD_MINUTES 後以降だけ */
  function timesFor(dateValue) {
    var first = INTERVIEW_FIRST_TIME.split(':').map(Number);
    var last = INTERVIEW_LAST_TIME.split(':').map(Number);
    var start = first[0] * 60 + first[1];
    var now = new Date();
    if (dateValue === ymd(now)) {
      var earliest = now.getHours() * 60 + now.getMinutes() + INTERVIEW_MIN_LEAD_MINUTES;
      start = Math.max(start, Math.ceil(earliest / 30) * 30);
    }
    var list = [];
    for (var min = start; min <= last[0] * 60 + last[1]; min += 30) {
      list.push(pad(Math.floor(min / 60)) + ':' + pad(min % 60));
    }
    return list;
  }

  function setupInterviewSelects() {
    var t = new Date();
    for (var n = 1; n <= 4; n++) {
      var dateSelect = field('interview' + n + 'Date');
      // 今日は、1時間後以降の枠が残っているときだけ選べる
      for (var i = 0; i < INTERVIEW_MAX_DAYS; i++) {
        var d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + i);
        if (i === 0 && !timesFor(ymd(d)).length) continue;
        addOption(dateSelect, ymd(d), (i === 0 ? '今日 ' : '') + (d.getMonth() + 1) + '/' + d.getDate() + '(' + WEEKDAYS[d.getDay()] + ')');
      }
      refreshTimes(n);
      dateSelect.addEventListener('change', (function (k) {
        return function () { refreshTimes(k); syncInterviews(); };
      })(n));
      field('interview' + n + 'Time').addEventListener('change', syncInterviews);
    }
  }

  /** 選んだ日付に合わせて時刻の選択肢を作り直す（選んでいた時刻が選べなくなったら空に戻す） */
  function refreshTimes(n) {
    var timeSelect = field('interview' + n + 'Time');
    var current = timeSelect.value;
    var times = timesFor(field('interview' + n + 'Date').value);
    while (timeSelect.options.length > 1) timeSelect.remove(1);
    times.forEach(function (hhmm) { addOption(timeSelect, hhmm, hhmm); });
    timeSelect.value = times.indexOf(current) >= 0 ? current : '';
  }

  function syncInterviews() {
    for (var n = 1; n <= 4; n++) {
      var date = field('interview' + n + 'Date').value;
      var time = field('interview' + n + 'Time').value;
      field('interview' + n).value = date && time ? date + 'T' + time : '';
    }
  }

  /** 第2〜第4希望で、日付と時刻のどちらかだけ選ばれていたらエラー */
  function interviewPairErrors() {
    var errors = {};
    for (var n = 2; n <= 4; n++) {
      var date = field('interview' + n + 'Date');
      var time = field('interview' + n + 'Time');
      if (date.disabled) continue;
      if (!!date.value !== !!time.value) errors['interview' + n] = '日付と時刻の両方を選んでください';
    }
    return errors;
  }

  /** 登録済みの内容・一時保存から送信用の値が入ったとき、プルダウンにも反映する */
  function syncSelectsFromHidden() {
    var b = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(field('birthDate').value);
    if (b && !field('birthYear').value) {
      field('birthYear').value = String(Number(b[1]));
      field('birthMonth').value = String(Number(b[2]));
      updateBirthDays();
      field('birthDay').value = String(Number(b[3]));
    }
    syncBirthDate();
  }

  /** 面接の希望日時は新規登録のときだけ聞く（変更時は担当者と調整済みのため） */
  function setupInterview() {
    var section = App.$('#interview-section');
    section.hidden = isEdit;
    App.$all('input, select', section).forEach(function (el) { el.disabled = isEdit; });
  }

  // 郵便番号 → 住所の自動入力。市区町村は空欄か、前に自動で入れた内容のときだけ書き換える
  var zipHint = App.$('#postal-hint');
  var lastZip = '';
  var autoCity = '';
  function onZip(e) {
    var zip = e.target.value.replace(/[０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    }).replace(/\D/g, '');
    if (zip.length !== 7 || zip === lastZip) return;
    lastZip = zip;
    zipHint.textContent = '住所を検索しています…';
    App.lookupZip(zip).then(function (addr) {
      if (zip !== lastZip) return; // 検索中に書き換えられた
      if (!addr) {
        zipHint.textContent = '住所が見つかりませんでした。郵便番号を確認するか、住所を直接入力してください。';
        return;
      }
      App.$('#prefecture').value = addr.prefecture;
      var city = App.$('#city');
      if (!city.value || city.value === autoCity) city.value = addr.city;
      autoCity = addr.city;
      zipHint.textContent = '住所を入力しました。続きの番地・建物名を入力してください。';
      saveDraft();
    });
  }
  App.$('#postalCode').addEventListener('input', onZip);
  App.$('#postalCode').addEventListener('change', onZip); // 自動入力（オートフィル）対策

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!ready) return;
    for (var n = 1; n <= 4; n++) refreshTimes(n); // 入力中に1時間前を過ぎた時刻を外す
    syncBirthDate();
    syncInterviews();
    if (!App.validate(form)) return;
    var pairErrors = interviewPairErrors();
    if (Object.keys(pairErrors).length) return App.showErrors(form, pairErrors);
    App.busy(submit, true);
    App.api('register', App.collect(form))
      .then(function (res) {
        if (res.errors) return App.showErrors(form, res.errors);
        if (!res.ok) throw new Error(res.error);
        clearDraft();
        if (isEdit) {
          App.$('#done-title').textContent = '登録内容を更新しました';
          App.$('#done-message').textContent = 'ご協力ありがとうございます。';
        }
        App.show('screen-done');
      })
      .catch(function (err) { alert(err.message || '送信に失敗しました。通信環境の良い場所で再度お試しください。'); })
      .then(function () { App.busy(submit, false); });
  });

  App.$('#close-button').addEventListener('click', App.close);
})();
