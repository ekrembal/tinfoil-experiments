import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAgentCompleted } from '../harness/runner.mjs';
const output=message=>JSON.stringify({type:'agent_end',messages:[message]});
test('Pi JSON mode must end with a successful final assistant message',()=>{
  assert.doesNotThrow(()=>assertAgentCompleted(output({role:'assistant',stopReason:'stop'})));
  assert.throws(()=>assertAgentCompleted(''),/no final assistant message/);
  assert.throws(()=>assertAgentCompleted(output({role:'assistant',stopReason:'error',errorMessage:'401 invalid API key'})),/401 invalid API key/);
  assert.throws(()=>assertAgentCompleted(output({role:'assistant',stopReason:'length'})),/agent did not complete \(length\)/);
  assert.throws(()=>assertAgentCompleted(output({role:'user'})),/no final assistant message/);
  assert.throws(()=>assertAgentCompleted('not JSON'),SyntaxError);
});
