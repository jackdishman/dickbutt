import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ZeroHash} from 'ethers';
import {runCalculator,runCalculatorFromState} from '../engine.js';
import {Journal,hash,stringify} from '../journal.js';
import {historyFixture,holderA,holderB} from './helpers/history-fixture.js';

function freezeDeep(value) {
 if(value&&typeof value==='object') {
  for(const child of Object.values(value))freezeDeep(child);
  Object.freeze(value);
 }
 return value;
}
function filesAt(dir) {
 return Object.fromEntries(fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))
  .map(entry=>[entry.name,entry.isDirectory()?filesAt(path.join(dir,entry.name)):fs.readFileSync(path.join(dir,entry.name),'utf8')]));
}
// The direct path receives only its own previous output, never a journal record/state cache.
function comparingCalculator({forceGenesis=false}={}) {
 let startingState;
 return async args=>{
  if(forceGenesis&&startingState===undefined)args={...args,bootstrap:false};
  const before=structuredClone(startingState),files=filesAt(args.dir);
  freezeDeep(startingState);
  const direct=await runCalculatorFromState({...args,startingState});
  assert.deepEqual(startingState,before,'direct calculation mutated its supplied state');
  assert.deepEqual(filesAt(args.dir),files,'direct calculation accessed journal persistence');
  const persisted=await runCalculator(args);
  assert.equal(stringify(direct),stringify(persisted),'record bytes or property order changed');
  if(!direct.unchanged&&!direct.pendingPlan) {
   const tail=new Journal(args.dir).entries().at(-1);
   assert.equal(stringify(tail.record),stringify(direct));
   assert.equal(tail.hash,hash({previous:tail.previous,record:direct}));
   startingState=direct.state;
  }
  return persisted;
 };
}

test('state step preserves genesis, bootstrap and subsequent record bytes with and without pruning',async t=>{
 for(const pruneSettledPlans of [undefined,false,true]) {
  const genesis=await historyFixture(t,{pruneSettledPlans,calculate:comparingCalculator({forceGenesis:true})});
  assert.equal(genesis.records[0].bootstrap,false);assert.equal(genesis.records[0].plan.total,'50');
  const f=await historyFixture(t,{pruneSettledPlans,calculate:comparingCalculator()});
  assert.equal(f.records[0].bootstrap,true);assert.equal(f.records[0].plan,null);
  for(let i=0;i<4;i++)await f.advance();
  assert.equal(new Journal(f.dir).entries().length,5);
  assert.equal(Object.keys(f.records.at(-1).state.plans).length,pruneSettledPlans?1:4);
 }
});

test('state step preserves partial closure recredits exactly once in retained and pruning journals',async t=>{
 for(const pruneSettledPlans of [undefined,true]) {
  const f=await historyFixture(t,{pruneSettledPlans,calculate:comparingCalculator()});
  const first=await f.advance(),roundInfo=f.distributor.roundInfo,query=f.distributor.queryFilter;
  f.distributor.roundInfo=async(id,options)=>{
   const result=await roundInfo(id,options);
   if(String(id)===first.roundId&&result[4])result[2]=BigInt(first.payouts[holderA]);
   return result;
  };
  f.distributor.queryFilter=async(id,...args)=>{
   const events=await query(id,...args);
   return String(id)===first.roundId?events.filter(event=>event.args.account===holderA):events;
  };
  const partial=await f.advance();
  assert.deepEqual(partial.recredits,{[holderB]:25n});
  if(pruneSettledPlans)assert.equal(partial.state.plans[first.roundId],undefined);
  else assert.equal(partial.state.plans[first.roundId].settled,true);
  const next=await f.advance();assert.deepEqual(next.recredits,{});
 }
});

test('unchanged and pending-plan results stay identical and never append a journal entry',async t=>{
 const f=await historyFixture(t,{pruneSettledPlans:true,calculate:comparingCalculator()});
 const bootState=freezeDeep(structuredClone(f.records[0].state)),bootBefore=structuredClone(bootState);
 const files=filesAt(f.dir);
 assert.deepEqual(await runCalculatorFromState({...f,startingState:bootState}),{unchanged:true});
 assert.deepEqual(await runCalculator(f),{unchanged:true});
 assert.deepEqual(bootState,bootBefore);assert.deepEqual(filesAt(f.dir),files);
 const first=await f.advance(),firstState=freezeDeep(structuredClone(first.state)),before=structuredClone(firstState);
 // Advance time while keeping the first plan unproposed under its original round ID.
 f.provider.getBlock=async n=>({number:n==='finalized'?30:n,hash:'0x'+(n==='finalized'?30:n).toString(16).padStart(64,'0'),timestamp:(n==='finalized'?30:n)*10});
 f.distributor.nextRoundId=async()=>BigInt(first.roundId);
 f.distributor.roundInfo=async()=>[ZeroHash,0n,0n,false,false];
 const saved=filesAt(f.dir),direct=await runCalculatorFromState({...f,startingState:firstState});
 assert.equal(direct.pendingPlan,true);assert.equal(direct.roundId,first.roundId);
 assert.equal(stringify(direct),stringify(await runCalculator(f)));
 assert.deepEqual(firstState,before);assert.deepEqual(filesAt(f.dir),saved);
 direct.plan.payouts[holderA]='1';assert.deepEqual(firstState,before,'pending result aliases the starting plan');
});

test('successful state steps do not alias the caller state or touch the filesystem',async t=>{
 const f=await historyFixture(t,{pruneSettledPlans:true});
 const state=freezeDeep(structuredClone(f.records[0].state)),before=structuredClone(state);
 await f.advance();
 for(const method of ['lock','rebuild','append','cache'])t.mock.method(Journal.prototype,method,()=>{throw Error('state step must not use a journal');});
 const result=await runCalculatorFromState({...f,startingState:state});
 assert.equal(result.plan.total,'50');assert.deepEqual(state,before);
 result.state.balances[holderA]=1n;result.state.plans[result.roundId].payouts[holderA]=1n;
 assert.deepEqual(state,before);
});

test('failures after reconciliation preserve all caller balances, plans, cursors and accrual',async t=>{
 for(const fault of ['metadata','archive','late-snapshot']) {
  const f=await historyFixture(t,{pruneSettledPlans:true});
  const first=await f.advance(),state=freezeDeep(structuredClone(first.state)),before=structuredClone(state);
  await f.advance();
  if(fault==='metadata')f.token.decimals=async()=>6;
  if(fault==='archive')f.token.queryFilter=async()=>{throw Error('archive unavailable');};
  if(fault==='late-snapshot') {
   const read=f.provider.getBlock;
   f.provider.getBlock=async n=>n===30?{...await read(n),hash:ZeroHash}:read(n);
  }
  const saved=filesAt(f.dir);
  await assert.rejects(runCalculatorFromState({...f,startingState:state}),/decimals|archive unavailable|snapshot hash changed/);
  assert.deepEqual(state,before,fault);assert.deepEqual(filesAt(f.dir),saved,fault);
 }
});

test('configuration and bootstrap rejection do not mutate supplied state',async t=>{
 const f=await historyFixture(t,{pruneSettledPlans:true});
 const state=freezeDeep(structuredClone(f.records[0].state)),before=structuredClone(state);
 await f.advance();
 await assert.rejects(runCalculatorFromState({...f,startingState:state,config:{...f.config,holderThresholdRaw:'51'}}),/configuration changed/);
 await assert.rejects(runCalculatorFromState({...f,startingState:state,bootstrap:true}),/only valid for the first period/);
 assert.deepEqual(state,before);
});

test('journal wrapper still refuses orphan state caches and releases its writer lock',async t=>{
 const f=await historyFixture(t);
 fs.rmSync(path.join(f.dir,'periods'),{recursive:true});
 await assert.rejects(runCalculator(f),/legacy state without journal/);
 assert.equal(fs.existsSync(path.join(f.dir,'.writer-lock')),false);
});
