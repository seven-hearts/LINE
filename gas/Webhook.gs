/**
 * LINE 公式アカウントの Webhook。
 * - 友だち追加 → トークでお名前を聞き、続きを入力する登録フォームのボタンを送る（Chat.gs）
 * - それ以外はキーワードにだけ反応する。キーワード以外には返信しないので、
 *   LINE Official Account Manager のチャット機能で担当者が手動で返信できる。
 * ボットの返信はすべて「応答メッセージ」なので、月の無料メッセージ数を消費しない。
 */

function handleWebhook_(body) {
  (body.events || []).forEach(function (ev) {
    try {
      handleEvent_(ev);
    } catch (err) {
      console.error('webhook event failed', err && err.stack || err);
      logError_('LINE：' + ev.type, ev.source && ev.source.userId, err);
    }
  });
}

function handleEvent_(ev) {
  if (!ev.source || ev.source.type !== 'user' || !ev.source.userId) return;
  var userId = ev.source.userId;

  switch (ev.type) {
    case 'follow':
      return onFollow_(ev, userId);
    case 'unfollow':
      return onUnfollow_(userId);
    case 'postback':
      return onPostback_(ev, userId);
    case 'message':
      if (ev.message.type === 'text') return onText_(ev, userId, ev.message.text.trim());
      return onOtherMessage_(ev, userId);
  }
}

function onFollow_(ev, userId) {
  var rec = readRecord_(REG_SHEET, userId);
  if (rec) {
    if (rec.blocked) writeRecord_(REG_SHEET, userId, { blocked: '', updatedAt: now_() });
    replyMessage_(ev.replyToken, [textMessage_('おかえりなさい！\n' + statusText_(rec))]);
    return;
  }
  var chat = loadChat_(userId);
  if (chat) {
    replyMessage_(ev.replyToken, [textMessage_('おかえりなさい！スタッフ登録の続きから再開します。')].concat(chatPrompt_(chat)));
    return;
  }
  startChat_(ev.replyToken, userId, '友だち追加ありがとうございます！\nイベント運営スタッフのセブンハーツです。\n\n');
}

function onUnfollow_(userId) {
  if (readRecord_(REG_SHEET, userId)) {
    writeRecord_(REG_SHEET, userId, { blocked: 'ブロック中', updatedAt: now_() });
  }
}

function onText_(ev, userId, text) {
  var chat = loadChat_(userId);
  // お名前を聞いている間は、送られたメッセージを回答として扱う
  if (chat && chatAsking_(chat)) return continueChat_(ev, userId, chat, { text: text });
  // フォームの入力待ち：「やめる」と登録関係のキーワードにだけ反応する（それ以外は担当者が手動で対応）
  if (chat && (text === CHAT_CANCEL || /登録|応募|フォーム|続き/.test(text))) {
    return continueChat_(ev, userId, chat, { text: text });
  }

  // 詳細連絡のあとの、交通費（往復）と出発時間の返信
  if (handleTravelReply_(ev, userId, text)) return;

  var rec = readRecord_(REG_SHEET, userId);

  if (/登録状況|ステータス/.test(text)) {
    if (rec) replyMessage_(ev.replyToken, [textMessage_(statusText_(rec))]);
    else startChat_(ev.replyToken, userId, 'まだスタッフ登録がお済みでないようです。\n\n');
    return;
  }
  if (/書類/.test(text)) {
    if (rec && ONBOARDING_ALLOWED.indexOf(rec.status) >= 0) {
      replyMessage_(ev.replyToken, [onboardingButton_()]);
    } else {
      replyMessage_(ev.replyToken, [textMessage_('書類のご提出は、採用のご連絡後にご案内します。')]);
    }
    return;
  }
  if (/登録|応募|変更/.test(text)) {
    if (rec) replyMessage_(ev.replyToken, [registerButton_('登録内容の確認・変更はこちらから行えます')]);
    else startChat_(ev.replyToken, userId, '');
  }
}

/** ボタン（面接候補の選択など）が押されたとき */
function onPostback_(ev, userId) {
  var params = {};
  String(ev.postback.data || '').split('&').forEach(function (kv) {
    var i = kv.indexOf('=');
    if (i > 0) params[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
  });
  if (params.iv) onInterviewPostback_(ev, userId, params);
  if (params.job) onJobPostback_(ev, userId, params);
}

/** スタンプや画像など */
function onOtherMessage_(ev, userId) {
  var chat = loadChat_(userId);
  if (!chat || !chatAsking_(chat)) return;
  replyMessage_(ev.replyToken, [textMessage_('文字で回答してください。')].concat(chatPrompt_(chat)));
}

function startChat_(replyToken, userId, greeting) {
  var state = chatNewState_(new Date());
  saveChat_(userId, state);
  replyMessage_(replyToken, [textMessage_(greeting + 'スタッフ登録をはじめます。')].concat(chatPrompt_(state)));
}

function continueChat_(ev, userId, state, input) {
  var res = chatAnswer_(state, input);
  if (res.cancelled) {
    deleteRecord_(CHAT_SHEET, userId);
  } else {
    saveChat_(userId, res.state);
  }
  replyMessage_(ev.replyToken, res.messages);
}

function statusText_(rec) {
  var name = rec.lastName + ' ' + rec.firstName + ' さんの登録状況：' + rec.status + '\n\n';
  switch (rec.status) {
    case STATUS.PRE:
      return name + '書類選考中です。結果はこのトークでお知らせしますので、しばらくお待ちください。';
    case STATUS.INTERVIEW_OFFERED:
      return name + 'お送りした面接候補の中から、ご都合のよい日時をお選びください。';
    case STATUS.RESCHEDULE:
      return name + '担当者から面接日程のご相談をさせていただきますので、少々お待ちください。';
    case STATUS.INTERVIEW_FIXED:
      return name + '面接日時：' + rec.interviewAt + '（LINEのビデオ通話・' + INTERVIEW_LENGTH + '）\n当日、時間になりましたら「ビデオ通話する」ボタンをお送りします。';
    case STATUS.HIRED:
    case STATUS.DOC_REQUESTED:
      return name + '書類のご提出をお待ちしています。「書類」と送信すると提出フォームを開けます。';
    case STATUS.DOC_SUBMITTED:
      return name + '提出書類を確認中です。確認が終わり次第ご連絡します。';
    case STATUS.ACTIVE:
      return name + 'お仕事のご案内をお待ちください。登録内容の変更は「変更」と送信してください。';
    default:
      return 'ご不明な点はこのトークでお問い合わせください。';
  }
}
