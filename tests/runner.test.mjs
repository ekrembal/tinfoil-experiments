import { test } from 'node:test';
import assert from 'node:assert/strict';
import { piTranscript,tailText } from '../harness/transcript.mjs';
const output=message=>[JSON.stringify({type:'message_end',message}),JSON.stringify({type:'agent_end'})].join('\n')+'\n';
async function check(text){
  let tail='';const events=piTranscript(value=>{tail=tailText(tail+value,4096);});
  const bytes=Buffer.from(text);for(let i=0;i<bytes.length;i+=11)events.write(bytes.subarray(i,i+11));
  await events.finish();return tail;
}
test('Pi JSON mode requires a successful final assistant message',async()=>{
  assert.match(await check(output({role:'assistant',stopReason:'stop',content:[{type:'text',text:'Done'}]})),/assistant: Done/);
  await assert.rejects(check(''),/no final assistant message/);
  await assert.rejects(check(output({role:'assistant',stopReason:'error',errorMessage:'401 invalid API key'})),/401 invalid API key/);
  await assert.rejects(check(output({role:'assistant',stopReason:'length'})),/agent did not complete \(length\)/);
  await assert.rejects(check(output({role:'user'})),/no final assistant message/);
  await assert.rejects(check('not JSON'),/invalid Pi event stream/);
});
test('human-readable summaries exclude thinking and bound large text and results',async()=>{
  const events=[{type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'PRIVATE THINKING'}},{type:'tool_execution_start',toolName:'bash'},{type:'tool_execution_end',result:{content:[{type:'text',text:'x'.repeat(100000)+'result done'}]}},{type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'thinking',thinking:'PRIVATE THINKING'},{type:'text',text:'Finished 🦊'},{type:'toolCall',name:'write',arguments:{content:'not a summary'}}]}},{type:'agent_end'}];
  const tail=await check(events.map(event=>JSON.stringify(event)).join('\n'));
  assert.ok(Buffer.byteLength(tail)<=4096);assert.match(tail,/tool: bash/);assert.match(tail,/result done/);assert.match(tail,/Finished 🦊/);assert.match(tail,/tool calls: write/);assert.doesNotMatch(tail,/PRIVATE THINKING|not a summary/);
});
