import { createReadStream } from 'node:fs';
import { readdir,lstat,mkdir,copyFile,chmod } from 'node:fs/promises';
import { Readable,Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import path from 'node:path';
import * as tar from 'tar';

const excluded=new Set(['node_modules','dist','.git','.pi','.pi-agent','.cache','.npm','.tmp','.pnpm-store']);
export function archivePolicy() {
  const maxBodyBytes=Number(process.env.MAX_JOB_BODY_BYTES||2*1024*1024);
  const maxArchiveBytes=Number(process.env.MAX_ARCHIVE_BYTES||maxBodyBytes);
  if(!Number.isSafeInteger(maxBodyBytes)||maxBodyBytes<=0||!Number.isSafeInteger(maxArchiveBytes)||maxArchiveBytes<=0)throw new Error('invalid archive/body size policy');
  return {maxBodyBytes,maxArchiveBytes};
}
export function byteLimit(maxBytes) {
  let bytes=0;
  return new Transform({transform(chunk,encoding,done){bytes+=chunk.length;done(bytes>maxBytes?new Error('archive size limit exceeded'):null,chunk);}});
}
export function decodeSource(value,maxBytes) {
  if(typeof value!=='string'||!value||value.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw new Error('parent_source must be canonical base64');
  const bytes=Buffer.from(value,'base64');
  if(bytes.toString('base64')!==value)throw new Error('parent_source must be canonical base64');
  if(bytes.length>maxBytes)throw new Error('source size limit exceeded');
  return bytes;
}
export async function validateArchive(archive,{source=false,maxBytes}) {
  let invalid;
  const seen=new Set();
  const parser=tar.t({strict:true,filter:(name,entry)=>{
    const parts=name.split('/'),normal=path.posix.normalize(name).replace(/\/$/,'');
    if(!['File','Directory'].includes(entry.type)||name.startsWith('/')||name.includes('\\')||/^[A-Za-z]:/.test(name)||parts.includes('..')||name.includes('\0')||seen.has(normal)||(source?parts.some(p=>excluded.has(p)):!(normal==='dist'||normal.startsWith('dist/'))))invalid=new Error('unsafe archive entry');
    seen.add(normal);return true;
  }});
  await pipeline(Buffer.isBuffer(archive)?Readable.from([archive]):createReadStream(archive),createGunzip(),byteLimit(maxBytes),parser);
  if(invalid)throw invalid;
  if(source&&(!seen.has('package.json')||!seen.has('package-lock.json')))throw new Error('source requires package.json and package-lock.json');
}
async function sourceEntries(root,prefix='') {
  const out=[];
  for(const name of (await readdir(path.join(root,prefix))).sort()){
    if(excluded.has(name)||name.endsWith('.tsbuildinfo'))continue;
    const rel=path.posix.join(prefix,name),stat=await lstat(path.join(root,rel));
    if(!stat.isDirectory()&&!stat.isFile())throw new Error('source links and special files are forbidden');
    out.push({rel,stat});if(stat.isDirectory())out.push(...await sourceEntries(root,rel));
  }
  return out;
}
export async function copySource(from,to) {
  await mkdir(to,{recursive:true});
  for(const {rel,stat}of await sourceEntries(from)){
    const destination=path.join(to,rel);
    if(stat.isDirectory())await mkdir(destination,{recursive:true,mode:0o755});
    else {await copyFile(path.join(from,rel),destination);await chmod(destination,stat.mode&0o111?0o755:0o644);}
  }
}
export async function packSource(root,file) {
  const names=(await sourceEntries(root)).map(e=>e.rel);
  await tar.c({file,cwd:root,gzip:true,portable:true,noMtime:true,noDirRecurse:true},names);
}
