import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { importer } from 'ipfs-unixfs-importer';
import { MemoryBlockstore } from 'blockstore-core/memory';
import { Verifier, KEY_SPKI_V1_FORMAT } from '../verifier/vendor/dist/index.js';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
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
export async function attest(statement) {
  const nonce=sha256(canonical(statement));
  return new Promise((resolve,reject)=>{
    const req=http.get({socketPath:'/tinfoil/attestation.sock',path:`/.well-known/tinfoil-attestation?nonce=${nonce}`,timeout:30000},res=>{
      const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>res.statusCode===200?resolve({type:'tinfoil/v3',document:Buffer.concat(parts).toString('base64')}):reject(new Error(`attestation socket HTTP ${res.statusCode}`)));
    });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('attestation timeout')));
  });
}
export async function verifyEnvelope(envelope,{allowDev=false,repo,depth=0}={}) {
  if (depth>32) throw new Error('prompt chain too deep');
  const {statement,public_key,signature: sig,attestation,parent}=envelope;
  if (statement?._type!=='https://in-toto.io/Statement/v1' || statement.predicateType!=='https://attestai.local/job/v1') throw new Error('unsupported statement');
  const key=createPublicKey(public_key);
  if (key.asymmetricKeyType!=='ed25519' || !verify(null,Buffer.from(canonical(statement)),key,Buffer.from(sig,'base64'))) throw new Error('invalid statement signature');
  const p=statement.predicate;
  let attestationVerification=null;
  if (sha256(p.prompt)!==p.prompt_sha256) throw new Error('prompt digest mismatch');
  if (attestation.type==='dev/none') {
    if (!allowDev || p.mode!=='dev') throw new Error('development attestation rejected (use --allow-dev explicitly)');
  } else {
    if (attestation.type!=='tinfoil/v3' || p.mode!=='tinfoil') throw new Error('invalid attestation type');
    if (!repo || p.config.repo!==repo) throw new Error('expected config repository required');
    const v=await Verifier.create();
    const result=await v.verifyV3(Buffer.from(attestation.document,'base64'),Buffer.from(sha256(canonical(statement)),'hex'),repo);
    if (result.cryptoMaterialData('job-signing',KEY_SPKI_V1_FORMAT)!==key.export({format:'der',type:'spki'}).toString('hex')) throw new Error('signing key not endorsed');
    attestationVerification=result.toJSON();
  }
  let chain=[];
  if (parent) {
    if (p.parent_statement_sha256!==sha256(canonical(parent.statement))) throw new Error('parent hash mismatch');
    chain=await verifyEnvelope(parent,{allowDev,repo,depth:depth+1});
  } else if (p.parent_statement_sha256!==null) throw new Error('missing parent statement');
  return [...chain,{prompt:p.prompt,model:p.model,statement_sha256:sha256(canonical(statement)),attestation_verification:attestationVerification}];
}
