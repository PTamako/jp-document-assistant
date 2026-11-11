import { json, bad, readJson } from './http.js';
import { randomToken, hashString, isoNow } from './security.js';

const first=(db,sql,...params)=>db.prepare(sql).bind(...params).first();
const run=(db,sql,...params)=>db.prepare(sql).bind(...params).run();
const all=async(db,sql,...params)=>(await db.prepare(sql).bind(...params).all()).results||[];
const tokenRe=/^[a-f0-9]{64}$/;
const isoDate=/^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const textEscape=t=>String(t??'').replace(/\r/g,'').replace(/\\/g,'\\\\')
 .replace(/\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
function fold(line){
 const enc=new TextEncoder();const out=[];let chunk='',size=0;
 for(const cp of String(line)){
  const bytes=enc.encode(cp).length;
  if(size+bytes>73){out.push(chunk);chunk=' ';size=1;}
  chunk+=cp;size+=bytes;
 }
 out.push(chunk);
 return out.join('\r\n');
}
function nextDay(date){
 const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+1);
 return d.toISOString().slice(0,10).replace(/-/g,'');
}
export async function calendarStatus(env,p){
 const sub=await first(env.DB,'SELECT revoked_at,include_titles,created_at,updated_at FROM calendar_subscriptions WHERE user_id=?',p.user_id);
 return json({active:!!sub&&!sub.revoked_at,include_titles:!!sub?.include_titles,
   created_at:sub?.created_at||null,note:'订阅链接相当于秘密钥匙；不要分享到公开日历。系统不会用它自动创建推送或修改 HomeFlow。'});
}
export async function createCalendarSubscription(request,env,p){
 const data=await readJson(request,2000);
 if(data.confirm!==true||typeof data.include_titles!=='boolean')
   bad('需要确认日历订阅及标题隐私选项','CONFIRM_REQUIRED',409);
 const raw=randomToken(32),digest=await hashString(raw),now=isoNow();
 await run(env.DB,`INSERT INTO calendar_subscriptions(id,user_id,token_hash,include_titles,created_at,updated_at)
   VALUES(?,?,?,?,?,?)
   ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,
     include_titles=excluded.include_titles,revoked_at=NULL,updated_at=excluded.updated_at`,
   randomToken(16),p.user_id,digest,data.include_titles?1:0,now,now);
 const u=new URL(request.url);
 const link=`${u.origin}/api/calendar/${raw}.ics`;
 return json({ok:true,url:link,includes_titles:data.include_titles,
   note:'只显示已确认截止日期。旧链接立即失效；当前链接只在此响应显示一次，请在 iPhone 日历中添加订阅。'},201);
}
export async function revokeCalendarSubscription(env,p){
 await run(env.DB,'UPDATE calendar_subscriptions SET revoked_at=?,updated_at=? WHERE user_id=? AND revoked_at IS NULL',
   isoNow(),isoNow(),p.user_id);
 return json({ok:true,revoked:true});
}
export async function serveCalendar(request,env,token){
 if(!tokenRe.test(token))bad('日历链接无效','NOT_FOUND',404);
 const hash=await hashString(token);
 const principal=await first(env.DB,`SELECT s.user_id,s.include_titles,u.household_id
   FROM calendar_subscriptions s JOIN users u ON u.id=s.user_id
   WHERE s.token_hash=? AND s.revoked_at IS NULL AND u.status='active'`,hash);
 if(!principal)bad('订阅已撤销或不存在','NOT_FOUND',404);
 // Only text/date fields are selected; never fetch R2, OCR suggestions or financial values.
 const rows=await all(env.DB,`SELECT d.id,d.title,d.version,d.updated_at,f.normalized_value due_date
   FROM documents d JOIN document_fields f ON f.document_id=d.id
   WHERE d.lifecycle='active' AND f.field_key='due_date'
     AND f.review_state IN ('confirmed','corrected')
     AND (d.owner_id=? OR (d.household_id=? AND d.visibility='shared'))
   ORDER BY f.normalized_value ASC,d.id ASC LIMIT 300`,
   principal.user_id,principal.household_id);
 const time=isoNow().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//JP Document Assistant//Private reminders//ZH-CN',
   'CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:私人文书截止日'];
 let count=0;
 for(const d of rows){
  if(!isoDate.test(d.due_date))continue;
  const date=new Date(d.due_date+'T00:00:00Z');
  if(date.toISOString().slice(0,10)!==d.due_date)continue;
  const uid=(await hashString('ics:'+principal.user_id+':'+d.id)).slice(0,40)+'@jp-document-assistant.invalid';
  lines.push('BEGIN:VEVENT',`UID:${uid}`,`DTSTAMP:${time}`,
    `DTSTART;VALUE=DATE:${d.due_date.replace(/-/g,'')}`,
    `DTEND;VALUE=DATE:${nextDay(d.due_date)}`,
    `SUMMARY:${textEscape(principal.include_titles?d.title:'文书截止提醒')}`,
    'DESCRIPTION:请打开私人文书助手核对原文及办理状态。不会自动确认任务完成或付款。',
    `SEQUENCE:${Math.max(0,Math.min(999999,Number(d.version)||0))}`,'END:VEVENT');
  count++;
 }
 lines.push('END:VCALENDAR');
 const body=lines.map(fold).join('\r\n')+'\r\n';
 return new Response(body,{status:200,headers:{
   'Content-Type':'text/calendar; charset=utf-8',
   'Cache-Control':'private, no-store, max-age=0',
   'X-Content-Type-Options':'nosniff',
   'Referrer-Policy':'no-referrer',
   'X-Robots-Tag':'noindex',
   'Content-Disposition':'attachment; filename="document-deadlines.ics"',
   'X-Calendar-Event-Count':String(count)
 }});
}
