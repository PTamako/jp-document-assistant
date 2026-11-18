// Gemini rate limits are per Google project. This is the application's conservative
// shared cap based on the project's 500 RPD / 15 RPM AI Studio free-tier screenshot.
// This local counter covers only this app, not other clients using the Google project.
export const GEMINI_MODEL='gemini-3.5-flash-lite';
export const GEMINI_DAY_LIMIT=500;
export const GEMINI_MINUTE_LIMIT=15;

// Google resets RPD at midnight America/Los_Angeles, including DST changes.
export function geminiQuotaSlots(now=new Date()){
 const dayPt=new Intl.DateTimeFormat('sv-SE',{
  timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'
 }).format(now);
 return {dayPt,minuteUtc:now.toISOString().slice(0,16)};
}
export async function geminiQuotaUsage(db,now=new Date()){
 const {dayPt,minuteUtc}=geminiQuotaSlots(now);
 const row=await db.prepare(`SELECT COALESCE(SUM(calls),0) AS calls,
  COALESCE(SUM(CASE WHEN minute_utc=? THEN minute_calls ELSE 0 END),0) AS minute_calls
  FROM gemini_api_daily WHERE day_pt=?`).bind(minuteUtc,dayPt).first();
 const calls=Number(row?.calls||0);
 return {model:GEMINI_MODEL,day_pt:dayPt,calls,limit:GEMINI_DAY_LIMIT,
  remaining:Math.max(0,GEMINI_DAY_LIMIT-calls),
  rpm_limit:GEMINI_MINUTE_LIMIT,
  minute_calls:Number(row?.minute_calls||0),
  scope:'document_assistant_only'};
}
// One atomic UPDATE is the concurrency gate for BOTH family members.
// Every provider attempt is reserved in advance, including bounded retries.
export async function reserveGeminiRequest(db,now=new Date()){
 const {dayPt,minuteUtc}=geminiQuotaSlots(now);
 await db.prepare('INSERT OR IGNORE INTO gemini_api_daily (model_id,day_pt,calls,minute_utc,minute_calls) VALUES(?,?,0,?,0)')
  .bind(GEMINI_MODEL,dayPt,minuteUtc).run();
 const update=await db.prepare(`UPDATE gemini_api_daily
 SET calls=calls+1,
  minute_calls=CASE WHEN minute_utc=? THEN minute_calls+1 ELSE 1 END,
  minute_utc=?
 WHERE model_id=? AND day_pt=?
  AND (SELECT COALESCE(SUM(calls),0) FROM gemini_api_daily WHERE day_pt=?)<?
  AND (SELECT COALESCE(SUM(CASE WHEN minute_utc=? THEN minute_calls ELSE 0 END),0)
       FROM gemini_api_daily WHERE day_pt=?)<?`)
  .bind(minuteUtc,minuteUtc,GEMINI_MODEL,dayPt,dayPt,GEMINI_DAY_LIMIT,minuteUtc,dayPt,GEMINI_MINUTE_LIMIT).run();
 if(update.meta?.changes===1)return {allowed:true};
 const row=await db.prepare('SELECT COALESCE(SUM(calls),0) AS calls FROM gemini_api_daily WHERE day_pt=?')
  .bind(dayPt).first();
 return {allowed:false,code:Number(row?.calls||0)>=GEMINI_DAY_LIMIT?'gemini_daily_limit':'gemini_minute_limit'};
}
