// Apps Script の入力チェック（gas/Validation.gs）を Node で検証する: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = vm.createContext({});
for (const f of ['Options.gs', 'Validation.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', f), 'utf8'), ctx, { filename: f });
}
const { validateRegistration, validateOnboarding } = ctx;

const TODAY = new Date(2026, 9, 5, 10, 0); // 2026-10-05 10:00

function reg(overrides) {
  return Object.assign({
    lastName: '山田', firstName: '花子', lastNameKana: 'やまだ', firstNameKana: 'ﾊﾅｺ',
    birthDate: '2000-04-01', gender: '女性',
    phone: '090-1234-5678', email: 'ｈａｎａｋｏ@example.com',
    postalCode: '530-0001', prefecture: '大阪府', city: '大阪市北区梅田1-2-3', building: '',
    nearestStation: '大阪駅', occupation: 'フリーター',
    weekdays: ['日', '土'], areas: ['京都', '大阪'],
    driverLicense: 'あり', languages: [],
    height: '160', clothingSize: 'M', shoeSize: '23.5', hairColor: '黒・暗めの茶',
    clothes: ['チノパン（ベージュ）', '黒スーツ'], referralSource: 'タイミー',
    interview1: '2026-10-12T14:00', interview2: '', interview3: '', interview4: '',
    note: '', privacyConsent: true, antisocialConsent: true
  }, overrides);
}

function errorsOf(fn) {
  try {
    fn();
  } catch (e) {
    if (e.name === 'ValidationError') return e.errors;
    throw e;
  }
  return {};
}

const IMG = 'data:image/jpeg;base64,/9j/AAAA';

function onb(overrides) {
  return Object.assign({
    nationality: '日本', idType: '運転免許証', idFront: IMG, facePhoto: IMG,
    bankName: '三井住友銀行', bankCode: '０００９', branchName: '渋谷支店', branchCode: '234', accountType: '普通', accountNumber: '12345',
    accountHolder: 'やまだ はなこ', emergencyName: '山田太郎', emergencyRelation: '父',
    emergencyPhone: '0312345678', otherJob: 'なし', health: '', confidentialityConsent: true
  }, overrides);
}

test('正常な登録データを整形する', () => {
  const r = validateRegistration(reg(), TODAY);
  assert.strictEqual(r.lastNameKana, 'ヤマダ');
  assert.strictEqual(r.firstNameKana, 'ハナコ');
  assert.strictEqual(r.phone, '09012345678');
  assert.strictEqual(r.postalCode, '5300001');
  assert.strictEqual(r.areas, '大阪、京都'); // 選択肢の順にそろう
  assert.strictEqual(r.weekdays, '土、日');
  assert.strictEqual(r.email, 'hanako@example.com');
  assert.strictEqual(r.height, 160);
  assert.strictEqual(r.shoeSize, 23.5);
  assert.strictEqual(r.driverLicense, 'あり');
  assert.strictEqual(r.clothes, '黒スーツ、チノパン（ベージュ）');
  assert.strictEqual(r.interview1, '2026/10/12(月) 14:00');
  assert.strictEqual(r.interview2, '');
  assert.strictEqual(r.age, 26);
  assert.strictEqual(r.ageNote, '');
});

test('必須項目・同意の不足を検出する', () => {
  const e = errorsOf(() => validateRegistration(reg({ lastName: ' ', areas: [], interview1: '', privacyConsent: false }), TODAY));
  assert.ok(e.lastName && e.areas && e.interview1 && e.privacyConsent);
});

test('選択肢にない値や不正な形式を拒否する', () => {
  const e = errorsOf(() => validateRegistration(reg({
    gender: '不明', areas: ['東京'], phone: '12345', lastNameKana: 'Yamada', interview1: '2026-10-01T10:00'
  }), TODAY));
  assert.ok(e.gender && e.areas && e.phone && e.lastNameKana && e.interview1);
});

test('18歳未満は注意書きを付ける', () => {
  const r = validateRegistration(reg({ birthDate: '2009-01-01' }), TODAY);
  assert.strictEqual(r.age, 17);
  assert.match(r.ageNote, /18歳未満/);
});

test('当社を知ったきっかけは必須・選択肢から1つ', () => {
  assert.strictEqual(validateRegistration(reg(), TODAY).referralSource, 'タイミー');
  assert.ok(errorsOf(() => validateRegistration(reg({ referralSource: '' }), TODAY)).referralSource);
  assert.ok(errorsOf(() => validateRegistration(reg({ referralSource: 'バイトル' }), TODAY)).referralSource);
});

test('普通免許は必須、服装は任意（選択肢外は不可）', () => {
  assert.ok(errorsOf(() => validateRegistration(reg({ driverLicense: '' }), TODAY)).driverLicense);
  assert.strictEqual(validateRegistration(reg({ clothes: [] }), TODAY).clothes, '');
  assert.ok(errorsOf(() => validateRegistration(reg({ clothes: ['ジーンズ'] }), TODAY)).clothes);
});

test('面接日時は現在時刻の1時間後以降（当日も可）', () => {
  // TODAY は 10/05 10:00
  assert.match(errorsOf(() => validateRegistration(reg({ interview1: '2026-10-05T10:30' }), TODAY)).interview1, /1時間後以降/);
  assert.strictEqual(validateRegistration(reg({ interview1: '2026-10-05T11:00' }), TODAY).interview1, '2026/10/05(月) 11:00');
  assert.strictEqual(validateRegistration(reg({ interview1: '2026-10-05T22:00' }), TODAY).interview1, '2026/10/05(月) 22:00');
});

test('面接日時は30分単位', () => {
  assert.match(errorsOf(() => validateRegistration(reg({ interview1: '2026-10-12T14:15' }), TODAY)).interview1, /30分単位/);
  assert.strictEqual(validateRegistration(reg({ interview1: '2026-10-12T14:30' }), TODAY).interview1, '2026/10/12(月) 14:30');
});

test('面接は第4希望まで。メールは任意。同じ日時の重複は不可', () => {
  const r = validateRegistration(reg({
    email: '', interview2: '2026-10-13T10:00', interview3: '2026-10-14T10:00', interview4: '2026-10-15T18:30'
  }), TODAY);
  assert.strictEqual(r.email, '');
  assert.strictEqual(r.interview4, '2026/10/15(木) 18:30');
  const e = errorsOf(() => validateRegistration(reg({ interview3: '2026-10-12T14:00' }), TODAY));
  assert.match(e.interview3, /第1希望と同じ/);
});

test('登録済みの人の内容変更では面接日時を省略できる', () => {
  assert.ok(errorsOf(() => validateRegistration(reg({ interview1: '' }), TODAY)).interview1);
  const r = validateRegistration(reg({ interview1: '' }), TODAY, { interviewOptional: true });
  assert.strictEqual(r.interview1, '');
});

test('面接日時は90日以内・シートの形式も読める', () => {
  assert.ok(errorsOf(() => validateRegistration(reg({ interview1: '2027-03-01T10:00' }), TODAY)).interview1);
  const r = validateRegistration(reg({ interview1: '2026/10/12(月) 14:00', interview2: '10月13日 9時' }), TODAY);
  assert.strictEqual(r.interview2, '2026/10/13(火) 09:00');
});

test('中学校卒業前（15歳到達後最初の3月31日まで）は登録できない', () => {
  // 2011-04-02 生まれ：2026-04-01 に15歳到達 → 2027-03-31 まで不可
  assert.ok(errorsOf(() => validateRegistration(reg({ birthDate: '2011-04-02' }), TODAY)).birthDate);
  // 2011-04-01 生まれ：2026-03-31 に15歳到達 → 2026-04-01 から可
  assert.deepStrictEqual(errorsOf(() => validateRegistration(reg({ birthDate: '2011-04-01' }), TODAY)), {});
  assert.ok(errorsOf(() => validateRegistration(reg({ birthDate: '2011-04-01' }), new Date(2026, 2, 31))).birthDate);
});

test('存在しない日付を拒否する', () => {
  assert.ok(errorsOf(() => validateRegistration(reg({ birthDate: '2001-02-30' }), TODAY)).birthDate);
});

test('書類提出：口座番号を7桁にそろえ、名義をカタカナにする', () => {
  const { record, images } = validateOnboarding(onb(), TODAY);
  assert.strictEqual(record.accountNumber, '0012345');
  assert.strictEqual(record.accountHolder, 'ヤマダ ハナコ');
  assert.deepStrictEqual(Object.keys(images).sort(), ['facePhoto', 'idFront']);
});

test('書類提出：マイナンバーカードの裏面は受け取らない', () => {
  const { images } = validateOnboarding(onb({ idType: 'マイナンバーカード（表面のみ）', idBack: IMG }), TODAY);
  assert.strictEqual(images.idBack, undefined);
});

test('書類提出：留学で資格外活動許可がない場合は拒否する', () => {
  const base = {
    nationality: '日本以外', residenceStatus: '留学', residenceExpiry: '2027-03-31',
    residenceCardFront: IMG, residenceCardBack: IMG
  };
  assert.ok(errorsOf(() => validateOnboarding(onb(Object.assign({}, base, { workPermission: 'いいえ' })), TODAY)).workPermission);
  const { record } = validateOnboarding(onb(Object.assign({}, base, { workPermission: 'はい' })), TODAY);
  assert.match(record.workCheck, /28時間/);
});

test('書類提出：在留カードの期限切れ・画像不足を拒否する', () => {
  const e = errorsOf(() => validateOnboarding(onb({
    nationality: '日本以外', residenceStatus: '永住者', residenceExpiry: '2026-01-01', residenceCardFront: IMG
  }), TODAY));
  assert.ok(e.residenceExpiry && e.residenceCardBack);
});

test('書類提出：画像以外のデータを拒否する', () => {
  assert.ok(errorsOf(() => validateOnboarding(onb({ facePhoto: 'data:text/html;base64,PHNjcmlwdD4=' }), TODAY)).facePhoto);
});

test('書類提出：他社勤務ありなら申告書の提出状況が必須', () => {
  assert.ok(errorsOf(() => validateOnboarding(onb({ otherJob: 'あり' }), TODAY)).taxDeclarationElsewhere);
});

test('書類提出：先に送った画像の目印（upload:ファイルID）を受け付ける', () => {
  const { images } = validateOnboarding(onb({ idFront: 'upload:1AbCdEfGhIjKlMnOpQrStUv', facePhoto: 'upload:1ZyXwVuTsRqPoNmLkJiHgFe' }), TODAY);
  assert.strictEqual(images.idFront, 'upload:1AbCdEfGhIjKlMnOpQrStUv');
  assert.ok(errorsOf(() => validateOnboarding(onb({ facePhoto: 'upload:../../x' }), TODAY)).facePhoto);
});

test('書類提出：銀行コードは4桁、支店番号は3桁（全角数字も受け付ける）', () => {
  const { record } = validateOnboarding(onb(), TODAY);
  assert.strictEqual(record.bankCode, '0009');
  assert.strictEqual(record.branchCode, '234');
  const errs = errorsOf(() => validateOnboarding(onb({ bankCode: '9', branchCode: '1234' }), TODAY));
  assert.match(errs.bankCode, /4桁/);
  assert.match(errs.branchCode, /3桁/);
});
