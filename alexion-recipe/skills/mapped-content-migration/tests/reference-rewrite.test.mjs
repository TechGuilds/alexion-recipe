import test from 'node:test';
import assert from 'node:assert/strict';
import {rewriteReference} from '../scripts/lib/reference-rewrite.mjs';

const a='{AAAAAAAA-1111-2222-3333-444444444444}';
const b='{BBBBBBBB-1111-2222-3333-444444444444}';
const c='{CCCCCCCC-1111-2222-3333-444444444444}';
const d='{DDDDDDDD-1111-2222-3333-444444444444}';
const zero='{00000000-0000-0000-0000-000000000000}';
const ref=(kind,...targetSourceIds)=>({kind,targetSourceIds});
const rejects=(r,value,type,targets)=>assert.throws(()=>rewriteReference(r,value,type,targets),{code:'reference-rewrite'});

test('rewrites complete single GUIDs and ordered duplicate list positions without mutating inputs',()=>{
  const r=ref('list',a,b,a),targets=[c,d,c];
  assert.equal(rewriteReference(r,`${a.toLowerCase()}|${b}|${a}`,'TreelistEx',targets),`${c}|${d}|${c}`);
  assert.deepEqual(r,ref('list',a,b,a));assert.deepEqual(targets,[c,d,c]);
  assert.equal(rewriteReference(ref('datasource',a),a,'Droplink',[c]),c);
  assert.equal(rewriteReference(ref('list',a),a,'Droptree',[c]),c);
  assert.equal(rewriteReference(ref('datasource',a),a,'Multilist',[c]),c);
});

test('rewrites only exact lowercase XML ID attributes while preserving every other byte',()=>{
  for(const [kind,type,tag,attr] of [['link','General Link','LiNk','id'],['media','Image','IMAGE','mediaid'],['media','File','file','mediaid']]){
    const raw=` \r\n<${tag} title='A &amp; B &#32; &#x20;' data-id="${a}" querystring='x=${a}&amp;y=2' ${attr} \t= '${a.toLowerCase()}' src="/${a}" />\t `;
    const expected=raw.replace(`${attr} \t= '${a.toLowerCase()}'`,`${attr} \t= '${c}'`);
    assert.equal(rewriteReference(ref(kind,a),raw,type,[c]),expected);
  }
});

test('preserves accepted empty references and external/mailto links with no target IDs',()=>{
  for(const [kind,type] of [['list','Checklist'],['datasource','Internal Link'],['media','Image'],['link','General Link']])
    assert.equal(rewriteReference(ref(kind),'',type,[]),'');
  for(const raw of ['<link />'," \n<link id='' url='mailto:a@example.com' linktype='mailto' />\r\n",`<link url="https://example.com/?id=${a}&amp;b=1" linktype="external" />`,'<image mediaid="" alt="Empty" />','<file />']){
    const kind=raw.includes('<link')?'link':'media',type=raw.includes('<file')?'File':kind==='link'?'General Link':'Image';
    assert.equal(rewriteReference(ref(kind),raw,type,[]),raw);
  }
});

test('rejects wrong cardinality, ordered source mismatch, partial tokens and unsupported types',()=>{
  for(const [r,raw,type,targets] of [
    [ref('list',a,b),`${a}|${b}`,'Droplink',[c,d]],
    [ref('datasource',a,b),`${a}|${b}`,'Multilist',[c,d]],
    [ref('list',a,b),`${b}|${a}`,'Multilist',[c,d]],
    [ref('list',a,b),`${a}|${b}`,'Multilist',[c]],
    [ref('list',a),a,'Multilist',[c,d]],
    [ref('list',a),` ${a} `,'Multilist',[c]],
    [ref('datasource',a),`prefix${a}`,'Droplink',[c]],
    [ref('datasource',a),a,'Single-Line Text',[c]],
    [ref('other',a),`<image mediaid="${a}" />`,'Image',[c]],
    [ref('media',a),`<image mediaid="${a}" />`,'General Link',[c]],
    [ref('link'),'<link />','General Link',[c]],
  ])rejects(r,raw,type,targets);
});

test('rejects malformed XML and never mistakes unrelated attributes or URLs for ID slots',()=>{
  for(const raw of [
    `<link ID="${a}" />`, `<link data-id="${a}" />`, `<link url="/?id=${a}" />`,
    `<link id="${a}" id="${a}" />`, `<link id="${a}" bad='&bad;' />`,
    `<link id="${a}" bad='&#0;' />`, `<link id="${a}" bad='<' />`,
    `<link id="${a}"></link>`, `<link id="${a}" />junk`, `<link id="${a}"/> <link/>`,
    `<link id="${a}" bad="unterminated />`, `<link id="${a}" bad='\u0000' />`,
  ])rejects(ref('link',a),raw,'General Link',[c]);
  rejects(ref('media',a),`<image MEDIAID="${a}" />`,'Image',[c]);
});

test('rejects invalid and zero source or target GUIDs even when raw syntax otherwise matches',()=>{
  for(const invalid of [zero,'invalid',a.slice(1,-1),'',null,23]){
    rejects(ref('datasource',a),a,'Droplink',[invalid]);
    rejects(ref('datasource',invalid),String(invalid),'Droplink',[c]);
    rejects(ref('link',invalid),`<link id="${invalid}" />`,'General Link',[c]);
  }
  for(const targets of [undefined,null,c])rejects(ref('datasource',a),a,'Droplink',targets);
  for(const r of [null,{}, {kind:'list',targetSourceIds:null}])rejects(r,a,'Multilist',[c]);
  rejects(ref('list'),null,'Multilist',[]);
});
