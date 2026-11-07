import { readFile,readdir,lstat } from 'node:fs/promises';
import path from 'node:path';
import { importer } from 'ipfs-unixfs-importer';
import { MemoryBlockstore } from 'blockstore-core/memory';

const entries=[{path:'dist'}];
async function visit(prefix=''){
  for(const name of (await readdir(path.join('dist',prefix))).sort()){
    const rel=path.posix.join(prefix,name),file=path.join('dist',rel),stat=await lstat(file);
    if(stat.isDirectory()){entries.push({path:`dist/${rel}`});await visit(rel);}
    else if(stat.isFile())entries.push({path:`dist/${rel}`,content:await readFile(file)});
    else throw new Error('dist links and special files are forbidden');
  }
}
await visit();
let cid;
for await(const entry of importer(entries,new MemoryBlockstore(),{cidVersion:1,rawLeaves:true,wrapWithDirectory:false}))cid=entry.cid;
console.log(cid.toString());
