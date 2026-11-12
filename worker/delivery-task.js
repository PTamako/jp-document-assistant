// Source-grounded task suggestions for delivery notices.
// Never touch HomeFlow directly; a candidate still requires field review,
// bridge authorization and explicit user confirmation.
export const todayJst=()=>new Intl.DateTimeFormat('sv-SE',{
 timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'
}).format(new Date());

export function deliveryWindow(raw) {
 const text=String(raw||'');
 // Only a time explicitly attached to a scheduled-delivery heading.
 const heading=/(?:お届け予定日時|お届け予定日|配達予定日時|配送予定日時)[^\r\n]{0,80}(?:\r?\n[^\r\n]{0,170})?/i.exec(text);
 if(!heading)return null;
 const time=/(AM|PM)?[ \t　]*(\d{1,2}):([0-5]\d)[ \t　]*[～〜~\-–—][ \t　]*(AM|PM)?[ \t　]*(\d{1,2}):([0-5]\d)/i.exec(heading[0]);
 if(!time)return null;
 const startMeridiem=time[1]?.toUpperCase()||null;
 const explicitEnd=time[4]?.toUpperCase()||null;
 const toHour=(h,meridiem)=>{
   h=Number(h);
   if(meridiem){
     if(h<1||h>12)return null;
     return h%12+(meridiem==='PM'?12:0);
   }
   return h>=0&&h<=23?h:null;
 };
 const startHour=toHour(time[2],startMeridiem);
 // "AM8:00～12:00" conventionally means noon, not midnight.
 const inferredEnd=explicitEnd||(startMeridiem==='PM'&&Number(time[5])<12?'PM':null);
 const endHour=toHour(time[5],inferredEnd);
 if(startHour===null||endHour===null||endHour*60+Number(time[6])<=startHour*60+Number(time[3]))return null;
 return [String(startHour).padStart(2,'0'),time[3]].join(':')+'～'+[String(endHour).padStart(2,'0'),time[6]].join(':');
}
export function deliveryTaskSuggestion(parsed,original,{visibility='private',today=todayJst()}={}){
 if(parsed?.category!=='delivery')return null;
 const text=String(original||'');
 if(/(?:配達完了|配達済み|お届け完了|お届け済み|配送キャンセル|配送中止)/.test(text))return null;
 const event=parsed.fields?.find(x=>x.field_key==='event_date'&&x.value_type==='date');
 if(!event||!/^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(event.normalized_value))return null;
 if(event.normalized_value<today)return null; // Do not create already-expired tasks for old mail.
 const window=deliveryWindow(text);
 const provider=/佐川急便/.test(text)?'佐川急便':/(?:ヤマト運輸|クロネコヤマト)/.test(text)?'ヤマト運輸':/日本郵便|ゆうパック/.test(text)?'日本郵便':'快递';
 const arrival=window?'（'+window+'）':'';
 const advance=/予定日よりも前にお伺いする|前倒し|早まる場合/.test(text);
 return {
   title:('待收快递｜'+provider+arrival).slice(0,120),
   due_on:event.normalized_value,
   date_field_key:'event_date',
   task_type:'delivery',
   delivery_window:window,
   note:advance?'可能提前配送；如需指定收件时间请查看快递官方通知':'请留意配送通知，必要时调整收货时间',
   visibility,
   requires_confirmation:true
 };
}
