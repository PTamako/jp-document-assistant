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
];
export function classifyText(text) {
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
  {key:'amount_jpy', re:/(?:ご請求金額|請求金額|納付金額|お支払金額|合計金額|ご利用金額|金額)[^\n\r\d]{0,18}(?:[¥￥]\s*)?([\d０-９,，]{1,15})\s*円?/g},
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
export function parseJapaneseText(raw) {
  const text = String(raw || '').slice(0,100000);
  const category = classifyText(text);
  const clauses=interpretCriticalClauses(text);
  const issues=[];
  const dates=extractDates(text);
  const fields=[];
  const due=dates.find(d=>d.due_hint);
  if (due) fields.push({field_key:'due_date',value_type:'date',normalized_value:due.date,source_quote:due.source_quote,review_state:'unreviewed'});
  if (dates.some(x=>x.weekday_mismatch)) issues.push('日期与原文星期不一致，请核对原件');
  if(!due && /(\d{1,2}月\d{1,2}日|\d{1,2}\/\d{1,2})/.test(text)) issues.push('存在未注明年份的日期，无法直接确认截止日');
  for(const {key,re} of priority){
    re.lastIndex=0;
    const m=re.exec(text);
    if(!m)continue;
    const value=Number(normDigits(m[1]).replace(/[,，]/g,''));
    if(!Number.isSafeInteger(value)||value<=0)continue;
    const line=text.slice(text.lastIndexOf('\n',m.index-1)+1,text.indexOf('\n',m.index)===-1?text.length:text.indexOf('\n',m.index)).trim().slice(0,200);
    fields.push({field_key:key,value_type:'money',normalized_value:String(value),original_currency:'JPY',source_quote:line || m[0],review_state:'unreviewed'});
  }
  if (category==='salary' && !fields.some(f=>f.field_key==='net_salary')) issues.push('未确认实发金额，不能生成收入');
  const fieldValue=k=>Number(fields.find(f=>f.field_key===k)?.normalized_value);
  if(category==='salary'&&fieldValue('gross_salary')>0&&fieldValue('total_deductions')>0&&fieldValue('net_salary')>0&&
      Math.abs(fieldValue('gross_salary')-fieldValue('total_deductions')-fieldValue('net_salary'))>1)issues.push('应发－扣款与实发不一致，请逐项核查。系统不推定税率或公司计算错误');
  if (/未払い|至急お支払い|アカウント停止|本人確認/.test(text) && /https?:\/\/|短縮URL/.test(text)) issues.push('可能含有催缴链接或钓鱼内容，请通过官方应用/官网核验，勿直接点击');
  if(/(法律|条例|施行|改正|規則)/.test(text)) issues.push('仅解释上传文本，尚未查证现行法律／政策版本');
  if(/(利用速報|仮売上|ご請求予定|請求額)/.test(text)) issues.push('信用卡通知或账单不等于已实际新增消费，请核对家計簿');
  if(/(併用不可|対象外|上限に達し次第|先着|エントリー必須|消印有効)/.test(text)) issues.push('包含活动限制条件，请逐项核对适用资格、报名方式和期限');
  if(/(自動更新|解約期限|違約金|無料期間終了|試用期間)/.test(text)) issues.push('可能存在自动续约或解约/试用期限，须核对正式条款及后续版本');
  if(category==='travel'||category==='hotel')issues.push('预订确认不等于付款或入住；请对照票号/旅客/日期，不公开个人行程');
  if(category==='bank')issues.push('信用卡授权、确定金额、月度合计和退款是不同事件，不能仅凭邮件重复记入支出');
  if(category==='policy'||category==='terms')issues.push('仅解释用户提供的原文，未核验政府或发行机构最新版本，不替代专业建议');
  const sourceDate=dates.find(d=>!d.weekday_mismatch&&/(?:発行日|公布日|公表日|改訂日|更新日)/.test(d.source_quote));
  const policyVersion={source_document_date:sourceDate?.date||null,
    source_date_quote:sourceDate?.source_quote||null,official_current_verified_at:null};
  const vocabulary=gloss.filter(([term])=>text.includes(term)).slice(0,8).map(([term,meaning_zh,reading])=>({term,reading,meaning_zh}));
  const labels={salary:'工资／奖金',bank:'银行／信用卡',tax:'缴纳／税务',insurance:'保险',medical:'医疗通知',government:'行政手续',utility:'水电燃气',housing:'住房／合同',campaign:'活动／优惠',policy:'法规／政策',terms:'合同／使用条款',manual:'使用说明',travel:'航班／旅行',hotel:'酒店预约',shopping:'购物订单',delivery:'配送／订单',other:'其他文书'};
  const summary_zh=`检测到「${labels[category]}」相关表述；以下字段仅为规则提取结果，仍需核对日文原文。`;
  const clauseLines=clauses.length?
   ['关键条款（逐条核对日文原文，未确认个人资格）：',
    ...clauses.map(c=>'· '+c.term+'｜日文证据：「'+c.source_quote+'」｜中文：'+c.meaning_zh+'｜建议：'+c.action_zh)]:[];
  const versionLines=['policy','government','terms','campaign'].includes(category)?
   [policyVersion.source_document_date?
      '原文版本／发布日期线索：'+policyVersion.source_document_date+'（'+policyVersion.source_date_quote+'）':
      '原文版本／发布日期：无法确定，请手动核对',
    '官方现行有效性：尚未核验（official_current_verified_at = null）；不得据此判定个人权益或现行法律。']: [];
  const explanation_zh=[`文书类别建议：${labels[category]}`,...fields.map(f=>`${f.field_key==='due_date'?'疑似截止日':f.field_key==='net_salary'?'疑似实发金额':f.field_key==='gross_salary'?'疑似应发金额':f.field_key==='total_deductions'?'疑似扣款合计':'疑似金额'}：${f.normalized_value}${f.value_type==='money'?' 日元':''}（未核验）`),...clauseLines,...versionLines,...issues.map(x=>`注意：${x}`),'此版本只进行有来源的规则抽取，并非完整机器翻译、OCR 或法律效力核实。'].join('\n');
  return {category,summary_zh,explanation_zh,fields,issues,vocabulary,clauses,policyVersion,analysis_status:'needs_review'};
}
