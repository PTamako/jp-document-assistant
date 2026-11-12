import { explainNotice } from './notice-context.js';
import { chineseExplanation } from '../web/src/chinese-explanation.js';
import {isSalaryDepositNotice,isCardPurchaseNotice,extractCardPurchaseFields,extractSalaryDepositFields} from './payment-notices.js';
// Safe, deterministic Japanese document pre-analysis. This is NOT OCR or a generative translation.
const gloss = [
  ['納付期限', '缴纳期限', 'のうふきげん'],
  ['支払期限', '付款期限', 'しはらいきげん'],
  ['差引支給額', '实发工资', 'さしひきしきゅうがく'],
  ['控除', '扣除', 'こうじょ'],
  ['振替', '自动扣款／转账', 'ふりかえ'],
  ['対象外', '不适用', 'たいしょうがい'],
  ['併用不可', '不可叠加使用', 'へいようふか'],
  ['自動更新', '自动续约', 'じどうこうしん'],
  ['必着', '必须在截止日前送达', 'ひっちゃく'],
  ['消印有効', '以邮戳日期为准', 'けしいんゆうこう'],
  ['申請', '申请', 'しんせい'],
  ['お支払い', '支付', 'おしはらい'],
  ['口座引き落とし', '银行账户自动扣款', 'こうざひきおとし'],
  ['チャージ', '充值／余额转移', 'ちゃーじ'],
  ['お届け予定', '预计送达', 'おとどけよてい'],
];
// Stored-value top-ups move funds between accounts, not expense or income events.
const storedValueTopup = text =>
  /(?:Suica|PASMO|ICOCA|TOICA|Kitaca|SUGOCA|nimoca|はやかけん|楽天Edy|nanaco|WAON|PayPay|電子マネー|プリペイド|交通系IC)/i.test(text) &&
  /(?:チャージ|受取完了|残高への入金)/.test(text);

export function classifyText(text) {
  if (storedValueTopup(text)) return 'topup';
  if (isSalaryDepositNotice(text)) return 'salary';
  if (isCardPurchaseNotice(text)) return 'card_spend';
  if (/(?:口座引[き]?落[とし]?|口座振替|引落(?:し)?(?:予定日|金額|額))/.test(text)) return 'bank';
  if (/(?:お届け予定日時|配達予定日|配送予定日|お荷物のお届け)/.test(text)) return 'delivery';
  if (/(給与明細|差引支給|支給総額|賞与明細)/.test(text)) return 'salary';
  if (/(カードご利用|利用速報|クレジットカード|ご請求額|利用確定)/.test(text)) return 'bank';
  if (/(納付書|納付期限|税額|保険料|年金保険料)/.test(text)) return 'tax';
  if (/(保険金請求|給付金請求|保険証券|保険契約)/.test(text)) return 'insurance';
  if (/(診療予約|処方箋|受診案内|健診結果)/.test(text)) return 'medical';
  if (/(住民票|区役所|市役所|行政手続)/.test(text)) return 'government';
  if (/(電気料金|ガス料金|水道料金|使用量)/.test(text)) return 'utility';
  if (/(契約更新|家賃|賃貸借)/.test(text)) return 'housing';
  if (/(キャンペーン|ポイント還元|併用不可|対象商品|対象外|エントリー)/.test(text)) return 'campaign';
  if (/(利用規約|自動更新条項|解約手数料|違約金)/.test(text)) return 'terms';
  if (/(施行|条例|法律第|改正法|告示)/.test(text)) return 'policy';
  if (/(取扱説明|使用上の注意|故障|保管方法)/.test(text)) return 'manual';
  if (/(チェックイン日|チェックアウト|宿泊予約|宿泊施設|宿泊プラン)/.test(text)) return 'hotel';
  if (/(航空券|便名|搭乗口|空港|搭乗手続)/.test(text)) return 'travel';
  if (/(注文確認|注文内容|お買い上げ|購入明細|ご注文番号)/.test(text)) return 'shopping';
  if (/(発送|お届け予定|注文番号|配送)/.test(text)) return 'delivery';
  return 'other';
}
const priority = [
  {key:'net_salary', re:/(?:差引支給額|差引支給|手取(?:り)?額)[^\n\r\d]{0,22}(?:[¥￥]\s*)?([\d０-９,，]{1,15})\s*円?/g},
  {key:'gross_salary', re:/(?:総支給額|支給合計)[^\n\r\d]{0,22}(?:[¥￥]\s*)?([\d０-９,，]{1,15})\s*円?/g},
  {key:'total_deductions', re:/(?:控除合計|控除総額)[^\n\r\d]{0,22}(?:[¥￥]\s*)?([\d０-９,，]{1,15})\s*円?/g},
  {key:'amount_jpy', re:/(?:ご請求金額|請求金額|納付金額|お支払金額|合計金額|ご利用金額|引落金額|引き落とし金額|引落額|受取額|チャージ金額|チャージ額|入金額|金額)[^\n\r\d]{0,18}(?:[¥￥]\s*)?([\d０-９,，]{1,15})\s*円?/g},
];
const kanjiWeekdays = ['日','月','火','水','木','金','土'];
const datePattern = /(令和|平成)?\s*(元|[0-9０-９]{1,4})\s*年\s*([0-9０-９]{1,2})\s*月\s*([0-9０-９]{1,2})\s*日(?:\s*[(（]([日月火水木金土])(?:曜(?:日)?)?[)）])?/g;
const westernDatePattern = /(?<![\d０-９])([0-9０-９]{4})\s*[\/.\-]\s*([0-9０-９]{1,2})\s*[\/.\-]\s*([0-9０-９]{1,2})(?:\s*[(（]([日月火水木金土])[)）])?/g;
const dueHint = /(期限|締切|まで|必着|お支払日|納付日|支払期日)/;
const normDigits = str => str.replace(/[０-９]/g,c=>String(c.charCodeAt(0)-65296));
function validDate(year, month, day, week) {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear()!==year || d.getUTCMonth()!==month-1 || d.getUTCDate()!==day) return null;
  return {date:`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,weekday_mismatch: !!week && kanjiWeekdays[d.getUTCDay()] !== week};
}
export function extractDates(text) {
  const all=[];
  for (const [re,era] of [[datePattern,true],[westernDatePattern,false]]) {
    re.lastIndex=0;
    for(const match of text.matchAll(re)) {
      let year,month,day,week;
      if(era){
        const n=match[2]==='元'?1:Number(normDigits(match[2]));
        year=match[1]==='令和'?2018+n:match[1]==='平成'?1988+n:n;
        month=Number(normDigits(match[3]));day=Number(normDigits(match[4])); week=match[5];
      } else {year=Number(normDigits(match[1]));month=Number(normDigits(match[2]));day=Number(normDigits(match[3]));week=match[4];}
      if(year<1900||year>2100)continue;
      const parsed=validDate(year,month,day,week);
      if(!parsed)continue;
      const line=text.slice(text.lastIndexOf('\n',match.index-1)+1, text.indexOf('\n',match.index)===-1?text.length:text.indexOf('\n',match.index)).trim().slice(0,180);
      all.push({...parsed,source_quote:line || match[0],due_hint:dueHint.test(line),index:match.index});
    }
  }
  return all.sort((a,b)=>a.index-b.index);
}
// Source-backed clauses: never infer that this file is legally current or that the user qualifies.
const criticalClauses=[
 ['対象外',/対象外/,'此条件或商品被排除，不能据此认定符合资格','核对对象清单与适用期间'],
 ['併用不可',/併用不可/,'此优惠不能与指定优惠同时使用','核对具体不得叠加的券或活动'],
 ['必着',/必着/,'资料必须在截止日前送达，而非仅寄出','核对送达方式和截止时刻'],
 ['消印有効',/消印有効/,'以规定日期内的邮戳为准，不一定要求当天送达','确认适用邮寄方式'],
 ['上限に達し次第',/上限に達し次第/,'达到人数或额度上限后可能提前结束','核对活动是否仍开放'],
 ['エントリー',/エントリー(?:が必要|必須|してください)?/,'可能需要预先报名，购买本身不代表满足资格','核对报名状态及确认记录'],
 ['自動更新',/自動更新/,'合同或服务可能到期自动续订','核对续订时间与取消方式'],
 ['解約期限',/解約期限/,'取消服务可能有最晚期限','核对正式解约方式及通知时限'],
 ['違約金',/違約金/,'提前解约或违反条款可能产生费用','核对适用条件及金额，不自动推定收费'],
 ['別途料金',/別途料金/,'部分项目可能另外计费','核对项目及是否包含税费'],
 ['原則として',/原則として/,'文字表达原则规则，可能另有例外','继续查看但书与特殊条件'],
 ['例外',/例外/,'存在一般规则之外的条件','人工核实是否符合例外'],
 ['申請が必要',/申請が必要/,'可能需要主动申请，不代表自动享有','核对对象、材料、申请渠道与期限'],
 ['使用上の注意',/使用上の注意/,'产品有需要遵守的安全注意事项','阅读全文并遵守官方说明'],
 ['禁止',/禁止/,'可能存在禁止操作','核对对象、条件及例外'],
 ['施行',/施行/,'提及生效日期，不代表此文件当前仍有效','向官方确认现行版本']
];
export function interpretCriticalClauses(raw,{limit=12}={}){
 const lines=String(raw||'').split(/\r?\n/),found=[];
 for(const [term,re,meaning_zh,action_zh] of criticalClauses){
   const line=lines.find(x=>re.test(x));if(!line)continue;
   found.push({term,source_quote:line.trim().replace(/\s+/g,' ').slice(0,220),
     meaning_zh,action_zh,verified:false});
   if(found.length>=limit)break;
 }
 return found;
}
// Extract only source-labeled values. A service name does not prove the debit account.
function extractTopupFields(text) {
  const fields = [];
  const amt = /(?:受取額|チャージ金額|チャージ額|入金金額|入金額)[ \t　:：]*(?:\r?\n[ \t　]*)?(?:[￥¥][ \t]*)?([0-9０-９][0-9０-９,，]{0,14})[ \t　]*円?/.exec(text);
  if (amt) {
    const amount = Number(normDigits(amt[1]).replace(/[,，]/g,''));
    if (Number.isSafeInteger(amount) && amount>0)
      fields.push({field_key:'amount_jpy',value_type:'money',normalized_value:String(amount),original_currency:'JPY',source_quote:amt[0].slice(0,180),review_state:'unreviewed'});
  }
  const when = /(?:受取完了日時|チャージ完了日時|チャージ日時|入金完了日時|入金日時)[ \t　:：]*(?:\r?\n[ \t　]*)?((?:19|20)\d{2})[\/.\-](\d{1,2})[\/.\-](\d{1,2})[ \t]+([01]?\d|2[0-3]):([0-5]\d)/.exec(text);
  if (when) {
    const date=validDate(Number(when[1]),Number(when[2]),Number(when[3]));
    if (date)
      fields.push({field_key:'transaction_at',value_type:'datetime',normalized_value:`${date.date} ${when[4].padStart(2,'0')}:${when[5]}`,source_quote:when[0].slice(0,180),review_state:'unreviewed'});
  }
  const service = /(?:サービス名)[ \t　:：]*(?:\r?\n[ \t　]*)?([^\r\n]{1,80})/.exec(text);
  if (service && service[1].trim() && !/^[□■●]/.test(service[1].trim()))
    fields.push({field_key:'service_name',value_type:'text',normalized_value:service[1].trim(),source_quote:service[0].slice(0,180),review_state:'unreviewed'});
  return fields;
}

// Utility invoices often quote a metered-period charge and a DIFFERENT amount
// currently billed. Extract only explicitly labelled evidence, never turn card
// advance dates into bill deadlines or assume a discount reason.
function extractElectricityFields(text) {
  if (!/(?:電気|電力|検針|kWh)/i.test(text)) return [];
  const fields=[];
  const add=(key,value_type,normalized_value,source_quote)=>fields.push({
    field_key:key,value_type,normalized_value,
    ...(value_type==='money'?{original_currency:'JPY'}:{}),
    source_quote:source_quote.trim().slice(0,190),review_state:'unreviewed'
  });
  const parseMoney=raw=>{
    const n=Number(normDigits(raw).replace(/[,，]/g,''));
    return Number.isSafeInteger(n)&&n>0?String(n):null;
  };
  const dateText='(?:19|20)[0-9０-９]{2}[\/.-][0-9０-９]{1,2}[\/.-][0-9０-９]{1,2}';
  const parsedDate=raw=>{
    const x=/^([0-9０-９]{4})[\/.-]([0-9０-９]{1,2})[\/.-]([0-9０-９]{1,2})$/.exec(raw);
    if(!x)return null;
    return validDate(Number(normDigits(x[1])),Number(normDigits(x[2])),Number(normDigits(x[3])))?.date||null;
  };
  // Invoice totals take priority over the amount displayed beside meter dates.
  const total=/(?:今回の[ \t　]*ご請求金額[ \t　]*合計|今回の[ \t　]*ご請求金額|ご請求金額[ \t　]*合計|ご請求金額|今回の[ \t　]*請求額)[ \t　:：]*(?:\r?\n[ \t　]*)?(?:[¥￥][ \t]*)?([0-9０-９][0-9０-９,，]{0,14})[ \t]*円?/.exec(text);
  if(total){
    const v=parseMoney(total[1]);
    if(v)add('amount_jpy','money',v,total[0]);
  }
  const periodRe=new RegExp('(?:電気料金の[ \t　]*)?(?:検針期間|ご使用期間|使用期間)[ \t　:：]*(?:\\r?\\n[ \t　]*)?('+dateText+')[ \t]*(?:~|〜|～|–|—|から|至)[ \t]*('+dateText+')[^\\r\\n]{0,80}');
  const period=periodRe.exec(text);
  if(period){
    const start=parsedDate(period[1]),end=parsedDate(period[2]);
    if(start&&end&&start<=end){
      const quote=period[0];
      add('meter_period_start','date',start,quote);
      add('meter_period_end','date',end,quote);
      const trailing=quote.slice(quote.lastIndexOf(period[2])+period[2].length);
      const charge=/(?:[¥￥][ \t]*)?([0-9０-９][0-9０-９,，]{0,14})[ \t]*円/.exec(trailing);
      if(charge){
        const v=parseMoney(charge[1]);
        if(v)add('period_charge_jpy','money',v,quote);
      }
    }
  }
  const usage=/([0-9０-９]+(?:\.[0-9０-９]{1,3})?)[ \t　]*kWh\b/i.exec(text);
  if(usage){
    const value=normDigits(usage[1]);
    if(Number.isFinite(Number(value))&&Number(value)>=0&&Number(value)<=100000000)
      add('usage_kwh','text',value,usage[0]);
  }
  const cardRe=new RegExp('(?:カード立替日|クレジットカード立替日)[ \t　:：]*(?:\\r?\\n[ \t　]*)?('+dateText+')');
  const card=cardRe.exec(text);
  if(card){
    const d=parsedDate(card[1]);
    if(d)add('card_advance_date','date',d,card[0]);
  }
  return fields;
}

// Relative dates and requested actions are useful review fields, but must
// never be promoted to a schedulable YYYY-MM-DD deadline without a year.
// This also works when an AI summary exists but is not part of document_fields.
export function extractActionableTextFields(text,hasFullDueDate=false) {
  const result=[];
  const add=(field_key,normalized_value,source_quote)=>{
    if(result.some(f=>f.field_key===field_key)||!normalized_value||!source_quote.includes(normalized_value))return;
    result.push({field_key,value_type:'text',normalized_value,
      source_quote:source_quote.slice(0,180),review_state:'unreviewed'});
  };
  const lineFor=index=>{
    const start=text.lastIndexOf('\n',Math.max(0,index-1))+1;
    const end=text.indexOf('\n',index);
    return text.slice(start,end<0?text.length:end).trim().slice(0,180);
  };
  if(!hasFullDueDate){
    const partial=/(?<![0-9０-９年])([0-9０-９]{1,2})\s*月\s*([0-9０-９]{1,2})\s*日(?![0-9０-９])/g;
    for(const m of text.matchAll(partial)){
      const month=Number(normDigits(m[1])),day=Number(normDigits(m[2]));
      if(!validDate(2000,month,day))continue; // leap-year allows Feb 29 without assuming a year
      const line=lineFor(m.index);
      const local=text.slice(Math.max(0,m.index-30),Math.min(text.length,m.index+100));
      if(!/(?:期限|締切|必着|までに|まで|提出|申請)/.test(local)
        ||/(?:配達予定|配送予定|口座引落|お届け予定)/.test(local))continue;
      add('due_date_partial',m[0],line||m[0]);
      break;
    }
  }
  const task=/((?:申請書|届出書|必要書類|申込書|書類|資料|証明書)[ \t　]*(?:を|は)?[ \t　]*(?:提出|送付|郵送|持参|アップロード)(?:してください|願います|すること)?)/g;
  for(const m of text.matchAll(task)){add('required_action',m[0],lineFor(m.index)||m[0]);break;}
  const review=/((?:内容|記載事項|申請内容|入力内容)[ \t　]*(?:を|は)?[ \t　]*ご?確認(?:ください|願います|すること)?)/g;
  for(const m of text.matchAll(review)){add('review_action',m[0],lineFor(m.index)||m[0]);break;}
  return result;
}

export function parseJapaneseText(raw) {
  const text = String(raw || '').slice(0,100000);
  const category = classifyText(text);
  const clauses=interpretCriticalClauses(text);
  const issues=[];
  const dates=extractDates(text);
  const fields=category==='topup'?extractTopupFields(text):category==='utility'?extractElectricityFields(text):category==='card_spend'?extractCardPurchaseFields(text):category==='salary'&&isSalaryDepositNotice(text)?extractSalaryDepositFields(text):[];
  const due=dates.find(d=>d.due_hint && !/(?:お届け予定|配達予定|配送予定|口座引落|引き落とし予定|受取完了)/.test(d.source_quote));
  if (due) fields.push({field_key:'due_date',value_type:'date',normalized_value:due.date,source_quote:due.source_quote,review_state:'unreviewed'});
  for(const item of extractActionableTextFields(text,!!due))fields.push(item);
  // Scheduled debit and delivery dates are events, NOT actionable deadlines.
  // Restrict event extraction to those notice categories so receipts cannot make tasks.
  if (category==='bank'||category==='delivery'){
    const event=dates.find(d=>/(?:口座引落|引き落とし|お届け予定|配達予定|配送予定)/.test(text.slice(Math.max(0,d.index-90),d.index+d.source_quote.length)));
    if(event && event!==due)fields.push({field_key:'event_date',value_type:'date',normalized_value:event.date,source_quote:event.source_quote,review_state:'unreviewed'});
  }
  if (dates.some(x=>x.weekday_mismatch)) issues.push('日期与原文星期不一致，请核对原件');
  if(!due && dates.length===0 && /(\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2})/.test(text)) issues.push('存在未注明年份的日期，无法直接确认截止日');
  for(const {key,re} of priority){
    if(fields.some(f=>f.field_key===key))continue; // Prioritize explicitly labelled amounts and prevent duplicates.
    if(category==='topup' && key==='amount_jpy')continue; // No payment or income inference from a top-up.
    re.lastIndex=0;
    const m=re.exec(text);
    if(!m)continue;
    const value=Number(normDigits(m[1]).replace(/[,，]/g,''));
    if(!Number.isSafeInteger(value)||value<=0)continue;
    const line=text.slice(text.lastIndexOf('\n',m.index-1)+1,text.indexOf('\n',m.index)===-1?text.length:text.indexOf('\n',m.index)).trim().slice(0,200);
    fields.push({field_key:key,value_type:'money',normalized_value:String(value),original_currency:'JPY',source_quote:line || m[0],review_state:'unreviewed'});
  }
  if (category==='salary' && !fields.some(f=>f.field_key==='net_salary')) issues.push(isSalaryDepositNotice(text)?'邮件没有注明工资入账金额；可以根据银行明细手动填写后确认收入，不自动猜测金额':'未确认实发金额，不能生成收入');
  const fieldValue=k=>Number(fields.find(f=>f.field_key===k)?.normalized_value);
  if(category==='salary'&&fieldValue('gross_salary')>0&&fieldValue('total_deductions')>0&&fieldValue('net_salary')>0&&
      Math.abs(fieldValue('gross_salary')-fieldValue('total_deductions')-fieldValue('net_salary'))>1)issues.push('应发－扣款与实发不一致，请逐项核查。系统不推定税率或公司计算错误');
  if (/未払い|至急お支払い|アカウント停止|本人確認/.test(text) && /https?:\/\/|短縮URL/.test(text)) issues.push('可能含有催缴链接或钓鱼内容，请通过官方应用/官网核验，勿直接点击');
  if(/(法律|条例|施行|改正|規則)/.test(text)) issues.push('仅解释上传文本，尚未查证现行法律／政策版本');
  if(/(利用速報|仮売上|ご請求予定|請求額)/.test(text)) issues.push('信用卡通知或账单不等于已实际新增消费，请核对家計簿');
  if(/(併用不可|対象外|上限に達し次第|先着|エントリー必須|消印有効)/.test(text)) issues.push('包含活动限制条件，请逐项核对适用资格、报名方式和期限');
  if(/(自動更新|解約期限|違約金|無料期間終了|試用期間)/.test(text)) issues.push('可能存在自动续约或解约/试用期限，须核对正式条款及后续版本');
  if(category==='travel'||category==='hotel')issues.push('预订确认不等于付款或入住；请对照票号/旅客/日期，不公开个人行程');
  if(category==='topup')issues.push('电子钱包充值属于资金转移，不是新增消费或收入；在家計簿记录前须核实真实扣款账户、入账账户及重复记录。');
  if(category==='bank')issues.push('信用卡授权、确定金额、月度合计和退款是不同事件，不能仅凭邮件重复记入支出');
  if(category==='policy'||category==='terms')issues.push('仅解释用户提供的原文，未核验政府或发行机构最新版本，不替代专业建议');
  const sourceDate=dates.find(d=>!d.weekday_mismatch&&/(?:発行日|公布日|公表日|改訂日|更新日)/.test(d.source_quote));
  const policyVersion={source_document_date:sourceDate?.date||null,
    source_date_quote:sourceDate?.source_quote||null,official_current_verified_at:null};
  const vocabulary=gloss.filter(([term])=>text.includes(term)).slice(0,8).map(([term,meaning_zh,reading])=>({term,reading,meaning_zh}));
  const labels={salary:'工资／奖金',card_spend:'信用卡消费',bank:'银行／信用卡',topup:'电子钱包／充值',tax:'缴纳／税务',insurance:'保险',medical:'医疗通知',government:'行政手续',utility:'水电燃气',housing:'住房／合同',campaign:'活动／优惠',policy:'法规／政策',terms:'合同／使用条款',manual:'使用说明',travel:'航班／旅行',hotel:'酒店预约',shopping:'购物订单',delivery:'配送／订单',other:'其他文书'};
  const notice=explainNotice({text,category,fields});
  const summary_zh=notice.summary||`检测到「${labels[category]}」相关表述；提取字段须核对原文。`;
  const clauseLines=clauses.length?
   ['关键注意事项：',...clauses.map(c=>'· '+c.meaning_zh+'；建议：'+c.action_zh)]:[];
  const versionLines=['policy','government','terms','campaign'].includes(category)?
   [policyVersion.source_document_date?
      '文件发布日期线索：'+policyVersion.source_document_date:
      '文件发布日期：无法确定，请手动核对',
    '官方现行有效性：尚未核验，不能据此判断个人资格或现行法律。']: [];
  // Common notices already explain their essential fields in context. Do not
  // repeat every parsed value or attach source_quote lines to the explanation.
  const detailCategories=new Set(['bank','card_spend','topup','salary','tax','delivery','utility']);
  const descriptions={transaction_date:'交易日期',due_date:'待核对截止日',event_date:'事件／预计日期',transaction_at:'交易时间',net_salary:'实发金额',gross_salary:'应发金额',total_deductions:'扣款合计',meter_period_start:'计量期间开始',meter_period_end:'计量期间结束',period_charge_jpy:'期间电费',usage_kwh:'用电量',card_advance_date:'信用卡垫付日期'};
  const fieldLines=detailCategories.has(category)?[]:fields
    .filter(f=>f.value_type!=='text'||f.field_key==='usage_kwh')
    .map(f=>`${descriptions[f.field_key]||'金额或日期线索'}：${f.normalized_value}${f.value_type==='money'?' 日元':''}`);
  const explanation_zh=chineseExplanation([`文书类别：${labels[category]}`,...notice.lines,...fieldLines,...clauseLines,...versionLines,...issues.map(x=>`注意：${x}`)].join('\n'));
  return {category,summary_zh,explanation_zh,fields,issues,vocabulary,clauses,policyVersion,analysis_status:'needs_review'};
}
