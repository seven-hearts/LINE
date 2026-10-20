/**
 * LINE Messaging API / LINEログインの呼び出し。
 */

var LINE_BOT_API = 'https://api.line.me/v2/bot';

/** 直前の LINE API の失敗理由（日本語）。成功したら空 */
var lastLineError_ = '';

/** LINE API のエラー応答 → 担当者が読んでわかる理由 */
function lineErrorText_(code, text) {
  var body = {};
  try { body = JSON.parse(text || '{}'); } catch (e) { body = {}; }
  var msg = String(body.message || text || '');
  var details = (body.details || []).map(function (d) { return (d.property ? d.property + '：' : '') + (d.message || ''); }).join('／');
  var all = msg + ' ' + details;
  if (code === 429 && /monthly limit/i.test(all)) {
    return '今月のメッセージ送信数の上限に達しました（LINE Official Account Manager の「設定 > 利用と請求」でプランと送信数を確認してください）';
  }
  if (code === 429) return 'LINE が混み合っています。少し待ってから送り直してください';
  if (code === 401) return 'チャネルアクセストークンが無効です（checkSettings を実行して確認してください）';
  if (code === 400 && /ContentUrl|ImageUrl/i.test(all)) return '画像を送れませんでした（' + details + '）。画像を外して送るか、選び直してください';
  var badTo = (body.details || []).some(function (d) { return d.property === 'to'; }) || /property, 'to'/.test(msg);
  if (code === 400 && badTo) return 'このスタッフの LINE ユーザーIDが正しくありません（' + all.trim() + '）';
  if (code === 400 && /text/i.test(details) && /5000|length|size/i.test(details)) return '文章が長すぎます（' + details + '）';
  return 'LINE が受け付けませんでした（' + code + '：' + all.trim() + '）';
}

function lineRequest_(method, path, payload) {
  var options = {
    method: method,
    headers: { Authorization: 'Bearer ' + getConfig_().channelAccessToken },
    muteHttpExceptions: true
  };
  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  var res = UrlFetchApp.fetch(LINE_BOT_API + path, options);
  if (res.getResponseCode() >= 300) {
    console.error('LINE API error', path, res.getResponseCode(), res.getContentText());
    lastLineError_ = lineErrorText_(res.getResponseCode(), res.getContentText());
    return null;
  }
  lastLineError_ = '';
  return res.getContentText() ? JSON.parse(res.getContentText()) : {};
}

/** 返信の相手（Webhook の handleEvent_ が設定する。送信履歴に残すため） */
var replyUserId_ = '';

function replyMessage_(replyToken, messages) {
  var res = lineRequest_('post', '/message/reply', { replyToken: replyToken, messages: messages });
  if (replyUserId_) logSend_('返信', [replyUserId_], messages, !!res);
  return res;
}

/** プッシュメッセージは月の無料通数にカウントされます */
function pushMessage_(userId, messages) {
  var res = lineRequest_('post', '/message/push', { to: userId, messages: messages });
  logSend_('個別', [userId], messages, !!res);
  return res;
}

/** 一斉送信（最大500人）。人数ぶん月の無料通数にカウントされます */
function multicastMessage_(userIds, messages) {
  var res = lineRequest_('post', '/message/multicast', { to: userIds, messages: messages });
  logSend_('一斉', userIds, messages, !!res);
  return res;
}

function getLineProfile_(userId) {
  return lineRequest_('get', '/profile/' + encodeURIComponent(userId));
}

/** 応募者にそのまま見せてよいエラー。code はフォームが自動で対処するための目印（'login' など） */
function UserError(message, code) {
  this.name = 'UserError';
  this.message = message;
  this.code = code || '';
}
UserError.prototype = Object.create(Error.prototype);

/**
 * LIFF から受け取った IDトークンを LINE で検証し、ユーザーIDを返す。
 * フォームから送られてくる userId は信用せず、必ずこの結果を使う。
 */
function verifyIdToken_(idToken) {
  if (!idToken) throw new UserError('LINEのログイン情報を取得できませんでした。LINEアプリから開き直してください。');
  // フォームを開いたとき（me）と送信したとき（register）で同じトークンが届くため、確認結果を10分間覚えておく
  var cache = CacheService.getScriptCache();
  var key = 'idt:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  var cached = cache.get(key);
  if (cached) return cached;
  var res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: getConfig_().loginChannelId },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new UserError('ログインの有効期限が切れました。画面を閉じて、もう一度開き直してください。', 'login');
  }
  var body = JSON.parse(res.getContentText());
  // トークンの有効期限を過ぎて覚えておかないようにする
  var ttl = Math.min(600, Math.floor(body.exp - Date.now() / 1000));
  if (ttl > 0) cache.put(key, body.sub, ttl);
  return body.sub;
}

function registerUrl_() {
  return 'https://liff.line.me/' + getConfig_().liffId;
}

function onboardingUrl_() {
  return registerUrl_() + '/onboarding.html';
}

function textMessage_(text) {
  return { type: 'text', text: text };
}

/** ボタン付きメッセージ（本文は160文字以内） */
function buttonMessage_(text, label, uri) {
  return {
    type: 'template',
    altText: text,
    template: { type: 'buttons', text: text, actions: [{ type: 'uri', label: label, uri: uri }] }
  };
}

function registerButton_(text) {
  return buttonMessage_(text || 'こちらからスタッフ登録ができます（約3分）', 'スタッフ登録をする', registerUrl_());
}

function onboardingButton_() {
  return buttonMessage_(
    '書類提出フォームから、本人確認書類・給与振込口座・緊急連絡先をご提出ください。',
    '書類を提出する',
    onboardingUrl_()
  );
}
