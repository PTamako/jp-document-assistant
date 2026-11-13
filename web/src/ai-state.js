// Pure status helpers used by the detail view and its PWA polling.
// A persisted AI result is authoritative even if the separate job finishes a little later.
export function isAiJobPending(job){
 return ['queued','running','retry_wait'].includes(job?.state);
}
export function aiResultReady(document){
 return document?.ai_analysis?.status==='success' &&
  !!document?.ai_analysis?.result;
}
export function aiResultBecameAvailable(previous,next){
 return !aiResultReady(previous) && aiResultReady(next);
}
