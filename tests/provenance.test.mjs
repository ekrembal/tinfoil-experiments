import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonical,sha256,describeDist,signingKey,signature,verifyEnvelope } from '../harness/provenance.mjs';
function statement(prompt,parent=null){return {_type:'https://in-toto.io/Statement/v1',predicateType:'https://attestai.local/job/v1',predicate:{mode:'dev',prompt,prompt_sha256:sha256(prompt),model:'mock',parent_statement_sha256:parent?sha256(canonical(parent.statement)):null}};}
test('canonical JSON sorting and exact UTF-8 prompt digest',()=>{assert.equal(canonical({z:1,a:{b:2,a:1}}),'{"a":{"a":1,"b":2},"z":1}');assert.notEqual(sha256('hi'),sha256('hi\n'));});
test('signature and prompt chain verification, missing/forged parent and dev policy',async()=>{
  const key=await signingKey(true);
  const wrap=(s,parent)=>({statement:s,...signature(s,key),attestation:{type:'dev/none'},...(parent?{parent}:{})});
  const parent=wrap(statement('first')),child=wrap(statement('second',parent),parent);
  assert.deepEqual((await verifyEnvelope(child,{allowDev:true})).map(x=>x.prompt),['first','second']);
  await assert.rejects(verifyEnvelope(child),/development attestation rejected/);
  const broken=structuredClone(child);broken.parent.statement.predicate.prompt='forged';
  await assert.rejects(verifyEnvelope(broken,{allowDev:true}),/parent hash mismatch/);
  const missing=structuredClone(child);delete missing.parent;
  await assert.rejects(verifyEnvelope(missing,{allowDev:true}),/missing parent/);
  const forged=structuredClone(parent);forged.statement.predicate.prompt='changed';
  await assert.rejects(verifyEnvelope(forged,{allowDev:true}),/invalid statement signature/);
  await assert.rejects(verifyEnvelope(wrap(statement(''),null)),/development attestation rejected/);
});
test('CID and manifest normal, empty and symlink error cases',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'attestai-test-'));
  try{const empty=await describeDist(root);assert.deepEqual(empty.manifest,[]);assert.match(empty.cid,/^bafy/);
    await mkdir(path.join(root,'assets'));await writeFile(path.join(root,'assets','a.txt'),'hello');
    const first=await describeDist(root);assert.equal(first.manifest[0].sha256,sha256('hello'));
    assert.equal(first.cid,(await describeDist(root)).cid);
    await writeFile(path.join(root,'assets','a.txt'),'changed');assert.notEqual(first.cid,(await describeDist(root)).cid);
    await symlink('/etc/passwd',path.join(root,'bad'));await assert.rejects(describeDist(root),/symlinks/);
  }finally{await rm(root,{recursive:true,force:true});}
});
