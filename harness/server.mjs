import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, cp, writeFile, readFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { runAgent,execute,prepareWorkspace,AGENT } from './runner.mjs';
import { attest,canonical,sha256,describeDist,signingKey,signature,verifyEnvelope } from './provenance.mjs';

const dev=process.env.DEV_MODE==='1', token=process.env.JOBS_BEARER_TOKEN;
if(!token || token.length<16)throw new Error('JOBS_BEARER_TOKEN must be at least 16 characters');
if(!dev && (!/^sha256:[0-9a-f]{64}$/.test(process.env.HARNESS_IMAGE_DIGEST||'') || !process.env.CONFIG_REPO))throw new Error('production requires image digest and expected config repository');
const root=path.resolve(process.env.DATA_DIR||'/data'), key=await signingKey(dev),jobs=new Map();
await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);
// Workspace traversal requires execute, but private results and keys remain root-only.
const workRoot='/workspaces';await mkdir(workRoot,{recursive:true});await chmod(workRoot,0o711);
let busy=false;
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}
async function run(job,prompt,parent) {
  busy=true;job.status='running';
  const dir=path.join(root,job.id),workspace=path.join(workRoot,job.id);
  const log=s=>{job.logs=(job.logs+s).slice(-1024*1024);console.log(`[${job.id}] ${s.trimEnd()}`);};
  try {
    await mkdir(dir,{recursive:true,mode:0o700});
    await cp('/opt/app/templates/react',workspace,{recursive:true});
    await prepareWorkspace(workspace);
    await execute(workspace,'pnpm',['install','--offline','--frozen-lockfile','--ignore-scripts','--store-dir=/opt/store'],log);
    const inference=await runAgent(workspace,prompt,process.env.MODEL||'deepseek-v4-1-flash',log,{dev,mockURL:process.env.MOCK_INFERENCE_URL});
    await prepareWorkspace(workspace);
    await execute(workspace,'pnpm',['build'],log);
    // Snapshot the build into root-owned results before hashing.
    const dist=path.join(dir,'dist');await cp(path.join(workspace,'dist'),dist,{recursive:true,dereference:false});
    const description=await describeDist(dist);
    if(!description.manifest.length)throw new Error('empty build output');
    const archive=path.join(dir,'artifact.tar.gz');
    await tar.c({gzip:true,file:archive,cwd:dir,portable:true,mtime:new Date(0),noMtime:true},['dist']);
    const statement={_type:'https://in-toto.io/Statement/v1',subject:[{name:'dist.tar.gz',digest:{sha256:sha256(await readFile(archive))}}],predicateType:'https://attestai.local/job/v1',predicate:{mode:dev?'dev':'tinfoil',harness_image_digest:process.env.HARNESS_IMAGE_DIGEST||'dev/unpinned',config:{repo:process.env.CONFIG_REPO||'ekrembal/tinfoil-experiments'},model:process.env.MODEL||'deepseek-v4-1-flash',prompt,prompt_sha256:sha256(prompt),parent_statement_sha256:parent?sha256(canonical(parent.statement)):null,artifact:description,inference_verification:inference}};
    statement.predicate.agent=AGENT;
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
    const match=/^\/jobs\/([0-9a-f-]{36})(?:\/(artifact|statement))?$/.exec(req.url);
    if(req.method!=='GET'||!match||!jobs.has(match[1]))return json(res,404,{error:'not found'});
    const job=jobs.get(match[1]);
    if(!match[2])return json(res,200,job);
    if(job.status!=='completed')return json(res,409,{error:'job not completed'});
    const artifact=match[2]==='artifact';
    res.writeHead(200,{'Content-Type':artifact?'application/gzip':'application/json'});
    res.end(await readFile(path.join(root,job.id,artifact?'artifact.tar.gz':'statement.json')));
  }catch(error){json(res,500,{error:error.message});}
});
server.requestTimeout=30000;
server.listen(Number(process.env.PORT||8080),'0.0.0.0',()=>console.log('attestai harness listening on 8080'));
