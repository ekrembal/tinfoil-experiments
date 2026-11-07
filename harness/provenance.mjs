import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { importer } from 'ipfs-unixfs-importer';
import { MemoryBlockstore } from 'blockstore-core/memory';
import { Verifier, KEY_SPKI_V1_FORMAT } from '../verifier/vendor/dist/index.js';
import { buildProfile,releaseProfile } from './profile.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export async function sha256File(file) {
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
export async function files(root, prefix='') {
  const out=[];
  for (const name of (await readdir(path.join(root,prefix))).sort()) {
    const rel=path.posix.join(prefix,name), stat=await lstat(path.join(root,rel));
    if (stat.isSymbolicLink()) throw new Error('symlinks are forbidden');
    if (stat.isDirectory()) out.push(...await files(root,rel));
    else if (stat.isFile()) out.push(rel);
    else throw new Error('special files are forbidden');
  }
  return out;
}
export async function describeDist(root) {
  const manifest=[];
  const entries=[{path:'dist'}];
  async function directories(prefix='') {
    for(const entry of await readdir(path.join(root,prefix),{withFileTypes:true})) {
      if(entry.isDirectory()){const rel=path.posix.join(prefix,entry.name);entries.push({path:`dist/${rel}`});await directories(rel);}
    }
  }
  await directories();
  for (const rel of await files(root)) {
    const content=await readFile(path.join(root,rel));
    manifest.push({path:rel,size:content.length,sha256:sha256(content)});
    entries.push({path:`dist/${rel}`,content});
  }
  let last;
  for await (const entry of importer(entries,new MemoryBlockstore(),{cidVersion:1,rawLeaves:true,wrapWithDirectory:false})) last=entry;
  return {manifest,cid:last.cid.toString()};
}
export async function signingKey(dev) {
  if (dev) return generateKeyPairSync('ed25519').privateKey;
  return (await import('node:crypto')).createPrivateKey(await readFile('/run/tinfoil/keys/job-signing/private_key.pem'));
}
export function signature(statement,key) {
  return {public_key:createPublicKey(key).export({type:'spki',format:'pem'}),signature:sign(null,Buffer.from(canonical(statement)),key).toString('base64')};
}
export async function attestationMode(dev) {
  if(dev)return 'dev';
  try {
    if(!(await lstat('/tinfoil/attestation.sock')).isSocket())throw new Error('attestation path is not a socket');
    return 'workload';
  }catch(error){if(error.code==='ENOENT')return 'attested-key';throw error;}
}
export async function attest(statement) {
  const nonce=sha256(canonical(statement));
  return new Promise((resolve,reject)=>{
    const req=http.get({socketPath:'/tinfoil/attestation.sock',path:`/.well-known/tinfoil-attestation?nonce=${nonce}`,timeout:30000},res=>{
      const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>res.statusCode===200?resolve({type:'tinfoil/v3',document:Buffer.concat(parts).toString('base64')}):reject(new Error(`attestation socket HTTP ${res.statusCode}`)));
    });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('attestation timeout')));
  });
}
export async function verifyEnvelope(envelope,{allowDev=false,repo,keyAttestation,expectedProfile,expectedTag,depth=0}={}) {
  if (depth>32) throw new Error('prompt chain too deep');
  const {statement,public_key,signature: sig,attestation,parent}=envelope;
  if (statement?._type!=='https://in-toto.io/Statement/v1' || statement.predicateType!=='https://attestai.local/job/v1') throw new Error('unsupported statement');
  const key=createPublicKey(public_key);
  if (key.asymmetricKeyType!=='ed25519' || !verify(null,Buffer.from(canonical(statement)),key,Buffer.from(sig,'base64'))) throw new Error('invalid statement signature');
  const p=statement.predicate;
  if(expectedProfile!==undefined)buildProfile(expectedProfile);
  if(expectedTag!==undefined&&expectedProfile!==undefined&&releaseProfile(expectedTag)!==expectedProfile)throw new Error('expected profile and tag disagree');
  if(p.profile!==undefined&&canonical(p.worker_egress)!==canonical(buildProfile(p.profile).worker_egress))throw new Error('signed worker egress policy mismatch');
  if(expectedProfile!==undefined&&p.profile!==expectedProfile)throw new Error('unexpected build profile');
  let attestationVerification=null;
  if (sha256(p.prompt)!==p.prompt_sha256) throw new Error('prompt digest mismatch');
  if (attestation.type==='dev/none') {
    if (!allowDev || p.mode!=='dev') throw new Error('development attestation rejected (use --allow-dev explicitly)');
    if(expectedTag!==undefined)throw new Error('development statement has no verified release tag');
  } else {
    if (!['tinfoil/v3','tinfoil/attested-key'].includes(attestation.type) || p.mode!=='tinfoil') throw new Error('invalid attestation type');
    if (!repo || p.config.repo!==repo) throw new Error('expected config repository required');
    let document=attestation.document,nonce=sha256(canonical(statement));
    if(attestation.type==='tinfoil/attested-key'){
      if(p.attestation_mode!=='attested-key')throw new Error('invalid attestation mode');
      const evidence=attestation.key_attestation||keyAttestation;
      if(!evidence||typeof evidence.document!=='string'||!evidence.document||!/^[0-9a-f]{64}$/.test(evidence.nonce))throw new Error('attested-key mode requires external key attestation document and nonce');
      ({document,nonce}=evidence);
    }else if(p.attestation_mode!==undefined&&p.attestation_mode!=='workload')throw new Error('invalid attestation mode');
    const v=await Verifier.create();
    const result=await v.verifyV3(Buffer.from(document,'base64'),Buffer.from(nonce,'hex'),repo);
    if (result.cryptoMaterialData('job-signing',KEY_SPKI_V1_FORMAT)!==key.export({format:'der',type:'spki'}).toString('hex')) throw new Error('signing key not endorsed');
    attestationVerification=result.toJSON();
    if(expectedTag!==undefined&&attestationVerification.codeTag!==expectedTag)throw new Error('unexpected verified release tag');
    if(p.profile!==undefined||expectedTag!==undefined||releaseProfile(attestationVerification.codeTag)==='online'){
      if(p.profile!==releaseProfile(attestationVerification.codeTag))throw new Error('signed profile disagrees with verified release tag');
    }
  }
  let chain=[];
  if (parent) {
    if (p.parent_statement_sha256!==sha256(canonical(parent.statement))) throw new Error('parent hash mismatch');
    chain=await verifyEnvelope(parent,{allowDev,repo,keyAttestation,depth:depth+1});
  } else if (p.parent_statement_sha256!==null) throw new Error('missing parent statement');
  return [...chain,{prompt:p.prompt,model:p.model,profile:p.profile,worker_egress:p.worker_egress,statement_sha256:sha256(canonical(statement)),attestation_mode:p.attestation_mode||(p.mode==='dev'?'dev':'workload'),attestation_verification:attestationVerification}];
}
