import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZeroAddress, ZeroHash } from 'ethers';
import { runCalculator } from '../../calculator/engine.js';
import { Journal } from '../../calculator/journal.js';
import { computeTWAB, computeShares, sum } from '../../calculator/core.js';
import { runKeeper } from '../../keeper/engine.js';
import { runFeeCycle } from '../../operations/fees.js';
import { runFloorRefresh } from '../../operations/floor.js';
import { runMonitor } from '../../operations/monitor.js';
import { JOBS } from '../../operations/schedule.js';

const A='0x00000000000000000000000000000000000000aa';
const B='0x00000000000000000000000000000000000000bb';
const D='0x00000000000000000000000000000000000000dd';
const H='0x'+'ab'.repeat(32);

function calculatorFixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dickbutt-audit-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const state={block:10,now:100,available:100n,next:1n};
  const provider={getNetwork:async()=>({chainId:31337n}),getTransactionCount:async()=>0,getBlock:async n=>({number:typeof n==='number'?n:state.block,hash:H,timestamp:n==='latest'?state.now:(typeof n==='number'?n:state.block)*10})};
  const token={decimals:async()=>18n,filters:{Transfer:()=>1},queryFilter:async(_f,from)=>from===1?[{blockNumber:1,index:0,args:{from:ZeroAddress,to:A,value:100n}}]:[]};
  const distributor={getAddress:async()=>D,nextRoundId:async()=>state.next,availableForNextRound:async()=>state.available,maxProposableTotal:async()=>state.available/2n,minPayout:async()=>0n,rewardToken:async()=>B,roundInfo:async()=>[ZeroHash,0n,0n,false,false],pending:async()=>[ZeroHash,0n,0n]};
  const config={deployBlock:1,chainId:'31337',token:A,distributor:D,holderThresholdRaw:'1',payoutThresholdRaw:'60',curve:'linear',excluded:[ZeroAddress],batchSize:10,chunkSize:100,finalityTag:'finalized'};
  return {dir,state,provider,token,distributor,config,rewardTokenFactory:()=>({decimals:async()=>8n})};
}

test('M-01 fixed: funded carry produces a capped instalment without losing the remainder',async t=>{
  const f=calculatorFixture(t);const first=await runCalculator(f);
  assert.equal(first.plan,null);assert.equal(first.endingAccrual[A],50n);
  f.state.block+=2160;
  const next=await runCalculator(f);
  assert.equal(next.plan.total,'50');assert.equal(next.payouts[A],50n);assert.equal(next.endingAccrual[A],50n);
  assert.equal(new Journal(f.dir).entries().length,2);
  assert.equal(next.state.lastProcessedBlock,f.state.block);
});

test('M-02 fixed: minute proposer retry commits the existing plan without another six-hour wait',async t=>{
  const f=calculatorFixture(t);f.config.payoutThresholdRaw='1';f.state.next=2n;
  const record=await runCalculator(f);let pending=[ZeroHash,0n,0n];const calls=[];
  Object.assign(f.distributor,{pending:async()=>pending,isProposer:async()=>true,isKeeper:async()=>true,owner:async()=>B,proposalsPaused:async()=>false,nextProposalAllowedAt:async()=>21610n,
    proposeRound:async(root,total)=>{calls.push('propose');return {hash:H,wait:async()=>{pending=[root,BigInt(total),BigInt(f.state.now)];f.state.next=3n;return {status:1,logs:[]};}};}});
  const keeper={...f,signerAddress:A,verifyHistory:async()=>({auditFixture:true}),execute:true};
  f.state.now=21600;
  const early=await runKeeper({...keeper,propose:true,proposeOnly:true});
  assert.equal(early.rounds[0].status,'proposal-rate-limited');assert.deepEqual(calls,[]);
  assert.equal(JOBS.find(j=>j.name==='calculate-and-propose').everySeconds,21600);
  const retry=JOBS.find(j=>j.name==='propose-pending');
  assert.equal(retry.everySeconds,60);assert.equal(retry.key,'PROPOSER_PRIVATE_KEY');
  assert.ok(retry.command.includes('--propose-only'));assert.ok(!retry.command.join(' ').includes('calculate-rewards'));
  f.state.now=21660;
  const next=await runKeeper({...keeper,propose:true,proposeOnly:true});
  assert.equal(next.rounds[0].status,'activation-ready');assert.deepEqual(calls,['propose']);
  assert.equal(record.plan.roundId,'2');assert.equal(new Journal(f.dir).entries().length,1);
});

function raceFixture(mode='estimate') {
  let last=0n;const later=[],events=[];
  const receipt={status:0,hash:H,blockNumber:100};
  const provider={getNetwork:async()=>({chainId:31337n}),getBlock:async()=>({number:100,timestamp:100000}),getTransactionReceipt:async()=>receipt};
  const locker={ownsLocker:async()=>true,lastHarvestAt:async()=>last,minInterval:async()=>21600n,
    harvest:async()=>{last=100000n;if(mode==='estimate')throw Object.assign(Error('too soon'),{code:'CALL_EXCEPTION',action:'estimateGas'});
      return {hash:H,wait:async()=>{throw Object.assign(Error('reverted'),{receipt});}};}};
  const step=name=>async()=>{later.push(name);return {hash:H,wait:async()=>({status:1,blockNumber:101})};};
  return {later,events,args:{provider,execute:true,signerAddress:A,locker,
    legacy:{isTokenCreator:async()=>true,safeCount:async()=>2,harvestFrom:step('legacy')},
    feeRouter:{splitDickbutt:step('split-dickbutt'),splitWeth:step('split-weth')},executor:{getAddress:async()=>D},weth:{balanceOf:async()=>0n},quote:async()=>1n,onEvent:e=>events.push(e)}};
}

test('M-03 fixed: a proven unsent cooldown race preserves later claims and routing',async()=>{
  const f=raceFixture();const result=await runFeeCycle(f.args);
  assert.deepEqual(f.later,['legacy','legacy','split-dickbutt','split-weth']);
  assert.equal(result.actions[0].status,'cooldown-race');assert.equal(result.swapStatus,'empty');
});

test('M-03 fixed: a confirmed reverted race is reconciled; missing or ambiguous receipts remain fatal',async()=>{
  const f=raceFixture('mined');const result=await runFeeCycle(f.args);
  assert.deepEqual(f.later,['legacy','legacy','split-dickbutt','split-weth']);
  assert.equal(result.actions[0].status,'reverted');assert.equal(result.attention.length,1);
  assert.deepEqual(f.events.slice(0,2).map(e=>e.status),['submitted','reverted']);
  for(const receipt of [null,{status:1,hash:H,blockNumber:100},{status:0,hash:ZeroHash,blockNumber:100}]) {
    const g=raceFixture('mined');g.args.provider.getTransactionReceipt=async()=>receipt;
    await assert.rejects(runFeeCycle(g.args),/reverted/);assert.deepEqual(g.later,[]);
  }
  const unchanged=raceFixture();unchanged.args.locker.lastHarvestAt=async()=>0n;
  await assert.rejects(runFeeCycle(unchanged.args),/too soon/);assert.deepEqual(unchanged.later,[]);
});

test('L-01 fixed: unknown age and stale active payments cannot remain green',async()=>{
  let now=30n*86400n,distributed=0n;
  const provider={getNetwork:async()=>({chainId:31337n}),getBlock:async()=>({number:100,hash:H,timestamp:Number(now)})};
  const distributor={proposalsPaused:async()=>false,nextRoundId:async()=>2n,totalReserved:async()=>100n-distributed,
    roundInfo:async()=>[H,100n,distributed,true,false],pending:async()=>[ZeroHash,0n,0n]};
  const executor={minSpcxcPerWeth:async()=>100n,priceFloorExpiresAt:async()=>now+72000n,floorLowerBound:async()=>1n};
  const args={provider,distributor,executor,journalRoots:[H]};
  const first=await runMonitor(args);assert.equal(first.severity,'attention');
  assert.match(first.attention.find(c=>c.name==='round-progress').detail,/age unknown/);
  now+=21599n;const recent=await runMonitor({...args,previousProgress:first.progress});assert.equal(recent.severity,'ok');
  now++;const stale=await runMonitor({...args,previousProgress:recent.progress});assert.equal(stale.severity,'attention');
  assert.match(stale.attention.find(c=>c.name==='round-progress').detail,/no payment progress/);
  distributed=1n;now++;const paid=await runMonitor({...args,previousProgress:stale.progress});assert.equal(paid.severity,'ok');
  distributed=0n;await assert.rejects(runMonitor({...args,previousProgress:paid.progress}),/regressed/);
  await assert.rejects(runMonitor({...args,previousProgress:{...paid.progress,chainId:'8453'}}),/invalid monitor/);
});

test('Risk evidence: ordinary floor bot accepts a depressed spot quote above static bound',async()=>{
  let set;
  const provider={getNetwork:async()=>({chainId:31337n}),getBlock:async()=>({timestamp:1000})};
  const executor={minSpcxcPerWeth:async()=>10000n,priceFloorExpiresAt:async()=>1001n,maxSwapPerCall:async()=>10n**18n,MAX_FLOOR_LIFETIME:async()=>86400n,owner:async()=>B,floorLowerBound:async()=>5000n,isKeeper:async()=>false,isFloorSetter:async()=>true,
    setPriceFloor:async(floor,expiry)=>{set={floor,expiry};return {hash:H,wait:async()=>({status:1})};}};
  const result=await runFloorRefresh({provider,executor,signerAddress:A,execute:true,quote:async()=>7000n});
  assert.equal(result.status,'refreshed');assert.equal(set.floor,6650n);
  // Demonstrates a trust boundary, not capital cost or a profitable live-market attack.
  assert.equal(result.deviationBps,3350);
});

test('A same-timestamp borrow/repay cannot create positive TWAB',()=>{
  const transfer=(index,from,to,value)=>({blockNumber:1,index,args:{from,to,value}});
  const result=computeTWAB({[A]:10n**30n},[transfer(0,A,B,10n**30n),transfer(1,B,A,10n**30n)],new Map([[1,50]]),0,100);
  assert.equal(result.twab[B],0n);assert.equal(result.twab[A],10n**30n);
});

test('Inclusive 6.9M boundary and linear splitting conserve weight; sqrt is Sybil-sensitive',()=>{
  const unit=10n**18n,threshold=6900000n*unit;
  const below='0x00000000000000000000000000000000000000cc';
  const shares=computeShares({[A]:threshold,[B]:threshold*2n,[below]:threshold-1n},threshold,300n,'linear');
  assert.equal(shares.qualifying,2);assert.equal(shares.shares[A],100n);assert.equal(shares.shares[B],200n);assert.equal(shares.shares[below],undefined);assert.equal(sum(shares.shares),300n);
  const unsplit=computeShares({[A]:threshold*4n,[B]:threshold*4n},threshold,10000n,'sqrt');
  const split=computeShares({[A]:threshold,[below]:threshold*3n,[B]:threshold*4n},threshold,10000n,'sqrt');
  assert.ok(split.shares[A]+split.shares[below]>unsplit.shares[A]);
});
