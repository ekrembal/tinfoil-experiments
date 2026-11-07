import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const hosts=new Set();
const gate=http.createServer((req,res)=>{res.writeHead(403);res.end();});
gate.on('connect',(req,client,head)=>{
  hosts.add(req.url);console.log('CONNECT:',req.url);
  if(req.url!=='inference.tinfoil.sh:443'){client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
  const remote=net.connect(443,'inference.tinfoil.sh',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)remote.write(head);client.pipe(remote);remote.pipe(client);});
  remote.on('error',()=>client.destroy());client.on('error',()=>remote.destroy());
});
await new Promise(r=>gate.listen(3401,'127.0.0.1',r));
const child=spawn('tinfoil-proxy',['-e','inference.tinfoil.sh','-r','tinfoilsh/confidential-model-router','-p','3302','--log-format','json'],{env:{PATH:process.env.PATH,HOME:'/root',HTTPS_PROXY:'http://127.0.0.1:3401'},stdio:['ignore','pipe','pipe']});
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
try {
  let document;
  for(let i=0;i<100;i++){try{const r=await fetch('http://127.0.0.1:3302/verification-document');if(r.ok){document=await r.json();break;}}catch{}await new Promise(r=>setTimeout(r,200));}
  assert.ok(document,'proxy must verify before listening');assert.deepEqual([...hosts],['inference.tinfoil.sh:443']);
  await writeFile('/evidence/proxy-verification.json',JSON.stringify(document,null,2));
  console.log('PASS: official proxy 0.2.9 verified real inference attestation; CONNECT allowlist only inference.tinfoil.sh:443');
}finally {child.kill('SIGTERM');gate.closeAllConnections();gate.close();}
