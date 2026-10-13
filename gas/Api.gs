/**
 * LIFF フォームから呼ばれる API。
 * リクエスト: { action, idToken, data }
 */

/** 登録フォームに再表示してよい項目（本人が入力したもののみ） */
var REG_EDITABLE_KEYS = [
  'lastName', 'firstName', 'lastNameKana', 'firstNameKana', 'birthDate', 'gender',
  'phone', 'email', 'postalCode', 'prefecture', 'city', 'building', 'nearestStation',
  'occupation', 'weekdays', 'areas', 'driverLicense', 'languages',
  'height', 'clothingSize', 'shoeSize', 'hairColor', 'clothes', 'note', 'referralSource'
];

var IMAGE_LABELS = {
  residenceCardFront: '在留カード_表',
  residenceCardBack: '在留カード_裏',
  idFront: '本人確認書類_表',
  idBack: '本人確認書類_裏',
  facePhoto: '顔写真'
};

function handleApi_(body) {
  try {
    // 郵便番号検索は個人情報を扱わないため、ログイン確認なしで受け付ける（フォームの読み込み前でも使えるように）
    if (body.action === 'zip') return apiZip_((body.data || {}).zip);
    var userId = verifyIdToken_(body.idToken);
    var data = body.data || {};
    switch (body.action) {
      case 'me': return apiMe_(userId);
      case 'register': return apiRegister_(userId, data);
      case 'uploadImage': return apiUploadImage_(userId, data);
      case 'onboarding': return apiOnboarding_(userId, data);
      case 'shiftMe': return apiShiftMe_(userId, data);
      case 'shift': return apiShift_(userId, data);
    }
    return { ok: false, error: '不明な操作です' };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, errors: err.errors };
    if (err instanceof UserError) {
      if (err.code !== 'login') logError_('フォーム：' + body.action, null, err);
      return { ok: false, error: err.message, code: err.code };
    }
    console.error('api failed', err && err.stack || err);
    logError_('フォーム：' + body.action, null, err);
    return { ok: false, error: '処理中にエラーが発生しました。時間をおいて再度お試しください。' };
  }
}

/** 郵便番号から住所を調べる（ブラウザから zipcloud に直接つながらないときの予備）。結果は6時間キャッシュ */
function apiZip_(zip) {
  zip = String(zip || '').replace(/\D/g, '');
  if (!/^\d{7}$/.test(zip)) return { ok: false, error: '郵便番号は7桁で入力してください' };
  var cache = CacheService.getScriptCache();
  var cached = cache.get('zip:' + zip);
  if (cached) return { ok: true, address: JSON.parse(cached) };
  var res = UrlFetchApp.fetch('https://zipcloud.ibsnet.co.jp/api/search?zipcode=' + zip, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return { ok: false, error: '住所を検索できませんでした' };
  var r = (JSON.parse(res.getContentText()).results || [])[0];
  if (!r) return { ok: true, address: null };
  var address = { prefecture: r.address1, city: r.address2 + r.address3 };
  cache.put('zip:' + zip, JSON.stringify(address), 21600);
  return { ok: true, address: address };
}

/** フォームの初期表示用：選択肢と、登録済みなら入力内容 */
function apiMe_(userId) {
  var rec = readRecord_(REG_SHEET, userId);
  var registration = null;
  var draft = null; // トークで答えたお名前（新規登録のフォームに入れておく）
  if (rec) {
    registration = {};
    REG_EDITABLE_KEYS.forEach(function (k) {
      var v = rec[k];
      registration[k] = typeof v === 'string' && v.charAt(0) === "'" ? v.slice(1) : v;
    });
  }
  if (!rec) {
    var chat = loadChat_(userId);
    if (chat && chat.data.lastName) draft = { lastName: chat.data.lastName, firstName: chat.data.firstName };
  }
  return {
    ok: true,
    draft: draft,
    options: OPTIONS,
    privacyPolicyUrl: getConfig_().privacyPolicyUrl,
    status: rec ? rec.status : null,
    ageNote: rec ? rec.ageNote : '',
    registration: registration
  };
}

/**
 * 登録内容を検証してシートに保存する。
 * 新規登録なら管理者に通知する。お礼のメッセージは呼び出し元で送る。
 */
function saveRegistration_(userId, input, source) {
  source = source || 'フォーム';
  var existing = readRecord_(REG_SHEET, userId);
  var record = validateRegistration(input, new Date(), { interviewOptional: !!existing });
  // 登録済みの人の内容変更では、面接日時は入力されたときだけ上書きする
  if (existing && !record.interview1) {
    INTERVIEW_KEYS.forEach(function (k) { delete record[k]; });
  }
  var now = now_();
  record.updatedAt = now;
  record.privacyConsentAt = now;
  record.antisocialConsentAt = now;
  if (!existing) {
    record.status = STATUS.PRE;
    record.registeredAt = now;
    record.source = source;
    var profile = getLineProfile_(userId);
    record.lineName = profile ? profile.displayName : '';
  }
  writeRecord_(REG_SHEET, userId, record);
  // トークでのやりとり（お名前）は登録が済んだので不要
  deleteRecord_(CHAT_SHEET, userId);

  var name = record.lastName + ' ' + record.firstName;
  if (!existing) notifyAdmin_('新規スタッフ登録', name);
  return { isNew: !existing, name: name };
}

function apiRegister_(userId, data) {
  var result = saveRegistration_(userId, data, 'フォーム');
  if (result.isNew) {
    pushMessage_(userId, [textMessage_(result.name + ' さん\n\nスタッフ登録ありがとうございます！\n' +
      '面接日時を調整のうえ、担当者からこのトークでご連絡します。\n\n登録内容の変更は「変更」と送信してください。')]);
  }
  return { ok: true, isNew: result.isNew };
}

function onboardingRecord_(userId) {
  var reg = readRecord_(REG_SHEET, userId);
  if (!reg) throw new UserError('先にスタッフ登録を行ってください。');
  if (ONBOARDING_ALLOWED.indexOf(reg.status) < 0) {
    throw new UserError('書類のご提出は、採用のご連絡後にご案内します。');
  }
  return reg;
}

/**
 * 書類の画像を1枚ずつ先に受け取る（まとめて送ると大きすぎて届かないことがあるため）。
 * 提出時には、ここで返した「upload:ファイルID」を画像の代わりに送ってもらう。
 */
function apiUploadImage_(userId, data) {
  var reg = onboardingRecord_(userId);
  if (!IMAGE_LABELS[data.key]) throw new UserError('画像の種類が正しくありません。');
  var m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+\/=]+)$/.exec(String(data.dataUrl || ''));
  if (!m || data.dataUrl.length > 7000000) throw new UserError('画像の形式が正しくありません。撮り直してください。');
  var folder = userFolder_(userId, reg.lastName + ' ' + reg.firstName);
  var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  var file = saveImageFile_(folder, IMAGE_LABELS[data.key] + '_' + stamp, data.dataUrl);
  return { ok: true, id: 'upload:' + file.getId() };
}

/** 「upload:ファイルID」がこの人のフォルダの画像なら、そのURLを返す */
function uploadedImageUrl_(folder, token) {
  var file;
  try {
    file = DriveApp.getFileById(token.replace(/^upload:/, ''));
  } catch (err) {
    return null;
  }
  var parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folder.getId()) return file.getUrl();
  }
  return null;
}

function apiOnboarding_(userId, data) {
  var reg = onboardingRecord_(userId);

  var result = validateOnboarding(data);
  var record = result.record;
  var name = reg.lastName + ' ' + reg.firstName;

  // 今回の提出に含まれない書類の列は空にする（国籍の変更などで古い画像が残らないように）
  Object.keys(IMAGE_LABELS).forEach(function (key) { record[key] = ''; });
  var folder = userFolder_(userId, name);
  var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  var missing = {};
  Object.keys(result.images).forEach(function (key) {
    var value = result.images[key];
    if (value.indexOf('upload:') === 0) {
      record[key] = uploadedImageUrl_(folder, value);
      if (!record[key]) missing[key] = '画像を受け取れませんでした。もう一度選び直してください';
    } else {
      record[key] = saveImage_(folder, IMAGE_LABELS[key] + '_' + stamp, value);
    }
  });
  if (Object.keys(missing).length) throw new ValidationError(missing);

  var existing = readRecord_(ONB_SHEET, userId);
  var now = now_();
  record.name = name;
  record.updatedAt = now;
  record.confidentialityConsentAt = now;
  if (!existing) record.submittedAt = now;
  writeRecord_(ONB_SHEET, userId, record);
  setStatus_(userId, STATUS.DOC_SUBMITTED);

  pushMessage_(userId, [textMessage_(name + ' さん\n\n書類のご提出ありがとうございました。\n' +
    '内容を確認し、お仕事のご案内ができるようになりましたらご連絡します。')]);
  notifyAdmin_('書類提出', name);
  return { ok: true };
}

/** スタッフごとのフォルダ（共有設定は親フォルダを引き継ぐ。親フォルダは共有しないこと） */
function userFolder_(userId, name) {
  var parent = DriveApp.getFolderById(getConfig_().driveFolderId);
  var folderName = name + '_' + userId.slice(-8);
  var it = parent.getFoldersByName(folderName);
  return it.hasNext() ? it.next() : parent.createFolder(folderName);
}

function saveImageFile_(folder, name, dataUrl) {
  var m = /^data:(image\/(jpeg|png));base64,(.+)$/.exec(dataUrl);
  var blob = Utilities.newBlob(Utilities.base64Decode(m[3]), m[1], name + (m[2] === 'png' ? '.png' : '.jpg'));
  return folder.createFile(blob);
}

function saveImage_(folder, name, dataUrl) {
  return saveImageFile_(folder, name, dataUrl).getUrl();
}
