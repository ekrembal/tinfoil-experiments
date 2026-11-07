import { spawn } from 'node:child_process';
const dev=process.env.DEV_MODE==='1';
if(!dev&&process.env.MOCK_INFERENCE_URL)throw new Error('mock is dev-only');
let proxy;
if(!dev) {
  proxy=spawn('/usr/local/bin/tinfoil-proxy',['-e','inference.tinfoil.sh','-r','tinfoilsh/confidential-model-router','-p','3301','--log-format','json'],{stdio:'inherit',env:{PATH:process.env.PATH,HOME:'/root'}});
  proxy.on('exit',()=>process.exit(1));
  let ready=false;
  for(let i=0;i<60;i++) {
    try {const response=await fetch('http://127.0.0.1:3301/verification-document',{signal:AbortSignal.timeout(1000)});if(response.ok){ready=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,1000));
  }
  if(!ready){proxy.kill();throw new Error('attested proxy did not become ready');}
}
await import('./server.mjs');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{proxy?.kill(signal);process.exit(0);});
