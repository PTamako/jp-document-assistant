// Source-grounded, no-network explanations for recurring Japanese life notices.
// This is not a translation model. Never infer a paid transaction, legal validity,
// or a deadline from a mere scheduled/receipt date.
const evidenceLine=(text,re)=>String(text||'').split(/\r?\n/).map(x=>x.trim()).find(x=>re.test(x))?.slice(0,180)||null;
const field=(fields,key)=>fields.find(x=>x.field_key===key)||null;
const money=fields=>{
 const x=field(fields,'amount_jpy')||field(fields,'net_salary');
 return x&&Number.isSafeInteger(Number(x.normalized_value))?Number(x.normalized_value).toLocaleString('ja-JP')+' 日元':null;
};
const days=fields=>{
 const d=field(fields,'transaction_at')||field(fields,'event_date')||field(fields,'due_date');
 return d?d.normalized_value:null;
};
export function explainNotice({text,category,fields}){
 const amount=money(fields),date=days(fields),lines=[];
 let summary=null;
 const receipt=category==='topup'||/(?:Suica|PASMO|交通系IC|電子マネー).{0,80}(?:チャージ|入金|受取)|(?:チャージ|受取).{0,80}(?:Suica|PASMO)/is.test(text);
 const directDebit=/(?:口座引[き]?落[とし]?|口座振替|引落(?:し)?(?:予定日|金額|額))/.test(text);
 const delivery=category==='delivery'||/(?:お届け予定日時|配達予定日|配送予定日|お荷物のお届け)/.test(text);
 if(receipt){
   summary=/(?:Suica|PASMO|ICOCA|TOICA|Kitaca|SUGOCA|nimoca|はやかけん|交通系IC)/i.test(text)?'交通卡充值／余额转移通知':'电子钱包充值／余额转移通知';
   lines.push('这是什么：原文提到电子钱包或交通卡的充值、领取或资金转入。这是储值余额变化的通知，不等于刷卡购物或乘车时新增的消费。');
   if(/(?:完了しました|受取完了|チャージ完了)/.test(text))lines.push('当前状态：原文写有“完成”，表示通知声称该笔充值已经完成；仍以官方账户余额／交易记录为准。');
   if(amount)lines.push('涉及金额：'+amount+'（来自通知原文，需与交通卡交易记录核对）。');
   if(date)lines.push('原文记录日期：'+date+'。这是交易／领取日期，不是办理截止日。');
   const service=evidenceLine(text,/サービス名|サービス提供/);
   if(service)lines.push('服务线索（日文原文）：'+service);
   lines.push('建议：核对 Suica 的充值记录；如果从银行卡或其他余额转入交通卡，记账时通常应先考虑“账户间转移”，避免把充值与后续乘车消费重复计算。');
 }else if(directDebit){
   summary='银行账户扣款通知';
   lines.push('这是什么：这是一份银行账户自动扣款相关通知。“口座引き落とし／口座振替”指从银行账户扣款，并不等于信用卡当天新增一笔消费。');
   if(amount)lines.push('原文所列扣款金额：'+amount+'（尚须核对）。');
   if(date)lines.push('原文所列扣款日期：'+date+'。如果是“予定日”，仅为计划扣款日，不能据此断定扣款已成功。');
   const partner=evidenceLine(text,/^(?:内容|引落先|収納企業名|請求元)[\s　]*[:：]/);
   if(partner)lines.push('扣款内容／相关机构线索（日文原文）：'+partner+'。这不能代表逐笔消费明细。');
   lines.push('建议：在银行官方 App 查看该日扣款是否实际发生，确认余额及账单对应月份；如为信用卡还款，应避免将还款和原消费重复记支出。');
 }else if(delivery){
   summary='包裹配送通知';
   lines.push('这是什么：快递配送或预计送达通知，和支付凭证不是一回事。');
   if(date)lines.push('原文列出的日期：'+date+'。这是预计配送／送达日期，不是必须付款或办理的截止日。');
   const slot=evidenceLine(text,/お届け予定日時|お届け予定日|配達予定|配送予定/);
   if(slot)lines.push('配送时间线索（日文原文）：'+slot);
   lines.push('建议：如果需要改时间或查询进度，请通过快递公司官方 App／官网核对；“预计送达”不代表“已签收”。');
 }else if(category==='salary'){
   summary='工资／奖金明细';
   lines.push('这是什么：工资或奖金明细，应分别看总支给、扣除及实发，不能把应发金额直接视为到账金额。');
   const net=field(fields,'net_salary'),gross=field(fields,'gross_salary'),deduct=field(fields,'total_deductions');
   if(gross)lines.push('应发合计：'+Number(gross.normalized_value).toLocaleString('ja-JP')+' 日元（待核对）。');
   if(deduct)lines.push('扣除合计：'+Number(deduct.normalized_value).toLocaleString('ja-JP')+' 日元（待核对）。');
   if(net)lines.push('实发金额：'+Number(net.normalized_value).toLocaleString('ja-JP')+' 日元（待核对）。');
   lines.push('建议：核对期间、公司名称、实际入账及税社保扣除；工资单不等于银行已到账。');
 }else if(category==='tax'){
   summary='税金／缴费通知';
   lines.push('这是什么：涉及税金、保险费或其他缴费的文书。先确认是哪一种费用、金额和正式期限。');
   if(amount)lines.push('原文金额线索：'+amount+'（需核对是否是本期应缴金额）。');
   const due=field(fields,'due_date');
   if(due)lines.push('原文提示的缴纳／办理期限：'+due.normalized_value+'。请检查是否有例外、延期或已缴记录。');
   lines.push('建议：通过发行机构官方渠道核对是否已经支付及实际缴费方式，避免重复缴款。');
 }else if(category==='campaign'){
   summary='优惠／活动规则';
   lines.push('这是什么：优惠、积分返还或报名活动的说明，重点是参加条件、对象、期限、是否需要报名，以及是否可与其他活动叠加。');
 }else if(category==='shopping'){
   summary='购物／订单通知';
   lines.push('这是什么：购物或订单相关通知；“下单／支付完成／发货／退款”是不同状态，不能混为一笔已完成消费。');
   if(amount)lines.push('原文金额线索：'+amount+'（请核对支付状态）。');
 }else if(category==='medical'){
   summary='医疗通知';
   lines.push('这是什么：医疗预约或诊疗相关文书；应核对预约日期、机构名称和必要携带物，不据此推断诊断结果。');
 }else if(category==='housing'){
   summary='住房／租赁通知';
   lines.push('这是什么：租房、租金或合同相关通知；需要分清缴费、更新、通知和取消条件。');
 }else if(category==='government'||category==='policy'||category==='terms'){
   summary=category==='terms'?'合同／服务条款':category==='policy'?'法规／政策通知':'行政手续通知';
   lines.push('这是什么：涉及规则、合同条件或行政手续的文书。请核对适用对象、必要行动、期限和原文中的例外条件。');
   lines.push('注意：这里仅解释本次提供的文本，没有核验政府或机构公布的最新版本，也不能据此确认个人资格。');
 }else if(category==='manual'){
   summary='商品使用说明';
   lines.push('这是什么：产品使用或注意事项说明。需优先查看禁忌、操作条件、保管方式与故障处理。');
 }else if(category==='insurance'){
   summary='保险通知';
   lines.push('这是什么：保险合同或理赔相关文书。应区分投保、续约、缴费、申请与理赔是否批准。');
 }else if(category==='utility'){
   const electric=/(?:電気|電力|検針|kWh)/i.test(text);
   if(electric){
     summary='电费账单／用电量通知';
     lines.push('这是什么：日本电费通知，包含计量期间、用电量、该期间显示的电费及本次请款金额。各金额不一定相等，不能混为一笔款项。');
     const from=field(fields,'meter_period_start'),to=field(fields,'meter_period_end');
     if(from&&to)lines.push('电费检针期间：'+from.normalized_value+' 至 '+to.normalized_value+'（以原文为准）。');
     const used=field(fields,'usage_kwh');
     if(used)lines.push('本期用电量：'+used.normalized_value+' kWh（来自原文）。');
     const charge=field(fields,'period_charge_jpy');
     const invoice=field(fields,'amount_jpy');
     const showYen=x=>Number(x.normalized_value).toLocaleString('ja-JP')+' 日元';
     if(charge)lines.push('检针期间显示电费：'+showYen(charge)+( /税込/.test(charge.source_quote)?'（原文标记含税）':'')+'；这是期间费用信息，不应替代本次请款总额。');
     if(invoice)lines.push('本次请款金额：'+showYen(invoice)+( /税込/.test(invoice.source_quote)?'（原文标记含税）':'')+'；这是账单当前列示的请款金额，不代表已经扣款。');
     if(charge&&invoice&&Number(charge.normalized_value)!==Number(invoice.normalized_value)){
       const diff=Math.abs(Number(charge.normalized_value)-Number(invoice.normalized_value));
       lines.push('两项金额相差 '+diff.toLocaleString('ja-JP')+' 日元。原文没有说明差额原因，不能擅自判断是折扣、积分、补贴或税费调整，应查询正式明细。');
     }
     const card=field(fields,'card_advance_date');
     if(card)lines.push('カード立替日：'+card.normalized_value+'。这表示通知所列的信用卡垫付日期，不是缴费截止日，也不能据此断定发卡机构已最终扣款。');
     const due=field(fields,'due_date');
     if(due)lines.push('另外，原文明确列出的办理／缴费期限：'+due.normalized_value+'，需核对支付规定。');
     else lines.push('本段没有明确缴费截止日；检针结束日和卡垫付日期都不能当作截止期限。');
     lines.push('建议：向电力公司或支付服务查验请款明细与卡交易状态；在家計簿中先核对是否已经记录，避免重复计费。');
   }else{
     summary='水电燃气通知';
     lines.push('这是什么：生活公共费用通知。请区分账单金额、支付期限和是否已经实际扣款。');
     if(amount)lines.push('原文金额线索：'+amount+'（待核对）。');
   }
 }else if(category==='travel'||category==='hotel'){
   summary=category==='hotel'?'住宿预订通知':'出行／机票通知';
   lines.push('这是什么：预订或行程通知。预订成功与实际付款、入住或乘机不是同一状态。');
 }else{
   summary='一般日文通知';
   lines.push('这是什么：文本中尚未发现足够明确的文书类型；请优先查看标题、发件单位、金额、日期以及是否明确要求你操作。');
 }
 if(!lines.some(s=>s.includes('原文')&&s.includes('线索'))){
   const relevant=evidenceLine(text,/(?:お届け予定|口座引落|チャージ|受取額|請求|支払|期限|必着|予約|申請)/);
   if(relevant)lines.push('可核对的日文依据：'+relevant);
 }
 lines.push('识别边界：以上来自所提供的文字，不代表 OCR 识别准确、交易已结算、资格已确认或法规仍有效。');
 return {summary,lines};
}
