/**
 * Reset every scope-sensitive field before showing a different candidate.
 * Retries deliberately restore the saved immutable draft AFTER this reset.
 * Never let an old document's privacy confirmation or assignee bleed through.
 */
export function resetCandidateConfirmation(draft,{title='',term='',sentence=''}={}){
 draft.title=title;
 draft.visibility='private';
 draft.assignee='';
 draft.bonus_points=0;
 draft.reminder_only=false;
 draft.privacy_confirmed=false;
 draft.task_share_confirmed=false;
 draft.redacted_term=term;
 draft.redacted_sentence=sentence;
 return draft;
}
