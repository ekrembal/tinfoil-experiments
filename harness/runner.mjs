import { spawn } from 'node:child_process';
import { mkdir, readdir, chown, writeFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { piTranscript,tailText } from './transcript.mjs';
import path from 'node:path';

export const AGENT={name:'pi',package:'@earendil-works/pi-coding-agent',version:'1.5.0'};
export const PROXY={name:'tinfoil-proxy',version:'0.2.9',host:'inference.tinfoil.sh',repo:'tinfoilsh/confidential-model-router'};
export async function execute(workspace,program,args,log=()=>{},extraEnv={}, {rawLogPath,timeoutMs=300000}={}) {
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>2147483647)throw new Error('invalid process wall-clock timeout');
  const raw=rawLogPath?await open(rawLogPath,'w',0o600):null;
  const hash=createHash('sha256'),events=raw?piTranscript(log):null;
  const child=spawn(program,args,{cwd:workspace,uid:1001,gid:1001,env:{PATH:'/opt/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',HOME:workspace,TMPDIR:path.join(workspace,'.tmp'),CI:'true',PI_OFFLINE:'1',COREPACK_ENABLE_NETWORK:'0',npm_config_offline:'true',npm_config_store_dir:'/opt/store',XDG_CACHE_HOME:path.join(workspace,'.cache'),...extraEnv},stdio:['ignore','pipe','pipe'],detached:true});
  let tail='',timedOut=false;
  const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
  const timer=setTimeout(()=>{timedOut=true;kill();},timeoutMs);
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  const consume=async(stream,stdout)=>{
    for await(const chunk of stream){
      if(stdout&&raw){await raw.writeFile(chunk);hash.update(chunk);events.write(chunk);}
      else {const text=chunk.toString();tail=tailText(tail+text,8000);log(text);}
    }
  };
  try {
    const [exit]=await Promise.all([exited,consume(child.stdout,true),consume(child.stderr,false)]);
    if(timedOut)throw new Error(`process wall-clock timeout after ${timeoutMs}ms`);
    if(exit.code!==0)throw new Error(`process failed (${exit.code??exit.signal}): ${tail}`);
    if(events)await events.finish();
    return raw?hash.digest('hex'):undefined;
  } finally {clearTimeout(timer);kill();await raw?.close();}
}
export async function prepareWorkspace(workspace) {
  await mkdir(path.join(workspace,'.tmp'),{recursive:true});
  async function own(dir){await chown(dir,1001,1001);for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await own(file);else if(!entry.isSymbolicLink())await chown(file,1001,1001);}}
  await own(workspace);
}
export async function runAgent(workspace,prompt,model,log,{dev=false,mockURL,rawLogPath,timeoutMs}={}) {
  if(mockURL&&!dev)throw new Error('mock inference is development only');
  const configDir=path.join(workspace,'.pi-agent');await mkdir(configDir,{recursive:true});
  await writeFile(path.join(configDir,'models.json'),JSON.stringify({providers:{tinfoil:{baseUrl:(mockURL||'http://127.0.0.1:3301')+'/v1',api:'openai-completions',apiKey:'$TINFOIL_API_KEY',authHeader:true,compat:{supportsDeveloperRole:false,supportsReasoningEffort:false},models:[{id:model,name:model,reasoning:false,input:['text'],contextWindow:128000,maxTokens:16384}]}}}));
  await prepareWorkspace(workspace);
  log(`agent: ${AGENT.name} ${AGENT.version}\n`);
  const transcript_sha256=await execute(workspace,'/opt/app/node_modules/.bin/pi',['-p','--mode','json','--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--provider','tinfoil','--model',model,'--tools','read,bash,edit,write,ls','--append-system-prompt','Build in the current offline Vite React TypeScript Tailwind shadcn PWA starter. Do not add dependencies or use the network. Use pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir=/opt/store and pnpm build. Modify only workspace source files. All dependencies are already baked in. Complete the requested changes, then stop.',prompt],log,{PI_CODING_AGENT_DIR:configDir,TINFOIL_API_KEY:mockURL?'dev-mock':process.env.TINFOIL_API_KEY},{rawLogPath,timeoutMs});
  if(mockURL)return {mode:'dev/mock',proxy:PROXY,transcript_sha256};
  const response=await fetch('http://127.0.0.1:3301/verification-document',{signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('proxy verification document unavailable');
  return {proxy:PROXY,verification_document:await response.json(),transcript_sha256};
}
