#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
function parse(args){
 const o={marker:[],'reject-marker':[],'timeout-ms':5000,'max-bytes':1048576,status:200};
 for(let i=0;i<args.length;i++){
  const key=args[i].slice(2);
  if(!args[i].startsWith('--')||!['url','marker','reject-marker','timeout-ms','max-bytes','status'].includes(key)||args[i+1]===undefined)throw Error('Unknown or missing option');
  const value=args[++i];
  if(Array.isArray(o[key]))o[key].push(value);else o[key]=value;
 }
 const url=new URL(o.url);
 if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password)throw Error('Only credential-free local HTTP(S) URLs are supported');
 for(const [key,min,max] of [['timeout-ms',1,60000],['max-bytes',1,10485760],['status',100,599]]){
  o[key]=Number(o[key]);if(!Number.isInteger(o[key])||o[key]<min||o[key]>max)throw Error('Invalid '+key);
 }
 if(o.marker.concat(o['reject-marker']).some(s=>!s||s.length>4096))throw Error('Invalid marker');
 return {o,url};
}
async function probe(o,url){
 return new Promise(resolve=>{
  let settled=false,size=0,chunks=[],timer,req;
  const base={url:url.origin+url.pathname,ready:false,browserParity:'not-run',status:null,markers:[],bodyBytes:0};
  const done=extra=>{if(settled)return;settled=true;clearTimeout(timer);resolve({...base,...extra});};
  req=(url.protocol==='https:'?https:http).get(url,{headers:{accept:'text/html'},agent:false},res=>{
   base.status=res.statusCode;base.contentType=res.headers['content-type']||null;
   base.redirect=Boolean(res.headers.location);
   res.on('data',chunk=>{
    size+=chunk.length;base.bodyBytes=size;
    if(size>o['max-bytes']){done({error:'body-limit'});req.destroy();res.destroy();return;}
    chunks.push(chunk);
   });
   res.on('end',()=>{
    const body=Buffer.concat(chunks).toString('utf8');
    const markers=o.marker.map(value=>({marker:value,found:body.includes(value)}));
    const rejected=o['reject-marker'].map(value=>({marker:value,found:body.includes(value)}));
    const ready=res.statusCode===o.status&&!base.redirect&&markers.every(m=>m.found)&&rejected.every(m=>!m.found);
    done({ready,markers,rejected});
   });
   res.on('error',()=>done({error:'response-error'}));
   res.on('aborted',()=>done({error:'response-aborted'}));
  });
  timer=setTimeout(()=>{done({error:'timeout'});req.destroy();},o['timeout-ms']);
  req.on('error',()=>done({error:'connection-error'}));
 });
}
try{
 const {o,url}=parse(process.argv.slice(2));const result=await probe(o,url);
 console.log(JSON.stringify(result,null,2));process.exitCode=result.ready?0:2;
}catch(e){console.log(JSON.stringify({error:e.message,ready:false,browserParity:'not-run'}));process.exitCode=1;}
