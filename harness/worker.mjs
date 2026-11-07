import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, cp, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { lookup } from 'node:dns/promises';
import * as tar from 'tar';
import { runAgent,execute,prepareWorkspace,AGENT } from './runner.mjs';
import { files } from './provenance.mjs';
import { buildProfile } from './profile.mjs';

const profile=buildProfile(process.env.APP_PROFILE??(process.env.DEV_MODE==='1'?'offline':undefined));
const timeoutMs=Number(process.env.JOB_TIMEOUT_SECONDS||'900')*1000;
if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>2147483647)throw new Error('invalid job wall-clock timeout');
if(process.env.JOBS_BEARER_TOKEN)throw new Error('worker must not receive the signer bearer token');
if(process.env.DEV_MODE!=='1'&&!process.env.SIGNER_HOST)throw new Error('worker requires its internal signer hostname');
let bindAddress='0.0.0.0';
if(process.env.SIGNER_HOST){
  const peers=await lookup(process.env.SIGNER_HOST,{all:true,family:4});
  const addresses=Object.values(networkInterfaces()).flat().filter(address=>address.family==='IPv4'&&!address.internal&&peers.some(peer=>{
    const ip=address.address.split('.').map(Number),mask=address.netmask.split('.').map(Number),other=peer.address.split('.').map(Number);
    return ip.every((part,i)=>(part&mask[i])===(other[i]&mask[i]));
  }));
  if(addresses.length!==1)throw new Error('worker requires exactly one network shared with signer');
  bindAddress=addresses[0].address;
}
const jobs=new Map();
let busy=false;
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
async function run(job,prompt) {
  busy=true;job.status='running';
  const dir=path.join('/data',job.id),workspace=path.join('/workspaces',job.id),deadline=Date.now()+timeoutMs;
  const log=text=>{job.logs=(job.logs+text).slice(-1024*1024);};
  try {
    await mkdir(dir,{recursive:true});
    await writeFile(path.join(dir,'pi.jsonl'),'');
    await cp('/opt/app/templates/react',workspace,{recursive:true});
    await prepareWorkspace(workspace);
    const install=profile.profile==='offline'?['install','--offline','--frozen-lockfile','--ignore-scripts','--store-dir=/opt/store']:['install','--frozen-lockfile','--ignore-scripts',`--store-dir=${path.join(workspace,'.pnpm-store')}`];
    await execute(workspace,'pnpm',install,log,{}, {timeoutMs:deadline-Date.now()});
    const inference=await runAgent(workspace,prompt,process.env.MODEL||'deepseek-v4-1-flash',log,{dev:process.env.DEV_MODE==='1',mockURL:process.env.MOCK_INFERENCE_URL,rawLogPath:path.join(dir,'pi.jsonl'),timeoutMs:deadline-Date.now()});
    await execute(workspace,'pnpm',['build'],log,{}, {timeoutMs:deadline-Date.now()});
    await files(path.join(workspace,'dist'));
    await tar.c({gzip:true,file:path.join(dir,'artifact.tar.gz'),cwd:workspace,portable:true,mtime:new Date(0),noMtime:true},['dist']);
    job.metadata={...profile,agent:AGENT,model:process.env.MODEL||'deepseek-v4-1-flash',inference_verification:inference};
    job.status='completed';
  }catch(error){job.status='failed';log(`ERROR: ${error.message}\n`);}finally{busy=false;}
}
const server=http.createServer(async(req,res)=>{
  try {
    if(req.method==='POST'&&req.url==='/jobs') {
      if(busy)return json(res,409,{error:'one job at a time'});
      let data='';for await(const chunk of req){data+=chunk;if(data.length>2*1024*1024)return json(res,413,{error:'request too large'});}
      let body;try{body=JSON.parse(data);}catch{return json(res,400,{error:'invalid JSON'});}
      if(typeof body.prompt!=='string'||!body.prompt.trim()||body.prompt.length>64000)return json(res,400,{error:'nonempty prompt (max 64000 characters) required'});
      if(body.profile!==profile.profile)return json(res,400,{error:'worker profile mismatch'});
      if(busy)return json(res,409,{error:'one job at a time'});
      const job={id:randomUUID(),status:'queued',logs:''};jobs.set(job.id,job);void run(job,body.prompt);
      return json(res,202,{id:job.id});
    }
    const match=/^\/jobs\/([0-9a-f-]{36})(?:\/(artifact|log))?$/.exec(req.url);
    if(req.method!=='GET'||!match||!jobs.has(match[1]))return json(res,404,{error:'not found'});
    const job=jobs.get(match[1]);if(!match[2])return json(res,200,job);
    if(match[2]==='artifact'&&job.status!=='completed')return json(res,409,{error:'job not completed'});
    const stream=createReadStream(path.join('/data',job.id,match[2]==='log'?'pi.jsonl':'artifact.tar.gz'));
    try{await new Promise((resolve,reject)=>{stream.once('open',resolve);stream.once('error',reject);});}catch(error){if(error.code==='ENOENT')return json(res,409,{error:'output not available yet'});throw error;}
    res.writeHead(200,{'Content-Type':match[2]==='log'?'application/x-ndjson':'application/gzip'});await pipeline(stream,res);
  }catch(error){if(res.headersSent)res.destroy(error);else json(res,500,{error:error.message});}
});
server.requestTimeout=30000;
server.listen(Number(process.env.WORKER_PORT||8081),bindAddress,()=>console.log('worker listening'));
