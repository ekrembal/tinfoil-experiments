import http from 'node:http';
const source=`import React from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from './components/ui/button';
import { ShieldCheck } from 'lucide-react';
import './index.css';
function App(){const [count,setCount]=React.useState(0);return <main className="max-w-xl mx-auto p-8"><ShieldCheck className="w-12 h-12 text-emerald-600"/><h1 className="text-3xl font-bold my-4">Attested offline PWA</h1><p className="mb-6">Built with shadcn, React and no internet.</p><Button onClick={()=>setCount(count+1)}>Verified clicks: {count}</Button></main>}
createRoot(document.getElementById('root')!).render(<App/>);`;
export function mockServer(){return http.createServer(async(req,res)=>{
  let body='';for await(const b of req)body+=b;
  if(req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
  const request=JSON.parse(body);
  const step=request.messages.filter(m=>m.role==='assistant'&&m.tool_calls?.length).length;
  const calls=[['write',{path:'src/main.tsx',content:source}],['bash',{command:'pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir=/opt/store',timeout:120}],['bash',{command:'pnpm build',timeout:120}]];
  const base={id:`chatcmpl-mock-${step}`,object:'chat.completion.chunk',created:1700000000,model:request.model};
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
  const send=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta,finish_reason}]})}\n\n`);
  send({role:'assistant',content:''});
  if(step<calls.length){const [name,args]=calls[step];send({tool_calls:[{index:0,id:`call_${step}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]});send({},'tool_calls');}
  else {send({content:'Created a small shadcn PWA and built it offline.'});send({},'stop');}
  res.write('data: [DONE]\n\n');res.end();
});}
