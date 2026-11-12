// Only a confirmed integration link is evidence that the target App has accepted the candidate.
// The candidate's own state is not the cross-app acknowledgement.
export function studySyncState(candidate) {
  const state=candidate?.integration_state;
  if(state==='synced'||state==='linked_existing')return 'linked';
  if(state==='failed')return 'failed';
  if(state==='sending')return 'sending';
  return 'pending';
}
