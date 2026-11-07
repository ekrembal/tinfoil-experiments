import { spawn } from 'node:child_process';
import { mkdir, readdir, chown, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const AGENT={name:'pi',package:'@earendil-works/pi-coding-agent',version:'1.5.0'};
export const PROXY={name:'tinfoil-proxy',version:'0.2.9',host:'inference.tinfoil.sh',repo:'tinfoilsh/confidential-model-router'};
export function execute(workspace,program,args,log=()=>{},extraEnv={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(program,args,{cwd:workspace,uid:1001,gid:1001,env:{PATH:'/opt/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',HOME:workspace,TMPDIR:path.join(workspace,'.tmp'),CI:'true',PI_OFFLINE:'1',COREPACK_ENABLE_NETWORK:'0',npm_config_offline:'true',npm_config_store_dir:'/opt/store',XDG_CACHE_HOME:path.join(workspace,'.cache'),...extraEnv},stdio:['ignore','pipe','pipe'],detached:true});
    let output='',exceeded=false;
    const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
    const timeout=setTimeout(kill,300000);
    for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{if(output.length+b.length>2*1024*1024){exceeded=true;kill();return;}const s=b.toString();output+=s;log(s);});
    child.on('error',error=>{clearTimeout(timeout);reject(error);});
    child.on('close',code=>{clearTimeout(timeout);kill();code===0&&!exceeded?resolve(output):reject(new Error(`process failed (${code}): ${output.slice(-8000)}`));});
  });
}
export async function prepareWorkspace(workspace) {
  await mkdir(path.join(workspace,'.tmp'),{recursive:true});
  async function own(dir){await chown(dir,1001,1001);for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await own(file);else if(!entry.isSymbolicLink())await chown(file,1001,1001);}}
  await own(workspace);
}
export async function runAgent(workspace,prompt,model,log,{dev=false,mockURL}={}) {
  if(mockURL&&!dev)throw new Error('mock inference is development only');
  const configDir=path.join(workspace,'.pi-agent');await mkdir(configDir,{recursive:true});
  await writeFile(path.join(configDir,'models.json'),JSON.stringify({providers:{tinfoil:{baseUrl:(mockURL||'http://127.0.0.1:3301')+'/v1',api:'openai-completions',apiKey:'TINFOIL_API_KEY',authHeader:true,compat:{supportsDeveloperRole:false,supportsReasoningEffort:false},models:[{id:model,name:model,reasoning:false,input:['text'],contextWindow:128000,maxTokens:16384}]}}}));
  await prepareWorkspace(workspace);
  log(`agent: ${AGENT.name} ${AGENT.version}\n`);
  await execute(workspace,'/opt/app/node_modules/.bin/pi',['-p','--mode','json','--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--provider','tinfoil','--model',model,'--tools','read,bash,edit,write,ls','--append-system-prompt','Build in the current offline Vite React TypeScript Tailwind shadcn PWA starter. Do not add dependencies or use the network. Use pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir=/opt/store and pnpm build. Modify only workspace source files. All dependencies are already baked in. Complete the requested changes, then stop.',prompt],log,{PI_CODING_AGENT_DIR:configDir,TINFOIL_API_KEY:dev?'dev-mock':process.env.TINFOIL_API_KEY});
  if(mockURL)return {mode:'dev/mock',proxy:PROXY};
  const response=await fetch('http://127.0.0.1:3301/verification-document',{signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('proxy verification document unavailable');
  return {proxy:PROXY,verification_document:await response.json()};
}
