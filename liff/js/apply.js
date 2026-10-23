/* お仕事への応募（案件のカードの「日程を選んで応募する」から開く） */
(function () {
  'use strict';

  var form = App.$('#screen-form');
  var submit = App.$('#submit-button');
  var list = App.$('#slot-list');
  var info = null;

  App.init()
    .then(function () {
      // LIFF の初期化後に URL の ?case=2026-10-0001 を読む（初期化の前は liff.state に入っている）
      var caseId = new URLSearchParams(location.search).get('case') || '';
      if (!caseId) throw new Error('案件が指定されていません。トークの案件のカードから開いてください。');
      return App.api('jobApplyInfo', { caseId: caseId });
    })
    .then(function (res) {
      if (!res.ok) throw new Error(res.error);
      info = res;
      render();
      App.show('screen-form');
    })
    .catch(function (err) { App.fatal(err.message); });

  function render() {
    App.$('#job-title').textContent = info.title || 'お仕事';
    App.$('#job-pay').textContent = '💴 ' + (info.staffPay || '給与はお問い合わせください') + '　🚃 交通費' + info.transport;
    var dl = App.$('#job-info');
    dl.innerHTML = '';
    [['場所', [info.place, info.address].filter(Boolean).join('\n')], ['仕事', info.work],
      ['集合', [info.meetingTime, info.meetingPlace].filter(Boolean).join('\n')], ['服装', info.dress], ['持ち物', info.belongings]]
      .forEach(function (p) {
        if (!p[1]) return;
        var dt = document.createElement('dt'); dt.textContent = p[0];
        var dd = document.createElement('dd'); dd.textContent = p[1];
        dl.appendChild(dt); dl.appendChild(dd);
      });

    list.innerHTML = '';
    info.slots.forEach(function (s) {
      var label = document.createElement('label');
      var disabled = !!s.applied || s.closed;
      label.className = 'slot' + (disabled ? ' disabled' : '');
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.value = s.slotId;
      input.disabled = disabled;
      var text = document.createElement('span');
      text.className = 'slot-label';
      text.textContent = s.label;
      label.appendChild(input);
      label.appendChild(text);
      if (disabled) {
        var tag = document.createElement('span');
        tag.className = 'slot-tag';
        tag.textContent = s.applied ? (s.applied === '応募' ? '応募済み' : s.applied) : '募集終了';
        label.appendChild(tag);
      }
      list.appendChild(label);
    });
    if (!info.slots.some(function (s) { return !s.applied && !s.closed; })) {
      App.$('#slot-error').textContent = '応募できる日程はありません。';
      App.$('#slot-error').hidden = false;
    }
    update();
  }

  function chosen() {
    return App.$all('input[type=checkbox]:checked', list).map(function (x) { return x.value; });
  }

  function update() {
    var n = chosen().length;
    submit.disabled = !n;
    submit.textContent = n ? n + '日程に応募する' : '応募する';
  }

  list.addEventListener('change', update);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var ids = chosen();
    if (!ids.length) return;
    App.busy(submit, true);
    App.api('jobApply', { slotIds: ids })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error);
        var ok = res.results.filter(function (r) { return r.ok; });
        var ng = res.results.filter(function (r) { return !r.ok; });
        App.$('#done-title').textContent = ok.length ? ok.length + '日程の応募を受け付けました' : '応募できませんでした';
        var ul = App.$('#done-list');
        ul.innerHTML = '';
        res.results.forEach(function (r) {
          var li = document.createElement('li');
          li.className = r.ok ? 'ok' : 'ng';
          li.textContent = r.ok ? '✓ ' + r.label : '× ' + r.message;
          ul.appendChild(li);
        });
        App.show('screen-done');
        if (ok.length) echoToChat(ok);
      })
      .catch(function (err) { alert(err.message || '送信に失敗しました。通信環境の良い場所で再度お試しください。'); })
      .then(function () { App.busy(submit, false); });
  });

  /**
   * 応募した内容を、本人の名前でトークに送る（LINE Official Account Manager のチャットにも残るように）。
   * LIFF アプリの設定で chat_message.write が無効なときなどは送れないが、応募は受け付け済みなので何もしない。
   */
  function echoToChat(ok) {
    try {
      if (!liff.isInClient()) return;
      var text = '【応募しました】\n' + info.title + '\n' + ok.map(function (r) { return '・' + r.label; }).join('\n');
      liff.sendMessages([{ type: 'text', text: text.slice(0, 4900) }]).catch(function () { /* 送れなくてもよい */ });
    } catch (e) { /* 何もしない */ }
  }

  App.$('#close-button').addEventListener('click', App.close);
})();
