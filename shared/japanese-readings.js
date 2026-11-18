// Small, reviewed readings for frequent Japanese household and billing terms.
// These override AI guesses; unknown kanji terms remain explicitly UNVERIFIED.
// No network calls, AI quotas, device storage or new Cloudflare resources.
export const VERIFIED_JAPANESE_READINGS = Object.freeze({
  '賦課金':'ふかきん',
  '再エネ賦課金':'さいエネふかきん',
  '再生可能エネルギー発電促進賦課金':'さいせいかのうえねるぎーはつでんそくしんふかきん',
  '燃料費調整額':'ねんりょうひちょうせいがく',
  '燃料費調整':'ねんりょうひちょうせい',
  '電気料金':'でんきりょうきん',
  '水道料金':'すいどうりょうきん',
  'ガス料金':'がすりょうきん',
  '使用電力量':'しようでんりょくりょう',
  '使用量':'しようりょう',
  '使用期間':'しようきかん',
  '基本料金':'きほんりょうきん',
  '料金明細':'りょうきんめいさい',
  '請求金額':'せいきゅうきんがく',
  'ご請求金額':'ごせいきゅうきんがく',
  '支払期限':'しはらいきげん',
  '支払期日':'しはらいきじつ',
  '納付期限':'のうふきげん',
  '納付書':'のうふしょ',
  '口座振替':'こうざふりかえ',
  '口座引き落とし':'こうざひきおとし',
  '引落日':'ひきおとしび',
  '引落金額':'ひきおとしきんがく',
  '振替':'ふりかえ',
  '振込':'ふりこみ',
  '振込手数料':'ふりこみてすうりょう',
  '手数料':'てすうりょう',
  '源泉徴収':'げんせんちょうしゅう',
  '所得税':'しょとくぜい',
  '住民税':'じゅうみんぜい',
  '年末調整':'ねんまつちょうせい',
  '確定申告':'かくていしんこく',
  '扶養控除':'ふようこうじょ',
  '控除':'こうじょ',
  '給与明細':'きゅうよめいさい',
  '差引支給額':'さしひきしきゅうがく',
  '支給額':'しきゅうがく',
  '賞与':'しょうよ',
  '保険料':'ほけんりょう',
  '年金保険料':'ねんきんほけんりょう',
  '非課税':'ひかぜい',
  '課税所得':'かぜいしょとく',
  '申請':'しんせい',
  '申請期限':'しんせいきげん',
  '必着':'ひっちゃく',
  '消印有効':'けしいんゆうこう',
  '対象外':'たいしょうがい',
  '併用不可':'へいようふか',
  '自動更新':'じどうこうしん',
  '契約更新':'けいやくこうしん',
  '更新料':'こうしんりょう',
  '延滞金':'えんたいきん',
  'お届け予定':'おとどけよてい',
  '営業時間':'えいぎょうじかん'
});
const normalizeKana=value=>String(value||'').normalize('NFKC').trim()
  .replace(/[ァ-ヶ]/g,ch=>String.fromCharCode(ch.charCodeAt(0)-96))
  .replace(/\s+/g,'');
export const isValidJapaneseReading=value=>/^[ぁ-ゖー]+$/u.test(normalizeKana(value));
export function resolveJapaneseReading(term,proposed=''){
  const word=String(term||'').normalize('NFKC').trim();
  const fixed=VERIFIED_JAPANESE_READINGS[word];
  if(fixed)return {reading:normalizeKana(fixed),verified:true,source:'reviewed-glossary'};
  // Kana-only words (including loans like チャージ) have an unambiguous kana reading.
  if(/^[ぁ-ゖァ-ヶー]+$/u.test(word))
    return {reading:normalizeKana(word),verified:true,source:'kana-original'};
  const reading=normalizeKana(proposed);
  return {reading:isValidJapaneseReading(reading)?reading:'',verified:false,source:'ai-unverified'};
}
