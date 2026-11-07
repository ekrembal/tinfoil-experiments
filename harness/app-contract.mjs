import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'parse5';
import { icons } from 'lucide-react';

const categories=new Set(['Productivity','Finance','Social','AI','Health','Utilities','Games','Education']);
function relative(value,label) {
  if(typeof value!=='string'||value.trimStart().replaceAll('\\','/').startsWith('/'))throw new Error(`${label} must not use an absolute / path`);
}
export function appMetadata(raw) {
  let app;try{app=JSON.parse(raw);}catch{throw new Error('app.json is not valid JSON');}
  for(const [key,max]of [['name',30],['tagline',80],['description',400]]){
    if(typeof app?.[key]!=='string'||!app[key].trim()||app[key].length>max)throw new Error(`invalid app.json ${key}`);
  }
  if(!categories.has(app.category))throw new Error('invalid app.json category');
  if(typeof app.icon!=='string'||!/^[A-Z][A-Za-z0-9]{1,40}$/.test(app.icon)||!Object.hasOwn(icons,app.icon))throw new Error('invalid app.json lucide icon');
  return app;
}
export async function validateApp(dist) {
  appMetadata(await readFile(path.join(dist,'app.json'),'utf8'));
  const html=parse(await readFile(path.join(dist,'index.html'),'utf8')),manifests=[];
  function visit(node){
    const attrs=Object.fromEntries((node.attrs||[]).map(a=>[a.name,a.value]));
    for(const name of ['src','href'])if(attrs[name]!==undefined)relative(attrs[name],`index.html ${name}`);
    if(node.tagName==='link'&&attrs.rel?.toLowerCase().split(/\s+/).includes('manifest')){
      if(!attrs.href)throw new Error('web manifest href required');manifests.push(attrs.href);
    }
    for(const child of node.childNodes||[])visit(child);if(node.content)visit(node.content);
  }
  visit(html);
  if(!manifests.length)throw new Error('web manifest required');
  for(const href of manifests){
    const url=new URL(href,'https://app.invalid/');
    if(url.origin!=='https://app.invalid')throw new Error('web manifest must be included in dist');
    const rel=decodeURIComponent(url.pathname).slice(1),file=path.resolve(dist,rel);
    if(file===path.resolve(dist)||!file.startsWith(path.resolve(dist)+path.sep))throw new Error('unsafe web manifest path');
    const manifest=JSON.parse(await readFile(file,'utf8'));
    for(const name of ['start_url','scope'])if(manifest[name]!==undefined)relative(manifest[name],`web manifest ${name}`);
    if(manifest.icons!==undefined){
      if(!Array.isArray(manifest.icons))throw new Error('invalid web manifest icons');
      for(const icon of manifest.icons)relative(icon?.src,'web manifest icon src');
    }
  }
}
