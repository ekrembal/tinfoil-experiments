import jsonStream from 'stream-json';

export function tailText(text,bytes) {
  let tail=Buffer.from(text).subarray(-bytes);
  while(tail.length&&(tail[0]&0xc0)===0x80)tail=tail.subarray(1);
  return tail.toString('utf8');
}
export function piTranscript(log,summaryBytes=2048) {
  const stream=jsonStream.parser({jsonStreaming:true,packStrings:false,streamKeys:false,packNumbers:false});
  const stack=[];
  let event={},stringPath,stringValue='',lastAssistant,ended=false,error;
  const valuePath=()=>{const top=stack.at(-1);return top?[...top.path,top.array?top.index:top.key]:[];};
  const advance=()=>{const top=stack.at(-1);if(top?.array)top.index++;};
  const append=(field,value)=>{event[field]=tailText((event[field]||'')+value,summaryBytes);};
  const selected=path=>path.length===1&&['type','toolName'].includes(path[0]) || path[0]==='message'&&(path.length===2&&['role','stopReason','errorMessage'].includes(path[1]) || path[1]==='content'&&['text','name'].includes(path[3])) || path[0]==='result'&&path[1]==='content'&&path[3]==='text';
  stream.on('data',token=>{
    if(token.name==='keyValue'){stack.at(-1).key=token.value;return;}
    if(token.name==='startObject'||token.name==='startArray'){stack.push({path:valuePath(),array:token.name==='startArray',index:0});return;}
    if(token.name==='endObject'||token.name==='endArray'){
      stack.pop();advance();
      if(!stack.length){
        if(event.type==='message_end'&&event.role==='assistant'){
          lastAssistant={stopReason:event.stopReason,errorMessage:event.errorMessage};
          if(event.text)log(`assistant: ${event.text}\n`);
          if(event.tools)log(`tool calls: ${event.tools}\n`);
          if(event.errorMessage)log(`agent error: ${event.errorMessage}\n`);
        }
        if(event.type==='tool_execution_start')log(`tool: ${event.toolName}\n`);
        if(event.type==='tool_execution_end')log(`tool result: ${event.result||'(empty)'}\n`);
        if(event.type==='agent_end')ended=true;
        event={};
      }
      return;
    }
    if(token.name==='startString'){stringPath=valuePath();stringValue='';return;}
    if(token.name==='stringChunk'){if(selected(stringPath))stringValue=tailText(stringValue+token.value,summaryBytes);return;}
    if(token.name==='endString'){
      const p=stringPath;
      if(selected(p)){
        if(p.length===1)event[p[0]]=stringValue;
        else if(p[0]==='message'&&p.length===2)event[p[1]]=stringValue;
        else if(p[0]==='message')append(p[3]==='text'?'text':'tools',stringValue+' ');
        else append('result',stringValue+' ');
      }
      advance();return;
    }
    if(['endNumber','nullValue','trueValue','falseValue'].includes(token.name))advance();
  });
  stream.on('error',cause=>{error=cause;});
  return {
    write:chunk=>{if(!error)stream.write(chunk);},
    async finish(){
      if(!error)await new Promise(resolve=>{stream.once('end',resolve);stream.once('error',resolve);stream.end();});
      if(error)throw new Error(`invalid Pi event stream: ${error.message}`);
      if(!ended||lastAssistant?.stopReason!=='stop')throw new Error(lastAssistant?.errorMessage||`agent did not complete (${lastAssistant?.stopReason||'no final assistant message'})`);
    }
  };
}
