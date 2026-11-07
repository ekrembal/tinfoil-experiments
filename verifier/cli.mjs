#!/usr/bin/env node
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { canonical, sha256, sha256File, describeDist, verifyEnvelope } from '../harness/provenance.mjs';

export async function verifyArtifact(envelope,artifact,options={}) {
  const chain=await verifyEnvelope(envelope,options);
  if(options.log && await sha256File(options.log)!==envelope.statement.predicate.transcript?.sha256)throw new Error('transcript sha256 mismatch');
  if(options.source && await sha256File(options.source)!==envelope.statement.predicate.source?.sha256)throw new Error('source sha256 mismatch');
  if (sha256(await readFile(artifact))!==envelope.statement.subject[0].digest.sha256) throw new Error('artifact sha256 mismatch');
  const dir=await mkdtemp(path.join(tmpdir(),'attestai-verify-'));
  try {
    await tar.x({file:artifact,cwd:dir,strict:true,filter:(name,entry)=>{
      if (!['File','Directory'].includes(entry.type) || name.startsWith('/') || name.split('/').includes('..') || !(name==='dist'||name.startsWith('dist/'))) throw new Error('unsafe archive entry');
      return true;
    }});
    const actual=await describeDist(path.join(dir,'dist'));
    if (canonical(actual)!==canonical(envelope.statement.predicate.artifact)) throw new Error('artifact manifest/CID mismatch');
  } finally { await rm(dir,{recursive:true,force:true}); }
  return chain;
}
if (process.argv[1]===new URL(import.meta.url).pathname) {
  try {
    const [statement,artifact,...args]=process.argv.slice(2);
    if (!statement || !artifact) throw new Error('Usage: node verifier/cli.mjs statement.json artifact.tar.gz [--allow-dev] [--repo owner/repo] [--log pi.jsonl] [--source source.tar.gz] [--key-attestation evidence.json] [--profile offline|online] [--tag release-tag]');
    const keyAttestation=args.includes('--key-attestation')?JSON.parse(await readFile(args[args.indexOf('--key-attestation')+1],'utf8')):undefined;
    const policy=name=>{if(!args.includes(name))return undefined;const value=args[args.indexOf(name)+1];if(!value||value.startsWith('--'))throw new Error(`${name} requires a value`);return value;};
    const chain=await verifyArtifact(JSON.parse(await readFile(statement,'utf8')),artifact,{allowDev:args.includes('--allow-dev'),repo:args.includes('--repo')?args[args.indexOf('--repo')+1]:undefined,log:args.includes('--log')?args[args.indexOf('--log')+1]:undefined,source:policy('--source'),expectedProfile:policy('--profile'),expectedTag:policy('--tag'),keyAttestation});
    console.log('VERIFIED: signature, attestation policy, tarball SHA-256, per-file manifest, CIDv1');
    const profile=chain.at(-1).profile;
    if(profile)console.log(profile==='online'?'VERIFIED: built with unrestricted internet access (profile online)':'VERIFIED: built offline (profile offline)');
    if(chain.some(entry=>entry.attestation_mode==='attested-key'))console.log('VERIFIED: attested signing key only; no signer-provided fresh workload attestation');
    if(args.includes('--log'))console.log('VERIFIED: full Pi transcript SHA-256');
    if(args.includes('--source'))console.log('VERIFIED: workspace source SHA-256');
    console.log('Prompt chain:',JSON.stringify(chain,null,2));
  } catch(error) {console.error('VERIFICATION FAILED:',error.message);process.exitCode=1;}
}
