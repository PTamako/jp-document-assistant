// Presentation-only transformation of previously stored explanations.
// Preserve the original Japanese in the dedicated 原文 / 字段 tabs; never echo
// evidence quotes or full source lines into the Chinese explanation view.
// Kept pure so new parses and previously imported documents share the rule.
export function chineseExplanation(raw) {
  const source=String(raw||'');
  const cleaned=[];
  for(let entry of source.split(/\r?\n/)){
    let s=entry.trim();
    if(!s)continue;
    if(/^(?:服务线索（日文原文）|扣款内容／相关机构线索（日文原文）|配送时间线索（日文原文）|可核对的日文依据)[：:]/.test(s)){
      // Delivery-time evidence may contain a useful timeslot. Retain only the
      // time in a Chinese sentence, not the source line itself.
      if(s.startsWith('配送时间线索')){
        const period=/(?:AM\s*)?(\d{1,2}):([0-5]\d)\s*[～〜~\-–—]\s*(\d{1,2}):([0-5]\d)/i.exec(s);
        if(period)cleaned.push('预计配送时段：'+period[1].padStart(2,'0')+':'+period[2]+'～'+period[3].padStart(2,'0')+':'+period[4]+'。');
      }
      continue;
    }
    if(s.startsWith('关键条款（逐条核对日文原文')){
      cleaned.push('关键注意事项：');continue;
    }
    if(/^·\s*.*?｜日文证据：/.test(s)){
      const translated=/｜中文：([^｜]+)(?:｜建议：(.+))?/.exec(s);
      if(translated){
        cleaned.push('· '+translated[1].trim()+(translated[2]?'；建议：'+translated[2].trim():''));
      }
      continue;
    }
    s=s.replace(/｜原文：.*$/,'');
    s=s.replace(/（日文原文：[\s\S]*?）/g,'');
    s=s.replace(/^原文版本／发布日期线索：(\d{4}-\d{2}-\d{2})（.*）/,'文件发布日期线索：$1');
    s=s.replace(/^原文版本／发布日期：/,'文件版本／发布日期：');
    s=s.replace(/原文所列/g,'通知所列').replace(/原文提示/g,'通知提示').replace(/原文列出的/g,'通知列出的');
    s=s.replace('原文写有“完成”','通知显示已完成');
    s=s.replace('原文记录日期','记录日期').replace('原文金额线索','金额线索');
    s=s.replace(/“口座引き落とし／口座振替”/g,'银行自动扣款');
    s=s.replace('“予定日”','“预计日”');
    s=s.replace('「給与／キユウヨ」的振込入金','工资转入');
    s=s.replace('カード立替日','信用卡垫付日期');
    s=s.replace(/Olive／クレジット/g,'Olive 信用卡').replace(/家計簿/g,'记账本');
    s=s.replace(/^(?:服务线索|原文依据|日文依据)[：:]/,'相关信息：');
    if(s.startsWith('入金内容／付款方：'))s='工资付款方已识别，具体名称请在字段页核对。';
    if(s.startsWith('消费商户：')&&/[\u3040-\u30ff]/.test(s)){
      s=/マクドナルド/.test(s)?'消费商户：麦当劳移动点餐。':'消费商户已识别，具体名称请在字段页核对。';
    }
    // Release old stored narratives without displaying any remaining kana
    // (including unexpected Japanese excerpts from earlier rule versions).
    if(/[\u3040-\u30ff\u31f0-\u31ff]/.test(s))continue;
    if(s)cleaned.push(s);
  }
  return [...new Set(cleaned)].join('\n');
}
