import { spawn } from 'node:child_process';
import { mkdir, writeFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { piTranscript,tailText } from './transcript.mjs';
import path from 'node:path';
import { buildProfile } from './profile.mjs';

export const AGENT={name:'pi',package:'@earendil-works/pi-coding-agent',version:'1.5.0'};
export const PROXY={name:'tinfoil-proxy',version:'0.2.9',host:'inference.tinfoil.sh',repo:'tinfoilsh/confidential-model-router'};
export async function execute(workspace,program,args,log=()=>{},extraEnv={}, {rawLogPath,timeoutMs=300000}={}) {
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>2147483647)throw new Error('invalid process wall-clock timeout');
  const raw=rawLogPath?await open(rawLogPath,'w',0o600):null;
  const hash=createHash('sha256'),events=raw?piTranscript(log):null;
  const {profile}=buildProfile(process.env.APP_PROFILE??'offline');
  const installEnv=profile==='offline'?{PI_OFFLINE:'1',COREPACK_ENABLE_NETWORK:'0',npm_config_offline:'true',npm_config_store_dir:'/opt/store'}:{COREPACK_ENABLE_NETWORK:'1',npm_config_store_dir:path.join(workspace,'.pnpm-store')};
  const child=spawn(program,args,{cwd:workspace,env:{PATH:'/opt/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',HOME:workspace,TMPDIR:path.join(workspace,'.tmp'),CI:'true',...installEnv,XDG_CACHE_HOME:path.join(workspace,'.cache'),...extraEnv},stdio:['ignore','pipe','pipe'],detached:true});
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
}
export async function runAgent(workspace,prompt,model,log,{dev=false,mockURL,rawLogPath,timeoutMs}={}) {
  if(mockURL&&!dev)throw new Error('mock inference is development only');
  const configDir=path.join(workspace,'.pi-agent');await mkdir(configDir,{recursive:true});
  await writeFile(path.join(configDir,'models.json'),JSON.stringify({providers:{tinfoil:{baseUrl:(mockURL||'http://127.0.0.1:3301')+'/v1',api:'openai-completions',apiKey:'$TINFOIL_API_KEY',authHeader:true,compat:{supportsDeveloperRole:false,supportsReasoningEffort:false},models:[{id:model,name:model,reasoning:false,input:['text'],contextWindow:128000,maxTokens:16384}]}}}));
  await prepareWorkspace(workspace);
  log(`agent: ${AGENT.name} ${AGENT.version}\n`);
  const {profile}=buildProfile(process.env.APP_PROFILE??'offline');
  const instructions=profile==='offline'?'Build in the current offline Vite React TypeScript Tailwind shadcn PWA starter. Do not add dependencies or use the network. Use pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir=/opt/store and pnpm build. Modify only workspace source files. All dependencies are already baked in. Complete the requested changes, then stop.':`Build in the current Vite React TypeScript Tailwind shadcn PWA starter. Internet access is available. You may install dependencies with npm or pnpm and update package.json and the lockfile. Use pnpm with its writable store at ${path.join(workspace,'.pnpm-store')}. Run pnpm build. Complete the requested changes, then stop.`;
  const transcript_sha256=await execute(workspace,'/opt/app/node_modules/.bin/pi',['-p','--mode','json','--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--provider','tinfoil','--model',model,'--tools','read,bash,edit,write,ls','--append-system-prompt',instructions,prompt],log,{PI_CODING_AGENT_DIR:configDir,TINFOIL_API_KEY:mockURL?'dev-mock':process.env.TINFOIL_API_KEY},{rawLogPath,timeoutMs});
  if(mockURL)return {mode:'dev/mock',proxy:PROXY,transcript_sha256};
  const response=await fetch('http://127.0.0.1:3301/verification-document',{signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('proxy verification document unavailable');
  return {proxy:PROXY,verification_document:await response.json(),transcript_sha256};
}
