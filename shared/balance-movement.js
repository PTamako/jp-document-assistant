// A receipt that moves stored value or points is not a household income/expense.
// Keep these ambiguous transactions out of the generic finance bridge until a
// dedicated, account-aware transfer executor verifies both sides of the movement.
// Ordinary payments such as "PayPay支払い" are deliberately NOT blocked.
const storedValue=/(?:Suica|PASMO|ICOCA|TOICA|manaca|SUGOCA|nimoca|はやかけん|nanaco|WAON|(?:楽天)?Edy|PayPay|楽天ペイ|交通系IC|電子マネー|电子钱包|電子錢包|储值卡|儲值卡|储值|儲值|ポイント|积分|積分)/i;
const movement=/(?:チャージ|充值|残高(?:移動|振替|移行|への入金)|資金移動|ポイント(?:交換|移行|還元|付与|獲得)|积分(?:兑换|兌換|充值|转入|轉入|转出)|入金完了|受取完了|交換|移行|還元|付与|獲得|返金)/i;

export function isUnsupportedBalanceMovement(merchant){
 const value=typeof merchant==='string'?merchant.trim():'';
 return value.length>0&&value.length<=500&&storedValue.test(value)&&movement.test(value);
}
