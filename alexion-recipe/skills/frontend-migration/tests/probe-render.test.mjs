import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
const script=new URL('../scripts/probe-render.mjs',import.meta.url);
const run=(...args)=>new Promise(resolve=>{ const p=spawn(process.execPath,[script.pathname,...args]); let out=''; p.stdout.on('data',b=>out+=b); p.on('close',code=>resolve({code,data:out?JSON.parse(out):null})); });
test('HTTP markers establish readiness only and handle errors redirects and bounded timeout',async t=>{
 const server=http.createServer((req,res)=>{
  if(req.url==='/hang') return;
  if(req.url==='/redirect'){res.writeHead(302,{location:'https://example.com'});return res.end();}
  res.writeHead(req.url==='/bad'?500:200,{'content-type':'text/html'});res.end('<html>ready component</html>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();server.close();});
 const url='http://127.0.0.1:'+server.address().port;
 let p=await run('--url',url,'--marker','component'); assert.equal(p.code,0); assert.equal(p.data.ready,true); assert.equal(p.data.browserParity,'not-run');
 p=await run('--url',url,'--marker','absent');assert.equal(p.code,2);assert.equal(p.data.ready,false);
 assert.equal((await run('--url',url+'/bad')).code,2);
 assert.equal((await run('--url',url+'/redirect')).code,2);
 p=await run('--url',url+'/hang','--timeout-ms','100');assert.equal(p.code,2);assert.equal(p.data.error,'timeout');
 assert.equal((await run('--url','https://example.com')).code,1);
});

test('bounds streamed bodies and supports explicit error markers without echoing response content',async t=>{
 const server=http.createServer((req,res)=>res.end(req.url==='/large'?'x'.repeat(2048):'component fatal private-secret'));
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); t.after(()=>{server.closeAllConnections();server.close();});
 const url='http://127.0.0.1:'+server.address().port;
 let p=await run('--url',url+'/large','--max-bytes','32');assert.equal(p.code,2);assert.equal(p.data.error,'body-limit');
 p=await run('--url',url,'--marker','component','--reject-marker','fatal');assert.equal(p.code,2);assert.equal(p.data.rejected[0].found,true);assert.ok(!JSON.stringify(p.data).includes('private-secret'));
 assert.equal((await run('--url',url,'--timeout-ms','60001')).code,1);
});
