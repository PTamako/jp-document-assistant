import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudflareGenerationConfig,extractCloudflareResponseText} from '../worker/intelligence.js';

test('Qwen document analysis avoids default high reasoning and bounds JSON output',()=>{
 const config=cloudflareGenerationConfig();
 assert.deepEqual(config.response_format,{type:'json_object'});
 assert.deepEqual(config.chat_template_kwargs,{enable_thinking:false});
 assert.equal(config.reasoning_effort,'low');
 assert.equal(config.max_completion_tokens,2200);
 assert.equal(config.stream,false);
});

test('Cloudflare response extraction still accepts the bound JSON response',()=>{
 assert.equal(extractCloudflareResponseText({choices:[{
  finish_reason:'stop',message:{content:'{"summary_zh":"申请期限已确认"}'}
 }]}),'{"summary_zh":"申请期限已确认"}');
 assert.throws(()=>extractCloudflareResponseText({choices:[{finish_reason:'length'}]}),
  /cloudflare_output_truncated/);
});
