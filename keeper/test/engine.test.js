import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { runCalculator } from '../../calculator/engine.js';
import { Journal, hash, stringify } from '../../calculator/journal.js';
import { runKeeper, acquireExecutionLock } from '../engine.js';
const a='0x00000000000000000000000000000000000000aa', b='0x00000000000000000000000000000000000000bb';
const tokenAddress='0x0000000000000000000000000000000000000011', rewardAddress='0x0000000000000000000000000000000000000022', distributorAddress='0x0000000000000000000000000000000000000033';
const blockHash='0x'+'ab'.repeat(32);
async function fixture(t,configOverrides={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'keeper-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const config={chainId:'31337',token:tokenAddress,distributor:distributorAddress,deployBlock:1,holderThresholdRaw:'1',payoutThresholdRaw:'1',curve:'linear',excluded:[ethers.ZeroAddress],batchSize:2,chunkSize:100,finalityTag:'finalized',...configOverrides};
 const chain={id:BigInt(config.chainId),now:100,next:1n,pending:[ethers.ZeroHash,0n,0n],round:[ethers.ZeroHash,0n,0n,false,false],paid:new Set(),fail:new Set(),calls:[],waits:0,allowed:true};
 const provider={getNetwork:async()=>({chainId:chain.id}),getTransactionCount:async()=>0,getBlock:async n=>({number:n==='finalized'||n==='latest'?10:n,hash:blockHash,timestamp:n==='latest'?chain.now:(n==='finalized'?10:n)*10}),getCode:async()=> '0x01'};
 const tx=(name,fn)=>{chain.calls.push(name);return {hash:'0x'+'12'.repeat(32),wait:async()=>{chain.waits++;fn();return {status:1,hash:'0x'+'12'.repeat(32),logs:chain.logs??[]};}};};
 const distributor={getAddress:async()=>distributorAddress,rewardToken:async()=>rewardAddress,nextRoundId:async()=>chain.next,availableForNextRound:async()=>100n,minPayout:async()=>1n,roundInfo:async()=>[...chain.round],pending:async()=>[...chain.pending],paid:async(_id,account)=>chain.paid.has(account),isKeeper:async()=>chain.allowed,owner:async()=>a,isProposer:async()=>chain.proposer??false,proposalsPaused:async()=>chain.paused??false,maxProposableTotal:async()=>chain.maxTotal??(1n<<128n),nextProposalAllowedAt:async()=>chain.allowedAt??0n,
 proposeRound:async(root,total)=>tx('propose',()=>{chain.next++;chain.pending=[root,BigInt(total),BigInt(chain.now+(chain.reviewDelay??3600))];}),
 activateRound:async()=>tx('activate',()=>{chain.round=[chain.pending[0],chain.pending[1],0n,true,false];chain.pending=[ethers.ZeroHash,0n,0n];}),
 distributeBatch:async(_id,accounts,amounts)=>tx('batch',()=>{chain.logs=[];for(let i=0;i<accounts.length;i++){if(chain.fail.has(accounts[i])){chain.logs.push({address:distributorAddress,parsed:{name:'PaymentFailed',args:{roundId:1n,account:accounts[i],amount:BigInt(amounts[i])}}});continue;}assert.ok(!chain.paid.has(accounts[i]),'executor must filter already-paid accounts');chain.paid.add(accounts[i]);chain.round[2]+=BigInt(amounts[i]);}}),
 closeRound:async()=>tx('close',()=>{assert.equal(chain.round[2],chain.round[1]);chain.round[3]=false;chain.round[4]=true;}),interface:{parseLog:log=>log.parsed}};
 const token={decimals:async()=>18n,filters:{Transfer:()=>1},queryFilter:async()=>[a,b].map((account,index)=>({blockNumber:1,index,args:{from:ethers.ZeroAddress,to:account,value:100n}}))};
 const record=await runCalculator({dir,provider,token,distributor,config,rewardTokenFactory:()=>({decimals:async()=>18n})});
 const activate=()=>{chain.next=2n;chain.round=[record.plan.root,BigInt(record.plan.total),0n,true,false];};
 // These fixtures model live lifecycle state only, not historical eth_call. Independent
 // history replay has its own tests and is exercised with real contracts in the rehearsal.
 return {dir,provider,distributor,config,signerAddress:a,chain,record,activate,verifyHistory:async()=>({fixtureOnly:true})};
}
function rewrite(f,mutate){const file=path.join(f.dir,'periods','00000001.json'),row=JSON.parse(fs.readFileSync(file));mutate(row.record);row.hash=hash({previous:row.previous,record:row.record});fs.writeFileSync(file,stringify(row));}
test('keeper streams the pinned journal without materializing entries',async t=>{
 const f=await fixture(t),original=Journal.prototype.entries;let checked=0;
 f.verifyHistory=async({rows})=>{
  assert.equal(Array.isArray(rows),false);
  for(const row of rows){assert.equal(row.record.root,f.record.root);checked++;}
  return {periods:checked};
 };
 Journal.prototype.entries=()=>{throw Error('keeper must not materialize every historical record');};
 try {
  const result=await runKeeper({...f,execute:true,propose:true});
  assert.equal(checked,1);assert.equal(result.rounds[0].status,'timelocked');
  assert.deepEqual(f.chain.calls,['propose']);
 } finally {Journal.prototype.entries=original;}
});
test('rehashed replacement or truncation after the first pass cannot authorize a send',async t=>{
 for(const change of ['rewrite','truncate']) {
  const f=await fixture(t);
  f.verifyHistory=async({rows})=>{
   if(change==='rewrite')rewrite(f,r=>{r.state.balances[a]='999';});
   else fs.unlinkSync(path.join(f.dir,'periods','00000001.json'));
   for(const _row of rows){}
   return {periods:1};
  };
  await assert.rejects(runKeeper({...f,execute:true,propose:true}),/journal changed after initial validation/);
  assert.deepEqual(f.chain.calls,[],change);
 }
});
test('recipient plan reload rejects a changed record before payment',async t=>{
 const f=await fixture(t);f.activate();const read=f.distributor.roundInfo;let reads=0;
 f.distributor.roundInfo=async(...args)=>{
  if(++reads===1)rewrite(f,r=>{r.state.balances[a]='999';});
  return read(...args);
 };
 await assert.rejects(runKeeper({...f,execute:true}),/journal plan changed after initial validation/);
 assert.deepEqual(f.chain.calls,[]);
});
test('a valid appended record changes the pinned head and blocks the pending send',async t=>{
 const f=await fixture(t);
 f.verifyHistory=async({rows})=>{
  const first=JSON.parse(fs.readFileSync(path.join(f.dir,'periods','00000001.json'),'utf8'));
  const record=structuredClone(first.record);
  record.fromBlock=record.state.lastProcessedBlock+1;
  record.block.number=record.fromBlock;record.block.hash='0x'+record.fromBlock.toString(16).padStart(64,'0');
  record.periodStartTs=record.periodEndTs;record.periodEndTs+=10;
  record.startingAccrual=structuredClone(record.endingAccrual);
  record.recredits={};record.newShares={};record.payouts={};
  record.plan=null;record.root=null;record.roundId=null;
  record.state.lastProcessedBlock=record.block.number;record.state.blockHash=record.block.hash;
  const next={previous:first.hash,record};next.hash=hash(next);
  fs.writeFileSync(path.join(f.dir,'periods','00000002.json'),stringify(next));
  assert.equal(new Journal(f.dir).entries().length,2,'appended record must pass journal validation');
  for(const _row of rows){}
  return {periods:2};
 };
 await assert.rejects(runKeeper({...f,execute:true,propose:true}),/journal changed after initial validation/);
 assert.deepEqual(f.chain.calls,[]);
});
test('independent history failure stops before any transaction',async t=>{
 const f=await fixture(t);f.verifyHistory=async()=>{throw Error('independent payout calculation mismatch');};
 await assert.rejects(runKeeper({...f,execute:true,propose:true}),/independent payout calculation mismatch/);
 assert.deepEqual(f.chain.calls,[]);
});
test('no-action execute runs skip independent replay but do not claim verification',async t=>{
 for (const kind of ['not-proposing','timelocked','proposer-waits','proposer-active','closed','rate-limited','foreign']) {
  const f=await fixture(t);let replays=0;
  f.verifyHistory=async()=>{replays++;throw Error('no-action run must not replay');};
  const options={...f,execute:true};
  if (kind==='timelocked'||kind==='proposer-waits') {
   f.chain.next=2n;f.chain.pending=[f.record.plan.root,BigInt(f.record.plan.total),BigInt(f.chain.now+(kind==='timelocked'?60:0))];
  }
  if (kind==='proposer-waits'||kind==='proposer-active') Object.assign(options,{propose:true,proposeOnly:true});
  if (kind==='proposer-active'||kind==='closed') f.activate();
  if (kind==='closed') {f.chain.round[3]=false;f.chain.round[4]=true;}
  if (kind==='rate-limited') {options.propose=true;f.chain.allowedAt=BigInt(f.chain.now+60);}
  if (kind==='foreign') {f.chain.next=2n;f.chain.pending=['0x'+'f0'.repeat(32),5n,0n];}
  const result=await runKeeper(options);
  assert.equal(replays,0,kind);assert.deepEqual(f.chain.calls,[],kind);
  assert.deepEqual(result.historyVerification,{status:'skipped',reason:'no-transaction-required'},kind);
 }
});
test('dry-run audit still independently checks a closed round',async t=>{
 const f=await fixture(t);f.activate();f.chain.round[2]=BigInt(f.record.plan.total);f.chain.round[3]=false;f.chain.round[4]=true;
 f.distributor.paid=async()=>{throw Error('fully paid closed round must not query flags');};
 f.verifyHistory=async()=>{throw Error('independent payout calculation mismatch');};
 await assert.rejects(runKeeper(f),/independent payout calculation mismatch/);
 assert.deepEqual(f.chain.calls,[]);
});
test('fully distributed closed rounds skip recipient flags while dry runs still verify history',async t=>{
 for(const execute of [false,true]) {
  const f=await fixture(t);f.activate();f.chain.now=100000;
  f.chain.round[2]=BigInt(f.record.plan.total);f.chain.round[3]=false;f.chain.round[4]=true;
  let replays=0;
  f.verifyHistory=async()=>{replays++;return {fixtureOnly:true};};
  f.distributor.paid=async()=>{throw Error('old fully paid round must not query recipient flags');};
  const result=await runKeeper({...f,execute});
  assert.equal(result.rounds[0].status,'closed');assert.deepEqual(result.rounds[0].unpaid,[]);
  assert.equal(replays,execute?0:1);assert.deepEqual(f.chain.calls,[]);
  assert.deepEqual(result.historyVerification,execute?{status:'skipped',reason:'no-transaction-required'}:{fixtureOnly:true});
 }
});
test('partially distributed closed rounds retain exact unpaid-recipient reporting',async t=>{
 for(const execute of [false,true]) {
  const f=await fixture(t);f.activate();f.chain.paid.add(a);
  f.chain.round[2]=BigInt(f.record.plan.payouts[a]);f.chain.round[3]=false;f.chain.round[4]=true;
  const queried=[];let replays=0;
  f.distributor.paid=async(_roundId,account)=>{queried.push(account);return f.chain.paid.has(account);};
  f.verifyHistory=async()=>{replays++;return {fixtureOnly:true};};
  const result=await runKeeper({...f,execute});
  assert.equal(result.rounds[0].status,'closed-unpaid');assert.deepEqual(result.rounds[0].unpaid,[b]);
  assert.deepEqual(queried,[a,b]);assert.equal(replays,execute?0:1);assert.deepEqual(f.chain.calls,[]);
 }
});
test('every action requires independent verification before its first send',async t=>{
 for (const action of ['propose','activate','batch','close']) {
  const f=await fixture(t);let replays=0;
  f.verifyHistory=async()=>{replays++;throw Error(`reject before ${action}`);};
  if (action==='activate') {f.chain.next=2n;f.chain.pending=[f.record.plan.root,BigInt(f.record.plan.total),0n];}
  if (action==='batch'||action==='close') f.activate();
  if (action==='close') {f.chain.paid=new Set([a,b]);f.chain.round[2]=BigInt(f.record.plan.total);}
  await assert.rejects(runKeeper({...f,execute:true,propose:action==='propose'}),new RegExp(`reject before ${action}`));
  assert.equal(replays,1,action);assert.deepEqual(f.chain.calls,[],action);
 }
});
test('verification is once per locked invocation and repeated before the next invocation sends',async t=>{
 const f=await fixture(t);f.chain.reviewDelay=0;let replays=0;
 f.verifyHistory=async()=>{assert.equal(f.chain.calls.length,0);replays++;return {periods:1};};
 const result=await runKeeper({...f,execute:true,propose:true});
 assert.deepEqual(f.chain.calls,['propose','activate','batch','close']);assert.equal(replays,1);
 assert.deepEqual(result.historyVerification,{periods:1});
 // A subsequent invocation cannot inherit this successful verification, even with
 // identical files. Model an active state that now requires a close transaction.
 f.chain.round[3]=true;f.chain.round[4]=false;
 f.verifyHistory=async()=>{replays++;throw Error('new replay rejects');};
 await assert.rejects(runKeeper({...f,execute:true}),/new replay rejects/);
 assert.equal(replays,2);assert.deepEqual(f.chain.calls,['propose','activate','batch','close']);
});
test('a round becoming ready after initial inspection still crosses the replay barrier',async t=>{
 const f=await fixture(t);f.chain.next=2n;f.chain.pending=[f.record.plan.root,BigInt(f.record.plan.total),BigInt(f.chain.now+60)];
 let inspections=0;const read=f.distributor.roundInfo;
 f.distributor.roundInfo=async(...args)=>{if(++inspections===2)f.chain.pending[2]=0n;return read(...args);};
 f.verifyHistory=async()=>{throw Error('independent check required for newly available action');};
 await assert.rejects(runKeeper({...f,execute:true}),/independent check required/);
 assert.deepEqual(f.chain.calls,[]);
});
test('proposal state and limits are reread after a slow independent verification',async t=>{
 for (const change of ['next-id','already-proposed','foreign','paused','cap','cooldown','authority']) {
  const f=await fixture(t);
  f.verifyHistory=async()=>{
   if(change==='next-id')f.chain.next=3n;
   if(change==='already-proposed'||change==='foreign') {f.chain.next=2n;f.chain.pending=[change==='foreign'?'0x'+'f0'.repeat(32):f.record.plan.root,BigInt(f.record.plan.total),0n];}
   if(change==='paused')f.chain.paused=true;
   if(change==='cap')f.chain.maxTotal=1n;
   if(change==='cooldown')f.chain.allowedAt=BigInt(f.chain.now+60);
   if(change==='authority')f.distributor.owner=async()=>b;
   return {periods:1};
  };
  await assert.rejects(runKeeper({...f,execute:true,propose:true}),/round id|state changed|commitment changed|paused|share cap|rate limit changed|neither an approved proposer/);
  assert.deepEqual(f.chain.calls,[],change);
 }
});
test('activation refuses a pending round changed, activated, or cancelled during replay',async t=>{
 for (const change of ['foreign','activated','cancelled','timelock']) {
  const f=await fixture(t);f.chain.next=2n;f.chain.pending=[f.record.plan.root,BigInt(f.record.plan.total),0n];
  f.verifyHistory=async()=>{
   if(change==='foreign')f.chain.pending[0]='0x'+'f0'.repeat(32);
   if(change==='activated'||change==='cancelled') {f.chain.pending=[ethers.ZeroHash,0n,0n];f.chain.round=[f.record.plan.root,BigInt(f.record.plan.total),0n,change==='activated',change==='cancelled'];}
   if(change==='timelock')f.chain.pending[2]=BigInt(f.chain.now+60);
   return {periods:1};
  };
  await assert.rejects(runKeeper({...f,execute:true}),/commitment changed|activation state changed/);
  assert.deepEqual(f.chain.calls,[],change);
 }
});
test('batch and close refuse a round cancelled during replay',async t=>{
 for(const action of ['batch','close']) {
  const f=await fixture(t);f.activate();
  if(action==='close'){f.chain.paid=new Set([a,b]);f.chain.round[2]=BigInt(f.record.plan.total);}
  f.verifyHistory=async()=>{f.chain.round[3]=false;f.chain.round[4]=true;return {periods:1};};
  await assert.rejects(runKeeper({...f,execute:true}),new RegExp(`${action} state changed`));
  assert.deepEqual(f.chain.calls,[],action);
 }
});
test('no-action jobs still reject corrupted journal identity, proofs, snapshots and commitments',async t=>{
 for (const fault of ['hash','identity','proof','snapshot','commitment']) {
  const f=await fixture(t);f.activate();f.chain.round[3]=false;f.chain.round[4]=true;
  f.verifyHistory=async()=>{throw Error('must reject before replay');};
  if (fault==='hash') {
   const file=path.join(f.dir,'periods','00000001.json'),row=JSON.parse(fs.readFileSync(file));row.hash='forged';fs.writeFileSync(file,stringify(row));
  }
  if (fault==='identity') rewrite(f,r=>{r.configHash='forged';});
  if (fault==='proof') rewrite(f,r=>{r.plan.batches[0].proofs[0]=[ethers.ZeroHash];});
  if (fault==='snapshot') f.provider.getBlock=async()=>({hash:ethers.ZeroHash,timestamp:100});
  if (fault==='commitment') f.chain.round[1]++;
  await assert.rejects(runKeeper({...f,execute:true}),/journal hash|configuration identity|Merkle plan|snapshot hash|commitment mismatch/);
  assert.deepEqual(f.chain.calls,[],fault);
 }
});
test('no-action jobs preserve nonce and unresolved-transaction recovery barriers',async t=>{
 const f=await fixture(t);f.chain.next=2n;f.chain.pending=[f.record.plan.root,BigInt(f.record.plan.total),BigInt(f.chain.now+60)];
 f.verifyHistory=async()=>{throw Error('no-action job must not replay');};
 f.provider.getTransactionCount=async(_address,tag)=>tag==='pending'?1:0;
 await assert.rejects(runKeeper({...f,execute:true}),/pending transactions/);
 f.provider.getTransactionCount=async()=>0;
 const marker=path.join(f.dir,'keeper-pending-transaction.json');
 fs.writeFileSync(marker,stringify({hash:'0x'+'34'.repeat(32)}));
 f.provider.getTransactionReceipt=async()=>null;
 await assert.rejects(runKeeper({...f,execute:true}),/unresolved transaction/);
 assert.equal(fs.existsSync(marker),true);assert.deepEqual(f.chain.calls,[]);
});
test('dry run defaults to proposal preview with no sends',async t=>{const f=await fixture(t);const r=await runKeeper(f);assert.equal(r.mode,'dry-run');assert.equal(r.rounds[0].status,'proposal-required');assert.deepEqual(f.chain.calls,[]);});
test('explicit proposal waits for receipt and timelock, rerun does not repropose',async t=>{const f=await fixture(t);const first=await runKeeper({...f,execute:true,propose:true});assert.equal(first.rounds[0].status,'timelocked');assert.deepEqual(f.chain.calls,['propose']);await runKeeper({...f,execute:true,propose:true});assert.deepEqual(f.chain.calls,['propose']);f.chain.now+=3600;const done=await runKeeper({...f,execute:true});assert.equal(done.rounds[0].status,'closed');assert.deepEqual(f.chain.calls,['propose','activate','batch','close']);assert.equal(f.chain.waits,4);});
test('zero-delay proposer stops after committing; keeper pays and retries without time travel or duplicates',async t=>{
 const f=await fixture(t);f.chain.reviewDelay=0;
 const proposal=await runKeeper({...f,execute:true,propose:true,proposeOnly:true});
 assert.equal(proposal.rounds[0].status,'activation-ready');assert.deepEqual(f.chain.calls,['propose']);
 f.chain.fail.add(b);
 const partial=await runKeeper({...f,execute:true});assert.equal(partial.rounds[0].status,'partial');
 f.chain.fail.clear();
 const complete=await runKeeper({...f,execute:true});assert.equal(complete.rounds[0].status,'closed');
 assert.equal(f.chain.now,100);assert.equal(f.chain.round[2],100n);
 const repeat=await runKeeper({...f,execute:true});assert.deepEqual(repeat.transactions,[]);
 assert.deepEqual(f.chain.calls,['propose','activate','batch','batch','close']);
});
test('failed recipient stays open, rerun filters paid accounts and completes once',async t=>{const f=await fixture(t);f.activate();f.chain.fail.add(b);const first=await runKeeper({...f,execute:true});assert.equal(first.rounds[0].status,'partial');assert.deepEqual(first.rounds[0].unpaid,[b]);assert.equal(first.rounds[0].failed[0].account,b);assert.equal(f.chain.round[4],false);f.chain.fail.clear();const second=await runKeeper({...f,execute:true});assert.equal(second.rounds[0].status,'closed');assert.equal(f.chain.round[2],100n);await runKeeper({...f,execute:true,propose:true});assert.deepEqual(f.chain.calls,['batch','batch','close']);});
test('commitment mismatch rejects before transactions',async t=>{const f=await fixture(t);f.activate();f.chain.round[0]=ethers.ZeroHash;await assert.rejects(runKeeper({...f,execute:true}),/commitment/);assert.deepEqual(f.chain.calls,[]);});
test('tampered proof in a correctly rehashed journal is rejected',async t=>{const f=await fixture(t);rewrite(f,r=>{r.plan.batches[0].proofs[0]=[ethers.ZeroHash];});await assert.rejects(runKeeper({...f,execute:true,propose:true}),/plan|Merkle|batch/);assert.deepEqual(f.chain.calls,[]);});
test('configuration identity and reward token mismatches reject before proposals',async t=>{const f=await fixture(t);await assert.rejects(runKeeper({...f,config:{...f.config,curve:'sqrt'},execute:true,propose:true}),/config/);f.distributor.rewardToken=async()=>a;await assert.rejects(runKeeper({...f,execute:true,propose:true}),/reward token/);assert.deepEqual(f.chain.calls,[]);});
test('production execute and wrong RPC chain are rejected',async t=>{const f=await fixture(t);f.chain.id=8453n;await assert.rejects(runKeeper({...f,execute:true}),/chain|production/);f.config.chainId='8453';await assert.rejects(runKeeper({...f,execute:true}),/chain|production/);assert.deepEqual(f.chain.calls,[]);});
test('Base execution requires explicit opt-in, reviewed matching config and independent history',async t=>{
 const f=await fixture(t,{chainId:'8453',excluded:[ethers.ZeroAddress,distributorAddress]});
 await assert.rejects(runKeeper({...f,execute:true,propose:true}),/requires explicit allowMainnet/);
 let replays=0;
 f.verifyHistory=async()=>{replays++;throw Error('mainnet independent calculation rejects');};
 await assert.rejects(runKeeper({...f,execute:true,allowMainnet:true,propose:true}),/mainnet independent calculation rejects/);
 assert.equal(replays,1);assert.deepEqual(f.chain.calls,[]);
 f.verifyHistory=async()=>{replays++;return {fixtureOnly:true};};
 const result=await runKeeper({...f,execute:true,allowMainnet:true,propose:true});
 assert.equal(result.rounds[0].status,'timelocked');assert.equal(replays,2);assert.deepEqual(f.chain.calls,['propose']);
 const unsafe=await fixture(t,{chainId:'8453'});
 await assert.rejects(runKeeper({...unsafe,execute:true,allowMainnet:true,propose:true}),/distributor must be excluded/);
 assert.deepEqual(unsafe.chain.calls,[]);
 const local=await fixture(t);
 await assert.rejects(runKeeper({...local,execute:true,allowMainnet:true}),/valid only on Base mainnet/);
 assert.deepEqual(local.chain.calls,[]);
});
test('cancelled or early closed round reports unpaid without reproposal',async t=>{const f=await fixture(t);f.activate();f.chain.round[3]=false;f.chain.round[4]=true;const r=await runKeeper({...f,execute:true,propose:true});assert.equal(r.rounds[0].status,'closed-unpaid');assert.equal(r.rounds[0].unpaid.length,2);assert.deepEqual(f.chain.calls,[]);});
test('round id already consumed without matching state is rejected',async t=>{const f=await fixture(t);f.chain.next=2n;await assert.rejects(runKeeper({...f,execute:true,propose:true}),/round id/);assert.deepEqual(f.chain.calls,[]);});
test('reverted transaction stops without retries and releases process lock',async t=>{const f=await fixture(t);f.activate();f.distributor.distributeBatch=async()=>({hash:'0xbad',wait:async()=>({status:0,logs:[]})});await assert.rejects(runKeeper({...f,execute:true}),/transaction|receipt/);f.chain.allowed=false;await assert.rejects(runKeeper({...f,execute:true}),/keeper/);});
test('exclusive lock prevents concurrent nonce use',async t=>{const f=await fixture(t);f.activate();let release,entered;const gate=new Promise(resolve=>{entered=resolve;});const original=f.distributor.distributeBatch;f.distributor.distributeBatch=async(...args)=>{entered();await new Promise(resolve=>{release=resolve;});return original(...args);};const first=runKeeper({...f,execute:true});await gate;await assert.rejects(runKeeper({...f,execute:true}),/lock/);release();await first;});
test('changed journal snapshot fails before sending',async t=>{const f=await fixture(t);f.provider.getBlock=async()=>({hash:ethers.ZeroHash,timestamp:100});await assert.rejects(runKeeper({...f,execute:true,propose:true}),/snapshot/);assert.deepEqual(f.chain.calls,[]);});
test('pending commitment mismatch fails before activation',async t=>{const f=await fixture(t);f.chain.next=2n;f.chain.pending=[f.record.plan.root,101n,0n];await assert.rejects(runKeeper({...f,execute:true}),/commitment/);assert.deepEqual(f.chain.calls,[]);});
test('unknown receipt blocks rerun until receipt is resolved',async t=>{const f=await fixture(t);f.activate();let sends=0;f.distributor.distributeBatch=async()=>{sends++;return {hash:'0x'+'34'.repeat(32),wait:async()=>{throw Error('RPC timed out');}};};await assert.rejects(runKeeper({...f,execute:true}),/transaction failed/);f.provider.getTransactionReceipt=async()=>null;await assert.rejects(runKeeper({...f,execute:true}),/unresolved transaction/);assert.equal(sends,1);f.provider.getTransactionReceipt=async()=>({status:0,confirmations:async()=>1});f.chain.allowed=false;await assert.rejects(runKeeper({...f,execute:true}),/keeper/);assert.equal(fs.existsSync(path.join(f.dir,'keeper-pending-transaction.json')),false);});
test('proposer role, guardian pause and contract limits are checked before sending',async t=>{
 // Owner remains implicitly able to propose, so the default fixture (owner===signer) still works.
 const owner=await fixture(t);await runKeeper({...owner,execute:true,propose:true});assert.deepEqual(owner.chain.calls,['propose']);
 // A bot key that is neither proposer nor owner is rejected without a transaction.
 const stranger=await fixture(t);stranger.distributor.owner=async()=>b;
 await assert.rejects(runKeeper({...stranger,execute:true,propose:true}),/neither an approved proposer nor/);
 assert.deepEqual(stranger.chain.calls,[]);
 // The same key succeeds once the owner lists it as a proposer.
 const bot=await fixture(t);bot.distributor.owner=async()=>b;bot.chain.proposer=true;
 await runKeeper({...bot,execute:true,propose:true});assert.deepEqual(bot.chain.calls,['propose']);
 // Guardian pause stops proposals before any signing.
 const paused=await fixture(t);paused.chain.paused=true;
 await assert.rejects(runKeeper({...paused,execute:true,propose:true}),/paused by the guardian/);
 assert.deepEqual(paused.chain.calls,[]);
 // A plan larger than the on-chain share cap is reported, not submitted to revert.
 const capped=await fixture(t);capped.chain.maxTotal=1n;
 await assert.rejects(runKeeper({...capped,execute:true,propose:true}),/exceeds the contract share cap/);
 assert.deepEqual(capped.chain.calls,[]);
});
test('rate limited proposal reports instead of reverting and proceeds once elapsed',async t=>{
 const f=await fixture(t);f.chain.allowedAt=BigInt(f.chain.now+3600);
 const waiting=await runKeeper({...f,execute:true,propose:true});
 assert.equal(waiting.rounds[0].status,'proposal-rate-limited');
 assert.equal(waiting.rounds[0].readyAt,String(f.chain.now+3600));
 assert.deepEqual(f.chain.calls,[]);
 f.chain.now+=3600;
 const proceeds=await runKeeper({...f,execute:true,propose:true});
 assert.equal(proceeds.rounds[0].status,'timelocked');
 assert.deepEqual(f.chain.calls,['propose']);
});

test('a foreign root at a planned round id is reported, never paid, and does not halt the run',async t=>{
 const foreign='0x'+'f0'.repeat(32);
 // Pending: someone else committed round 1 before our proposer did.
 const f=await fixture(t);f.chain.next=2n;f.chain.pending=[foreign,5n,BigInt(f.chain.now+3600)];
 const events=[];const r=await runKeeper({...f,execute:true,propose:true,onEvent:e=>events.push(e)});
 assert.equal(r.rounds[0].status,'foreign-commitment');assert.equal(r.rounds[0].foreignRoot,foreign);
 assert.deepEqual(f.chain.calls,[],'nothing is proposed, activated or paid against a foreign root');
 assert.ok(events.some(e=>e.type==='foreign-commitment'&&e.foreignRoot===foreign));
 // Cancelled by the guardian: the plan is superseded and left to the calculator to recredit.
 f.chain.pending=[ethers.ZeroHash,0n,0n];f.chain.round=[foreign,5n,0n,false,true];
 const after=await runKeeper({...f,execute:true,propose:true});
 assert.equal(after.rounds[0].status,'superseded');assert.deepEqual(f.chain.calls,[]);
 // Activated by a third party: still foreign, still untouched.
 f.chain.round=[foreign,5n,0n,true,false];
 const active=await runKeeper({...f,execute:true});
 assert.equal(active.rounds[0].status,'foreign-commitment');assert.deepEqual(f.chain.calls,[]);
});
test('the execution lock waits a bounded time for a peer and then fails with the holder named',()=>{
 const release=acquireExecutionLock('31337',a);
 try {
  const started=Date.now();
  assert.throws(()=>acquireExecutionLock('31337',a,{waitMs:150,pollMs:30}),/lock exists.*held by.*pid/s);
  assert.ok(Date.now()-started>=140,'waited for the lock before giving up');
  assert.throws(()=>acquireExecutionLock('31337',a),/lock exists/);
 } finally { release(); }
 acquireExecutionLock('31337',a,{waitMs:100})();
});
