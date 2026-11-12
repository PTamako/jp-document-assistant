// Source-backed recognition of Japanese bank salary deposits and card purchases.
// Normalize full-width typography ONLY for detection, retain original source lines.
const norm=t=>String(t||'').normalize('NFKC');
const money=s=>{
 const n=Number(norm(s).replace(/,/g,''));
 return Number.isSafeInteger(n)&&n>0&&n<=999999999999?String(n):null;
};
const civil=(y,m,d)=>{
 y=Number(y);m=Number(m);d=Number(d);
 const v=new Date(Date.UTC(y,m-1,d));
 return y>=1900&&y<=2100&&v.getUTCFullYear()===y&&v.getUTCMonth()===m-1&&v.getUTCDate()===d?
  [y,String(m).padStart(2,'0'),String(d).padStart(2,'0')].join('-'):null;
};
const fld=(field_key,value_type,normalized_value,source_quote)=>({
 field_key,value_type,normalized_value,
 ...(value_type==='money'?{original_currency:'JPY'}:{}),
 source_quote:String(source_quote||'').trim().slice(0,200),review_state:'unreviewed'
});
const extractStamp=(raw,kind)=>{
 const lines=String(raw||'').split(/\r?\n/);
 const marker=kind==='deposit'?/(?:入金日時|お振込日時|振込日時)/:
  /(?:ご利用日時|利用日時|利用日(?:時)?|取引日時|購入日時|注文日時|決済日時|お買(?:い)?上げ日時|購入日|決済日)/;
 const found=lines.findIndex(line=>marker.test(norm(line)));
 if(found<0)return null;
 const source=lines[found];
 let line=norm(source),sourceQuote=source;
 // Only read the next OCR line when it has an explicit transaction-time label.
 // Keep both source lines as evidence so the time is user-verifiable.
 const following=norm(lines[found+1]||'').trim();
 const labeledTime=/^(?:ご利用時刻|利用時刻|購入時刻|取引時刻|決済時刻)\s*[:：]\s*((?:[01]?\d|2[0-3])[:時][0-5]\d)/.exec(following);
 if(!/(?:[01]?\d|2[0-3])[:時][0-5]\d/.test(line)&&labeledTime){
   line+=' '+labeledTime[1];
   sourceQuote=source+' / '+lines[found+1];
 }
 const match=/((?:19|20)\d{2})[\/.\-年]([01]?\d)[\/.\-月]([0-3]?\d)日?\s*(?:[（(][日月火水木金土][)）]\s*)?(?:(\d{1,2})[:時](\d{2})(?:[:分](\d{2}))?秒?)?/.exec(line);
 if(!match)return null;
 const date=civil(match[1],match[2],match[3]);
 if(!date)return null;
 const h=match[4],m=match[5],s=match[6];
 if(h===undefined||m===undefined)return fld('transaction_date','date',date,sourceQuote);
 if(Number(h)>23||Number(m)>59||(s!==undefined&&Number(s)>59))return null;
 const clock=[h.padStart(2,'0'),m,...(s!==undefined?[s]:[])].join(':');
 return fld('transaction_at','datetime',date+' '+clock,sourceQuote);
};
export const isSalaryDepositNotice=raw=>{
 const t=norm(raw);
 return /(?:入金内容|振込(?:による)?ご入金|振込入金|お振込によるご入金)/.test(t)&&/(?:キユウヨ|キュウヨ|給与|サラリー)/.test(t);
};
const cardPurchaseLine=raw=>{
 const lines=String(raw||'').split(/\r?\n/);
 for(const source of lines){
   const n=norm(source).trim();
   // A merchant + itemized amount. Monthly totals, billing or payments are not new purchases.
   if(/(?:請求|引落|合計|返品|返金|取消|キャンセル|チャージ)/.test(n))continue;
   const m=/^(.{2,100}?)(?:[ \t　]*\((?:買物|ショッピング|購入)\))?[ \t　]+([0-9][0-9,]{0,13})[ \t　]*円(?:[ \t]|$)/.exec(n);
   if(!m)continue;
   const value=money(m[2]);
   if(!value)continue;
   const merchant=m[1].trim().replace(/[ \t　]*\((?:買物|ショッピング|購入)\)$/,'').trim();
   if(!merchant||/^(?:日時|ご利用内容|利用明細)/.test(merchant))continue;
   return {merchant,amount:value,source};
 }
 return labeledCardPurchase(raw);
};
// SMBC/Olive single-purchase notifications can place transaction fields on
// separate labeled lines. Reject multi-entry statements and refunds.
function labeledCardPurchase(raw){
 const lines=String(raw||'').split(/\r?\n/);
 const matches=re=>lines.filter(line=>re.test(norm(line).trim()));
 const merchantLines=matches(/^[◇◆■□\s]*(?:(?:ご)?利用先|利用店舗|加盟店(?:名)?|店舗名|ご利用店)\s*[:：]/);
 const amountLines=matches(/^[◇◆■□\s]*(?:ご)?利用金額\s*[:：]/);
 const typeLines=matches(/^[◇◆■□\s]*(?:ご)?利用取引\s*[:：]/);
 if(merchantLines.length!==1||amountLines.length!==1||typeLines.length>1)return null;
 if(typeLines.length&&!/[:：]\s*(?:買物|購入|ショッピング)\s*$/.test(norm(typeLines[0]).trim()))return null;
 const merchant=norm(merchantLines[0]).replace(/^[◇◆■□\s]*(?:(?:ご)?利用先|利用店舗|加盟店(?:名)?|店舗名|ご利用店)\s*[:：]\s*/,'').trim();
 const amountText=norm(amountLines[0]).replace(/^[◇◆■□\s]*(?:ご)?利用金額\s*[:：]\s*/,'').trim();
 const match=/^([0-9][0-9,]{0,13})\s*円\s*$/.exec(amountText);
 const amount=match&&money(match[1]);
 if(!merchant||merchant.length>100||!amount||/(?:取消|キャンセル|返金|返品|チャージ|引落|請求)/.test(merchant))return null;
 return {merchant,amount,source:amountLines[0],merchantSource:merchantLines[0]};
}
export const isCardPurchaseNotice=raw=>{
 const t=norm(raw);
 return /(?:クレジット|カード|Olive)/i.test(t)&&/(?:ご利用日時|利用日時|利用日|取引日時|決済日時)/.test(t)&&
  /(?:カードの利用内容|カードご利用|カードのご利用|利用内容をお知らせ|ご利用内容)/.test(t)&&!!cardPurchaseLine(raw);
};
export function extractCardPurchaseFields(raw){
 const purchase=cardPurchaseLine(raw);
 if(!purchase)return [];
 const fields=[fld('amount_jpy','money',purchase.amount,purchase.source),
   fld('merchant','text',purchase.merchant,purchase.merchantSource||purchase.source)];
 const stamp=extractStamp(raw,'card');
 if(stamp)fields.push(stamp);
 return fields;
}
// Explicit source labels on shopping orders and receipts. No merchant guess
// from the email sender, document title, opening hours, or nearby addresses.
export function extractCommerceFields(raw){
 const lines=String(raw||'').split(/\r?\n/);
 const merchantLabel=/^[◇◆■□\s]*(?:ご利用先|利用店舗|購入店舗|販売店|販売元|加盟店(?:名)?|店舗名|ショップ名|購入先)\s*[:：]\s*/;
 const matches=lines.filter(line=>merchantLabel.test(norm(line).trim()));
 const fields=[];
 if(matches.length===1){
  const merchant=norm(matches[0]).trim().replace(merchantLabel,'').trim();
  if(merchant&&merchant.length<=100&&!/(?:請求|引落|返金|取消|チャージ)/.test(merchant))
   fields.push(fld('merchant','text',merchant,matches[0]));
 }
 const stamp=extractStamp(raw,'commerce');
 if(stamp)fields.push(stamp);
 return fields;
}
export function extractSalaryDepositFields(raw){
 if(!isSalaryDepositNotice(raw))return [];
 const fields=[],stamp=extractStamp(raw,'deposit');
 if(stamp)fields.push(stamp);
 const line=String(raw).split(/\r?\n/).find(s=>/入金内容/.test(norm(s)));
 if(line){
   const payer=norm(line).split(/入金内容[ \t　]*[:：]/)[1]?.trim();
   if(payer&&payer.length<=150)fields.push(fld('deposit_from','text',payer,line));
 }
 // DO NOT fabricate a net_salary field when the notification omits the amount.
 return fields;
}
