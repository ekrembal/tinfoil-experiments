import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { AGENT } from './runner.mjs';
import { attest,canonical,sha256,sha256File,describeDist,signingKey,signature,verifyEnvelope } from './provenance.mjs';

const dev=process.env.DEV_MODE==='1', token=process.env.JOBS_BEARER_TOKEN;
if(process.env.TINFOIL_API_KEY)throw new Error('signer must not receive the inference key');
const workerURL=new URL(process.env.WORKER_URL||'http://worker:8081');
const bindAddress=process.env.SIGNER_BIND_ADDRESS||'0.0.0.0';
if(!dev&&!process.env.SIGNER_BIND_ADDRESS)throw new Error('production signer requires a shim-only bind address');
const timeoutMs=Number(process.env.JOB_TIMEOUT_SECONDS||'900')*1000;
if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>2147483647)throw new Error('JOB_TIMEOUT_SECONDS must be a positive supported wall-clock timeout');
if(!token || token.length<16)throw new Error('JOBS_BEARER_TOKEN must be at least 16 characters');
if(!dev && (!/^sha256:[0-9a-f]{64}$/.test(process.env.HARNESS_IMAGE_DIGEST||'') || !process.env.CONFIG_REPO))throw new Error('production requires image digest and expected config repository');
const root=path.resolve(process.env.DATA_DIR||'/data'), key=await signingKey(dev),jobs=new Map();
await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);
const workRoot='/workspaces';await mkdir(workRoot,{recursive:true});await chmod(workRoot,0o711);
let busy=false;
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}
async function run(job,prompt,parent) {
  busy=true;job.status='running';
  const dir=path.join(root,job.id);
  const rawLogPath=path.join(workRoot,`${job.id}.pi.jsonl`),deadline=Date.now()+timeoutMs;
  const log=s=>{job.logs=(job.logs+s).slice(-1024*1024);console.log(`[${job.id}] ${s.trimEnd()}`);};
  try {
    await mkdir(dir,{recursive:true,mode:0o700});
    await writeFile(rawLogPath,'',{mode:0o600});
    const request=async(route,options={})=>{
      const remaining=deadline-Date.now();if(remaining<=0)throw new Error('job wall-clock timeout');
      const response=await fetch(new URL(route,workerURL),{...options,signal:AbortSignal.timeout(remaining),redirect:'error'});
      if(!response.ok)throw new Error(`worker HTTP ${response.status}`);return response;
    };
    const created=await(await request('/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt})})).json();
    if(!/^[0-9a-f-]{36}$/.test(created.id))throw new Error('invalid worker job ID');
    const route=`/jobs/${created.id}`;
    let result;
    for(;;){
      result=await(await request(route)).json();
      if(!['queued','running','completed','failed'].includes(result.status)||typeof result.logs!=='string')throw new Error('invalid worker status');
      job.logs=result.logs.slice(-1024*1024);
      if(['completed','failed'].includes(result.status))break;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    await pipeline(Readable.fromWeb((await request(`${route}/log`)).body),createWriteStream(rawLogPath,{mode:0o600}));
    if(result.status==='failed')throw new Error('worker job failed');
    if(canonical(result.metadata?.agent)!==canonical(AGENT)||result.metadata.model!==(process.env.MODEL||'deepseek-v4-1-flash'))throw new Error('unexpected worker agent or model');
    const archive=path.join(dir,'artifact.tar.gz');
    await pipeline(Readable.fromWeb((await request(`${route}/artifact`)).body),createWriteStream(archive,{mode:0o600}));
    let unsafe=false;
    await tar.t({file:archive,strict:true,filter:(name,entry)=>{
      if(!['File','Directory'].includes(entry.type)||name.startsWith('/')||name.split('/').includes('..')||!(name==='dist'||name.startsWith('dist/')))unsafe=true;
      return true;
    }});
    if(unsafe)throw new Error('unsafe archive entry');
    await tar.x({file:archive,cwd:dir,strict:true,preservePaths:true,noChown:true});
    const dist=path.join(dir,'dist');
    const description=await describeDist(dist);
    if(!description.manifest.length)throw new Error('empty build output');
    const transcript_sha256=await sha256File(rawLogPath);
    const statement={_type:'https://in-toto.io/Statement/v1',subject:[{name:'dist.tar.gz',digest:{sha256:await sha256File(archive)}}],predicateType:'https://attestai.local/job/v1',predicate:{mode:dev?'dev':'tinfoil',harness_image_digest:process.env.HARNESS_IMAGE_DIGEST||'dev/unpinned',config:{repo:process.env.CONFIG_REPO||'ekrembal/tinfoil-experiments'},model:process.env.MODEL||'deepseek-v4-1-flash',prompt,prompt_sha256:sha256(prompt),parent_statement_sha256:parent?sha256(canonical(parent.statement)):null,artifact:description,inference_verification:{...result.metadata.inference_verification,transcript_sha256}}};
    statement.predicate.agent=AGENT;
    statement.predicate.transcript={name:'pi.jsonl',sha256:transcript_sha256};
    const envelope={statement,...signature(statement,key),attestation:dev?{type:'dev/none'}:await attest(statement),...(parent?{parent}:{})};
    await writeFile(path.join(dir,'statement.json'),JSON.stringify(envelope,null,2));
    job.status='completed';log('job completed\n');
  }catch(error){job.status='failed';log(`ERROR: ${error.message}\n`);}finally{busy=false;}
}
const server=http.createServer(async(req,res)=>{
  try {
    const got=Buffer.from(req.headers.authorization||''),expected=Buffer.from(`Bearer ${token}`);
    if(got.length!==expected.length||!timingSafeEqual(got,expected))return json(res,401,{error:'unauthorized'});
    if(req.method==='POST' && req.url==='/jobs') {
      if(busy)return json(res,409,{error:'one job at a time'});
      let data='';for await(const chunk of req){data+=chunk;if(data.length>2*1024*1024)return json(res,413,{error:'request too large'});}
      let body;try{body=JSON.parse(data);}catch{return json(res,400,{error:'invalid JSON'});}
      if(typeof body.prompt!=='string'||!body.prompt.trim()||body.prompt.length>64000)return json(res,400,{error:'nonempty prompt (max 64000 characters) required'});
      if(body.parent_statement) {
        try {await verifyEnvelope(body.parent_statement,{allowDev:dev,repo:process.env.CONFIG_REPO});}catch(error){return json(res,400,{error:`invalid parent: ${error.message}`});}
      }
      if(busy)return json(res,409,{error:'one job at a time'});
      const job={id:randomUUID(),status:'queued',logs:''};jobs.set(job.id,job);
      void run(job,body.prompt,body.parent_statement);
      return json(res,202,{id:job.id});
    }
    const match=/^\/jobs\/([0-9a-f-]{36})(?:\/(artifact|statement|log))?$/.exec(req.url);
    if(req.method!=='GET'||!match||!jobs.has(match[1]))return json(res,404,{error:'not found'});
    const job=jobs.get(match[1]);
    if(!match[2])return json(res,200,job);
    if(match[2]==='log'){
      const stream=createReadStream(path.join(workRoot,`${job.id}.pi.jsonl`));
      try {await new Promise((resolve,reject)=>{stream.once('open',resolve);stream.once('error',reject);});}
      catch(error){if(error.code==='ENOENT')return json(res,409,{error:'log not available yet'});throw error;}
      res.writeHead(200,{'Content-Type':'application/x-ndjson'});
      await pipeline(stream,res);return;
    }
    if(job.status!=='completed')return json(res,409,{error:'job not completed'});
    const artifact=match[2]==='artifact';
    res.writeHead(200,{'Content-Type':artifact?'application/gzip':'application/json'});
    res.end(await readFile(path.join(root,job.id,artifact?'artifact.tar.gz':'statement.json')));
  }catch(error){if(res.headersSent){res.destroy(error);return;}json(res,500,{error:error.message});}
});
server.requestTimeout=30000;
server.listen(Number(process.env.PORT||8080),bindAddress,()=>console.log('attestai harness listening on 8080'));
