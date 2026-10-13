/* シフト提出フォーム（毎月25日に翌月分の案内が届く） */
(function () {
  'use strict';

  var OK = '○';
  var NG = '×';
  var WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  var form = App.$('#screen-form');
  var submit = App.$('#submit-button');
  var calendar = App.$('#calendar');
  var info = null;   // サーバーから受け取った対象の月
  var values = {};   // 日 → '○' / '×'

  App.init()
    .then(function () {
      // LIFF の初期化後に URL の ?month=2026-11 を読む（初期化の前は liff.state に入っている）
      var month = new URLSearchParams(location.search).get('month') || '';
      return App.api('shiftMe', { month: month });
    })
    .then(function (res) {
      if (!res.ok) throw new Error(res.error);
      info = res;
      App.$('#month-title').textContent = res.label + ' 出勤できる日';
      if (res.closedMonth) {
        App.$('#closed-notice').textContent = res.closedMonth + 'の受付は終了しました。' + res.label + 'のシフトを表示しています。';
        App.$('#closed-notice').hidden = false;
      }
      App.$('#edit-notice').hidden = !res.submitted;
      submit.textContent = res.submitted ? '更新する' : '提出する';
      App.$('#note').value = res.note || '';
      for (var d = 1; d <= daysInMonth(); d++) values[d] = res.values[d] === OK ? OK : NG;
      render();
      App.show('screen-form');
    })
    .catch(function (err) { App.fatal(err.message); });

  function daysInMonth() { return new Date(info.year, info.monthNumber, 0).getDate(); }
  function weekday(d) { return new Date(info.year, info.monthNumber - 1, d).getDay(); }
  function editable(d) { return d >= info.firstEditableDay; }

  /** 'weekday'（平日）/ 'off'（土日祝）/ 'long'（3連休以上）。サーバーが古い版なら土日だけで判定 */
  function dayInfo(d) {
    if (info.calendar && info.calendar[d - 1]) return info.calendar[d - 1];
    var w = weekday(d);
    return { type: w === 0 || w === 6 ? 'off' : 'weekday', holiday: '' };
  }

  function render() {
    calendar.innerHTML = '';
    WEEKDAYS.forEach(function (w, i) {
      var h = document.createElement('div');
      h.className = 'cal-head' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '');
      h.textContent = w;
      calendar.appendChild(h);
    });
    for (var i = 0; i < weekday(1); i++) calendar.appendChild(document.createElement('div'));
    for (var d = 1; d <= daysInMonth(); d++) {
      var b = document.createElement('button');
      var w = weekday(d);
      var di = dayInfo(d);
      b.type = 'button';
      b.className = 'cal-day ' + di.type + (values[d] === OK ? ' on' : '');
      b.dataset.day = d;
      b.disabled = !editable(d);
      if (di.holiday) b.title = di.holiday;
      b.setAttribute('aria-pressed', values[d] === OK ? 'true' : 'false');
      b.setAttribute('aria-label', info.monthNumber + '月' + d + '日（' + WEEKDAYS[w] + (di.holiday ? '・' + di.holiday : '') + '）' +
        (values[d] === OK ? '出勤できる' : '出勤できない'));
      b.innerHTML = '<span class="num"></span><span class="mark"></span>';
      b.querySelector('.num').textContent = d + (di.holiday ? '祝' : '');
      b.querySelector('.mark').textContent = editable(d) || values[d] === OK ? values[d] : '';
      calendar.appendChild(b);
    }
    var count = Object.keys(values).filter(function (d) { return values[d] === OK; }).length;
    App.$('#shift-count').textContent = '出勤できる日：' + count + '日';
  }

  calendar.addEventListener('click', function (e) {
    var b = e.target.closest('.cal-day');
    if (!b || b.disabled) return;
    var d = Number(b.dataset.day);
    values[d] = values[d] === OK ? NG : OK;
    render();
  });

  App.$all('[data-bulk]').forEach(function (button) {
    button.addEventListener('click', function () {
      var mode = button.dataset.bulk;
      for (var d = 1; d <= daysInMonth(); d++) {
        if (!editable(d)) continue;
        if (mode === 'all') values[d] = OK;
        else if (mode === 'clear') values[d] = NG;
        else if (dayInfo(d).type !== 'weekday') values[d] = OK; // 土日祝
      }
      render();
    });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var count = Object.keys(values).filter(function (d) { return values[d] === OK; }).length;
    if (!count && !confirm('出勤できる日が選ばれていません。「出勤できる日なし」として提出しますか？')) return;
    App.busy(submit, true);
    App.api('shift', { month: info.month, days: values, note: App.$('#note').value.trim() })
      .then(function (res) {
        if (res.errors) return App.showErrors(form, res.errors);
        if (!res.ok) throw new Error(res.error);
        App.$('#done-message').textContent = res.label + 'のシフト（出勤できる日：' + res.availableDays + '日）を受け付けました。ありがとうございます。';
        App.show('screen-done');
      })
      .catch(function (err) { alert(err.message || '送信に失敗しました。通信環境の良い場所で再度お試しください。'); })
      .then(function () { App.busy(submit, false); });
  });

  App.$('#close-button').addEventListener('click', App.close);
})();
