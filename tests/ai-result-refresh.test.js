import test from 'node:test';
import assert from 'node:assert/strict';
import {aiResultReady,isAiJobPending,aiResultBecameAvailable} from '../web/src/ai-state.js';

const pending={ai_job:{state:'running'},ai_analysis:{status:'pending',result:null}};
const finished={ai_job:{state:'running'},ai_analysis:{status:'success',result:{explanation_zh:'已完成中文解释'}}};
test('newly saved AI interpretation is ready even if job flag is still running',()=>{
 assert.equal(isAiJobPending(finished.ai_job),true);
 assert.equal(aiResultReady(finished),true);
 assert.equal(aiResultBecameAvailable(pending,finished),true);
});
test('a failed, empty or stale result must not be presented as newly complete',()=>{
 assert.equal(aiResultReady({ai_analysis:{status:'failed',result:{}}}),false);
 assert.equal(aiResultReady({ai_analysis:{status:'success',result:null}}),false);
 assert.equal(aiResultBecameAvailable(finished,finished),false);
 assert.equal(aiResultBecameAvailable(pending,pending),false);
});
test('a completed or failed job is no longer pending for polling',()=>{
 assert.equal(isAiJobPending({state:'done'}),false);
 assert.equal(isAiJobPending({state:'failed'}),false);
 assert.equal(isAiJobPending({state:'retry_wait'}),true);
});
