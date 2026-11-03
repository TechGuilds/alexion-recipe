import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTaskPacket } from '../../cms-migration/scripts/prepare-task-packet.mjs';

const input=()=>({scopeId:'site:en',taskId:'content.banner',targetRoot:'repos/site',attemptRoot:'evidence/content.banner/attempt-1',inventory:{version:1,scopeId:'site:en',entities:[{id:'banner',kind:'component',source:{identity:'banner',path:'/source/banner'},scope:'included',parentIds:[],routeIds:['/'],joins:['source-report:banner'],uncertainty:[]}]},workflow:{version:1,phases:[{id:'content',title:'Content Migration',tasks:[{id:'content.banner',title:'Transform Banner',status:'pending',dependsOn:[],agent:'sitecore-developer'}]}]},mappings:[{entityId:'banner',taskId:'content.banner',routeIds:['/']}],inputs:[{path:'scope.json',sha256:'a'.repeat(64)}],acceptance:['Mapped output validates']});

test('the supported packet producer carries an explicit current content transfer method decision',async()=>{
  for(const mode of ['native-serialization']){
    const i=input();i.contentMigrationDecision={id:'mode-decision',kind:'scope',scopeId:i.scopeId,taskId:i.taskId,choice:mode,rationale:'Reviewed content migration mechanism',userResponse:'Approved',at:'2026-10-27T12:00:00Z',inputs:i.inputs};
    const packet=await prepareTaskPacket(i);assert.equal(packet.contentMigrationMode,mode);assert.equal(packet.contentMigrationDecision.id,'mode-decision');
  }
});

test('mapped-content mode rejects a generic CMS entity instead of guessing from its task title',async()=>{
  const i=input();i.contentMigrationDecision={id:'mode',kind:'scope',scopeId:i.scopeId,choice:'mapped-content',rationale:'Reviewed',userResponse:'Approved',at:'2026-10-27T12:00:00Z',inputs:i.inputs};
  await assert.rejects(prepareTaskPacket(i),/one supported operation/);
});

test('packet producer does not invent modes and rejects stale or unapproved decisions',async()=>{
  const i=input();assert.equal((await prepareTaskPacket(i)).contentMigrationMode,undefined);
  for(const mode of ['stale','unapproved','unknown']){
    i.contentMigrationDecision={id:'mode',kind:'scope',scopeId:i.scopeId,choice:mode==='unknown'?'automatic':'mapped-content',rationale:'Reviewed',userResponse:'Approved',at:'2026-10-27T12:00:00Z',inputs:mode==='stale'?[{path:'scope.json',sha256:'b'.repeat(64)}]:i.inputs};
    if(mode==='unapproved')delete i.contentMigrationDecision.userResponse;
    await assert.rejects(prepareTaskPacket(i),/mode|decision/i);
  }
});
