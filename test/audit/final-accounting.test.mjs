import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ZeroAddress,ZeroHash} from 'ethers';
import {runCalculator} from '../../calculator/engine.js';
import {Journal,hash} from '../../calculator/journal.js';
import {sum,computeTWAB,computeShares} from '../../calculator/core.js';
import {reconcile,scanEvents} from '../../calculator/chain.js';
import {verifyPayoutHistory} from '../../keeper/verify-history.js';
import {runKeeper,acquireExecutionLock} from '../../keeper/engine.js';

const address=n=>'0x'+BigInt(n).toString(16).padStart(40,'0');
const block=n=>({number:n,hash:'0x'+BigInt(n).toString(16).padStart(64,'0'),timestamp:n*10});
const emptyRound=()=>[ZeroHash,0n,0n,false,false];

function simulation(t,seed=1776n){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'final-accounting-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const random=n=>{seed=(1664525n*seed+1013904223n)%4294967296n;return Number(seed%BigInt(n));};
 const holders=Array.from({length:16},(_,i)=>address(0x7100+i));
 const balances=Object.fromEntries(holders.map((a,i)=>[a,BigInt(100+i*50)]));
 const tokenEvents=holders.map((to,index)=>({blockNumber:1,index,args:{from:ZeroAddress,to,value:balances[to]}}));
 const paidEvents=[],snapshots=new Map();
 let boundary=10,next=1n,balance=0n,totalFunded=0n;
 const rounds={},delivered={},earned={},localPlans={};
 const reserve=()=>Object.values(rounds).reduce((n,r)=>n+(r.closed?0n:r.total-r.distributed),0n);
 const snapshot=()=>snapshots.set(boundary,structuredClone({next,balance,rounds,reserved:reserve()}));
 const stateAt=options=>{const n=options.blockTag;if(!snapshots.has(n))throw Error('missing exact archive snapshot');return snapshots.get(n);};
 const provider={getBlock:async n=>block(n==='finalized'?boundary:n)};
 const token={decimals:async()=>18,filters:{Transfer:()=>1},queryFilter:async(_f,lo,hi)=>tokenEvents.filter(e=>e.blockNumber>=lo&&e.blockNumber<=hi)};
 const distributor={
  nextRoundId:async o=>stateAt(o).next,
  availableForNextRound:async o=>{const s=stateAt(o);return s.balance-s.reserved;},
  maxProposableTotal:async o=>{const s=stateAt(o);return (s.balance-s.reserved)/2n;},
  minPayout:async()=>3n,rewardToken:async()=>address(0x7201),
  roundInfo:async(id,o)=>{const r=stateAt(o).rounds[id];return !r||r.pending?emptyRound():[r.root,r.total,r.distributed,r.active,r.closed];},
  pending:async(id,o)=>{const r=stateAt(o).rounds[id];return r?.pending?[r.root,r.total,0n]:[ZeroHash,0n,0n];},
  filters:{Paid:id=>String(id)},queryFilter:async(id,lo,hi)=>paidEvents.filter(e=>e.args.roundId===id&&e.blockNumber>=lo&&e.blockNumber<=hi),
 };
 const config={chainId:'31337',token:address(0x7200),distributor:address(0x7202),deployBlock:1,holderThresholdRaw:'100',payoutThresholdRaw:'15',curve:'linear',excluded:[ZeroAddress],batchSize:5,chunkSize:5000,finalityTag:'finalized'};
 const args={dir,provider,token,distributor,config,rewardTokenFactory:()=>({decimals:async()=>8})};
 snapshot();
 return {args,holders,balances,rounds,earned,delivered,localPlans,random,snapshots,tokenEvents,
  async bootstrap(){return runCalculator({...args,bootstrap:true});},
  async period(index){
   boundary+=2160; // Exactly six hours of mock chain timestamps per attempted calculation.
   const funding=BigInt(random(1001));balance+=funding;totalFunded+=funding;
   // Deliberately leave some computed plans unsubmitted for one or more periods.
   for(const plan of Object.values(localPlans))if(!rounds[plan.roundId]&&random(5)!==0){
    assert.equal(BigInt(plan.roundId),next);assert.ok(BigInt(plan.total)<=balance-reserve());
    rounds[plan.roundId]={root:plan.root,total:BigInt(plan.total),distributed:0n,pending:true,active:false,closed:false,paid:[]};next++;
   }
   for(const[id,r]of Object.entries(rounds)){
    if(r.closed)continue;
    if(r.pending&&random(3)!==0){r.pending=false;r.active=true;}
    if(r.active){for(const[a,v]of Object.entries(localPlans[id].payouts))if(!r.paid.includes(a)&&random(4)!==0){
     const amount=BigInt(v);r.paid.push(a);r.distributed+=amount;balance-=amount;
     delivered[a]=(delivered[a]??0n)+amount;
     paidEvents.push({blockNumber:boundary-1,index:paidEvents.length,args:{roundId:id,account:a,amount}});
    }}
    // Both early closure and pending cancellation are exercised, preserving unpaid claims.
    if(r.distributed===r.total||random(8)===0){r.closed=true;r.active=false;r.pending=false;}
   }
   for(let i=0;i<4;i++){
    const from=holders[random(holders.length)],to=holders[random(holders.length)];
    const value=BigInt(random(Number(balances[from])+1));balances[from]-=value;balances[to]+=value;
    tokenEvents.push({blockNumber:boundary-1500+i*300,index:0,args:{from,to,value}});
   }
   snapshot();const result=await runCalculator(args);
   if(result.pendingPlan)return {pending:true};
   if(result.plan)localPlans[result.roundId]=structuredClone(result.plan);
   for(const[a,v]of Object.entries(result.newShares))earned[a]=(earned[a]??0n)+v;
   assert.deepEqual(result.state.balances,balances,`holder balances, period ${index}`);
   // This reference uses real simulated paid logs; it never trusts the calculator's recredits.
   for(const a of holders){
    let unpaidPlans=0n;
    for(const[id,plan]of Object.entries(result.state.plans))if(!plan.settled&&!rounds[id]?.paid.includes(a))unpaidPlans+=BigInt(plan.payouts[a]??0);
    assert.equal((earned[a]??0n)-(delivered[a]??0n),BigInt(result.state.accrued[a]??0)+unpaidPlans,`per-holder liability, period ${index}, ${a}`);
   }
   assert.equal(balance+sum(delivered),totalFunded,'global token conservation');
   const obligations=sum(result.state.accrued)+Object.entries(result.state.plans).reduce((n,[id,p])=>n+(p.settled?0n:Object.entries(p.payouts).reduce((m,[a,v])=>m+(rounds[id]?.paid.includes(a)?0n:BigInt(v)),0n)),0n);
   assert.ok(obligations<=balance,'allocated liabilities never exceed funded assets');
   return result;
  },
 };
}

test('Final accounting: 120 funding/transfer/payment/cancellation periods conserve per-holder liabilities and independently replay',async t=>{
 const f=simulation(t);await f.bootstrap();let calculated=0,pending=0;
 for(let i=0;i<120;i++){const result=await f.period(i);if(result.pending)pending++;else calculated++;}
 assert.ok(calculated>70);assert.ok(pending>0);
 const rows=new Journal(f.args.dir).entries();
 assert.equal(rows.length,calculated+1);
 const verified=await verifyPayoutHistory({...f.args,rows});
 assert.equal(verified.periods,rows.length);
 assert.ok(Object.values(f.rounds).some(r=>r.closed&&r.distributed<r.total),'partial close/cancel occurred');
 assert.ok(Object.values(f.rounds).some(r=>r.distributed===r.total),'fully delivered rounds occurred');
 t.diagnostic(`${calculated} committed periods, ${pending} pending-plan retries; ${Object.keys(f.rounds).length} rounds; ${rows.length} independently replayed records`);
});

test('Final accounting: closed-round corruption and missing archive logs cannot change any prior state',async()=>{
 const account=address(0x7311),root='0x'+'91'.repeat(32);
 const base={accrued:{[account]:'7'},plans:{1:{roundId:'1',root,total:'23',toBlock:2,payouts:{[account]:'23'}}}};
 const badLogs=[[],[{blockNumber:3,args:{account,amount:22n}}],[{blockNumber:3,args:{account,amount:23n}},{blockNumber:3,args:{account,amount:23n}}],[{blockNumber:9,args:{account,amount:23n}}]];
 for(const events of badLogs){
  const state=structuredClone(base),saved=hash(state);
  const d={roundInfo:async()=>[root,23n,23n,false,true],filters:{Paid:()=>1},queryFilter:async()=>events};
  await assert.rejects(reconcile(d,state,8,100));assert.equal(hash(state),saved);
 }
 await assert.rejects(scanEvents({queryFilter:async()=>{throw Error('archive timeout');}},1,1,100,10),/archive timeout/);
 await assert.rejects(scanEvents({queryFilter:async()=>[{removed:true,blockNumber:2}]},1,1,100,10),/outside snapshot/);
});

test('Final accounting: same-timestamp swaps and self-transfers do not create holder-time or linear shares',()=>{
 const a=address(0x7401),b=address(0x7402),c=address(0x7403),starting={[a]:1000000n,[b]:500000n};
 const events=[{blockNumber:1,index:0,args:{from:a,to:c,value:1000000n}},{blockNumber:1,index:1,args:{from:c,to:c,value:1000000n}},{blockNumber:1,index:2,args:{from:c,to:a,value:1000000n}}];
 const r=computeTWAB(starting,events,new Map([[1,10800]]),0,21600);
 assert.equal(r.twab[c],0n);assert.equal(r.twab[a],starting[a]);assert.equal(r.twab[b],starting[b]);
 const shares=computeShares(r.twab,1n,1500n,'linear').shares;
 assert.deepEqual(shares,{[a]:1000n,[b]:500n});
});

test('Final keeper nonce: pending work that appeared after an earlier check blocks sends, and resolution releases the barrier',async t=>{
 const f=simulation(t);await f.bootstrap();const record=await f.period(0);assert.ok(record.plan);
 let pendingNonce=0,sends=0,next=1n,pending=[ZeroHash,0n,0n];
 const signer=address(0x7511),chainId='31337';
 const provider={...f.args.provider,getNetwork:async()=>({chainId:BigInt(chainId)}),
  getTransactionCount:async(_address,tag)=>tag==='pending'?pendingNonce:0,
  getBlock:async tag=>f.args.provider.getBlock(tag==='latest'?'finalized':tag)};
 // This reproduces the exact permitted interleaving: the CLI sees no pending nonce, then waits
 // behind another signer-locked job. That job broadcasts and times out, releasing its lock.
 assert.equal(await provider.getTransactionCount(signer,'pending'),await provider.getTransactionCount(signer,'latest'));
 pendingNonce=1;
 const d={getAddress:async()=>f.args.config.distributor,rewardToken:async()=>address(0x7201),
  nextRoundId:async()=>next,roundInfo:async()=>emptyRound(),pending:async()=>pending,
  isProposer:async()=>true,owner:async()=>signer,proposalsPaused:async()=>false,
  maxProposableTotal:async()=>BigInt(record.plan.total),nextProposalAllowedAt:async()=>0n,
  proposeRound:async(root,total)=>{sends++;return {hash:'0x'+'e7'.repeat(32),wait:async()=>{
   next=2n;pending=[root,BigInt(total),0n];return {status:1,logs:[]};
  }};},
 };
 const keeperArgs={dir:f.args.dir,config:f.args.config,provider,distributor:d,signerAddress:signer,
  execute:true,propose:true,proposeOnly:true,
  verifyHistory:async()=>verifyPayoutHistory({...f.args,rows:new Journal(f.args.dir).entries()})};
 await assert.rejects(runKeeper(keeperArgs),/signer has pending transactions/);
 assert.equal(sends,0,'no broadcast while an earlier transaction is unresolved');
 assert.equal(fs.existsSync(path.join(f.args.dir,'.writer-lock')),false,'journal lock was not stranded');
 const proposer=address(0x7522),nonceReads=[];
 const originalNonceRead=provider.getTransactionCount;
 provider.getTransactionCount=async(a,tag)=>{
  // Both locks must already be held before either signer's freshness is checked.
  for(const locked of [signer,proposer])assert.throws(()=>acquireExecutionLock(chainId,locked),/keeper lock exists/);
  nonceReads.push(a);return a===proposer&&tag==='pending'?1:0;
 };
 await assert.rejects(runKeeper({...keeperArgs,ownerAddress:proposer}),/signer has pending transactions/);
 assert.deepEqual([...new Set(nonceReads)].sort(),[signer,proposer].sort());
 assert.equal(sends,0,'a pending proposer nonce is checked in addition to the keeper nonce');
 for(const invalid of [NaN,-1,Number.MAX_SAFE_INTEGER+1]){
  provider.getTransactionCount=async()=>invalid;
  await assert.rejects(runKeeper(keeperArgs),/invalid signer nonce/);
 }
 provider.getTransactionCount=async()=>{throw Error('nonce RPC unavailable');};
 await assert.rejects(runKeeper(keeperArgs),/nonce RPC unavailable/);
 assert.equal(sends,0,'malformed and failed nonce reads cannot authorize a send');
 provider.getTransactionCount=originalNonceRead;
 pendingNonce=0;
 const result=await runKeeper(keeperArgs);
 assert.equal(result.rounds[0].status,'activation-ready');
 assert.equal(sends,1,'the signer lock was released and normal operation resumes after reconciliation');
});
