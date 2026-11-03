import {args,required,inspect,writeReport,run,cmp} from './core.mjs';
function rank(name) {
  const parts=name.replace(/\._containers$/,'').toLowerCase().split('.');
  const kind=({template:0,templates:0,rendering:1,renderings:1,branch:2,branches:2,layout:3,layouts:3})[parts[0]]??10;
  const tier=parts.length===1?-1:['foundation','feature','project','system'].findIndex(t=>parts.includes(t));
  return [kind,tier<0&&parts.length>1?99:tier,parts.length];
}
function compare(a,b) { const x=rank(a),y=rank(b); for(let i=0;i<3;i++) if(x[i]!==y[i]) return x[i]-y[i]; return cmp(a,b); }
// Tarjan SCC distinguishes actual cycles from nodes merely blocked by a cycle.
function cycles(graph) {
  let index=0; const indices=new Map(),low=new Map(),stack=[],active=new Set(),out=[];
  function visit(v) {
    indices.set(v,index); low.set(v,index++); stack.push(v); active.add(v);
    for(const w of [...graph.get(v)].sort(cmp)) {
      if(!indices.has(w)) {visit(w);low.set(v,Math.min(low.get(v),low.get(w)));}
      else if(active.has(w)) low.set(v,Math.min(low.get(v),indices.get(w)));
    }
    if(low.get(v)===indices.get(v)) { const group=[]; let w; do {w=stack.pop();active.delete(w);group.push(w);} while(w!==v); if(group.length>1||graph.get(v).has(v)) out.push(group.sort(cmp)); }
  }
  for(const v of [...graph.keys()].sort(cmp)) if(!indices.has(v)) visit(v);
  return out.sort((a,b)=>cmp(a[0],b[0]));
}
run(()=>{
  const a=args(['items-root','modules-root','output-root','batch-size','runtime-budget-seconds','items-per-second']); required(a,'items-root','modules-root','output-root');
  const size=Number(a['batch-size']??1000), budget=Number(a['runtime-budget-seconds']??300), rate=Number(a['items-per-second']??10);
  if(!Number.isSafeInteger(size)||size<1||!Number.isFinite(budget)||budget<=0||!Number.isFinite(rate)||rate<=0) throw Error('Invalid batch size/runtime/rate');
  const limit=Math.min(size,Math.floor(budget*rate)); if(limit<1) throw Error('Runtime budget cannot fit one item');
  const input=inspect(a['items-root'],a['modules-root']);
  const graph=new Map(input.modules.map(m=>[m.namespace,new Set()])), itemGraph=new Map(input.items.map(i=>[i.id,new Set()])), byId=new Map(input.items.map(i=>[i.id,i]));
  for(const item of input.items) for(const d of item.dependencies) {
    const prerequisite=byId.get(d.id); if(!prerequisite) continue;
    if(d.kind!=='field-reference') itemGraph.get(item.id).add(d.id);
    if(prerequisite.namespace!==item.namespace) graph.get(item.namespace).add(prerequisite.namespace);
  }
  for(const name of graph.keys()) if(name.endsWith('._containers')) {
    const base=name.slice(0,-12);
    for(const other of graph.keys()) if(other!==name && (other===base||other.startsWith(base+'.'))) graph.get(other).add(name);
  }
  const namespaceCycles=cycles(graph),itemCycles=cycles(itemGraph),done=new Set(),batches=[];
  const externalSoftReferences=input.softReferences.filter(reference=>!byId.has(reference.id));
  const counts=new Map(input.modules.map(m=>[m.namespace,m.count]));
  while(done.size<graph.size) {
    const ready=[...graph.keys()].filter(n=>!done.has(n)&&[...graph.get(n)].every(p=>done.has(p))).sort(compare);
    if(!ready.length) break;
    let batch=[],count=0;
    const flush=()=>{if(!batch.length)return;batches.push({phase:batches.length+1,namespaces:batch,itemCount:count,estimatedSeconds:count/rate,oversized:count>limit,prerequisites:[...new Set(batch.flatMap(n=>[...graph.get(n)]))].sort(cmp)});batch=[];count=0;};
    for(const n of ready) { if(batch.length&&count+counts.get(n)>limit)flush();batch.push(n);count+=counts.get(n);if(count>=limit)flush(); }
    flush(); for(const n of ready) done.add(n);
  }
  const report={version:1,inputManifest:input.inputManifest,ready:input.valid&&!namespaceCycles.length&&!itemCycles.length&&!input.missingReferences.length,diagnostics:input.diagnostics,warnings:input.warnings,missingReferences:input.missingReferences,softReferences:input.softReferences,externalSoftReferences,namespaceCycles,itemCycles,blockedNamespaces:[...graph.keys()].filter(n=>!done.has(n)).sort(cmp),batches,assumedItemsPerSecond:rate};
  writeReport(a['output-root'],'plan.json',report,[a['items-root'],a['modules-root']]);
  if(!report.ready) process.exitCode=2;
});
