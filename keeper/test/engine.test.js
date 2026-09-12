import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { runCalculator } from '../../calculator/engine.js';
import { hash, stringify } from '../../calculator/journal.js';
import { runKeeper } from '../engine.js';
const a='0x00000000000000000000000000000000000000aa', b='0x00000000000000000000000000000000000000bb';
const tokenAddress='0x0000000000000000000000000000000000000011', rewardAddress='0x0000000000000000000000000000000000000022', distributorAddress='0x0000000000000000000000000000000000000033';
const blockHash='0x'+'ab'.repeat(32);
async function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'keeper-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const config={chainId:'31337',token:tokenAddress,distributor:distributorAddress,deployBlock:1,holderThresholdRaw:'1',payoutThresholdRaw:'1',curve:'linear',excluded:[ethers.ZeroAddress],batchSize:2,chunkSize:100,finalityTag:'finalized'};
 const chain={id:31337n,now:100,next:1n,pending:[ethers.ZeroHash,0n,0n],round:[ethers.ZeroHash,0n,0n,false,false],paid:new Set(),fail:new Set(),calls:[],waits:0,allowed:true};
 const provider={getNetwork:async()=>({chainId:chain.id}),getBlock:async n=>({number:n==='finalized'||n==='latest'?10:n,hash:blockHash,timestamp:n==='latest'?chain.now:(n==='finalized'?10:n)*10}),getCode:async()=> '0x01'};
 const tx=(name,fn)=>{chain.calls.push(name);return {hash:'0x'+'12'.repeat(32),wait:async()=>{chain.waits++;fn();return {status:1,hash:'0x'+'12'.repeat(32),logs:chain.logs??[]};}};};
 const distributor={getAddress:async()=>distributorAddress,rewardToken:async()=>rewardAddress,nextRoundId:async()=>chain.next,availableForNextRound:async()=>100n,minPayout:async()=>1n,roundInfo:async()=>[...chain.round],pending:async()=>[...chain.pending],paid:async(_id,account)=>chain.paid.has(account),isKeeper:async()=>chain.allowed,owner:async()=>a,isProposer:async()=>chain.proposer??false,proposalsPaused:async()=>chain.paused??false,maxProposableTotal:async()=>chain.maxTotal??(1n<<128n),nextProposalAllowedAt:async()=>chain.allowedAt??0n,
 proposeRound:async(root,total)=>tx('propose',()=>{chain.next++;chain.pending=[root,BigInt(total),BigInt(chain.now+3600)];}),
 activateRound:async()=>tx('activate',()=>{chain.round=[chain.pending[0],chain.pending[1],0n,true,false];chain.pending=[ethers.ZeroHash,0n,0n];}),
 distributeBatch:async(_id,accounts,amounts)=>tx('batch',()=>{chain.logs=[];for(let i=0;i<accounts.length;i++){if(chain.fail.has(accounts[i])){chain.logs.push({address:distributorAddress,parsed:{name:'PaymentFailed',args:{roundId:1n,account:accounts[i],amount:BigInt(amounts[i])}}});continue;}assert.ok(!chain.paid.has(accounts[i]),'executor must filter already-paid accounts');chain.paid.add(accounts[i]);chain.round[2]+=BigInt(amounts[i]);}}),
 closeRound:async()=>tx('close',()=>{assert.equal(chain.round[2],chain.round[1]);chain.round[3]=false;chain.round[4]=true;}),interface:{parseLog:log=>log.parsed}};
 const token={decimals:async()=>18n,filters:{Transfer:()=>1},queryFilter:async()=>[a,b].map((account,index)=>({blockNumber:1,index,args:{from:ethers.ZeroAddress,to:account,value:100n}}))};
 const record=await runCalculator({dir,provider,token,distributor,config,rewardTokenFactory:()=>({decimals:async()=>18n})});
 const activate=()=>{chain.next=2n;chain.round=[record.plan.root,BigInt(record.plan.total),0n,true,false];};
 return {dir,provider,distributor,config,signerAddress:a,chain,record,activate};
}
function rewrite(f,mutate){const file=path.join(f.dir,'periods','00000001.json'),row=JSON.parse(fs.readFileSync(file));mutate(row.record);row.hash=hash({previous:row.previous,record:row.record});fs.writeFileSync(file,stringify(row));}
test('dry run defaults to proposal preview with no sends',async t=>{const f=await fixture(t);const r=await runKeeper(f);assert.equal(r.mode,'dry-run');assert.equal(r.rounds[0].status,'proposal-required');assert.deepEqual(f.chain.calls,[]);});
test('explicit proposal waits for receipt and timelock, rerun does not repropose',async t=>{const f=await fixture(t);const first=await runKeeper({...f,execute:true,propose:true});assert.equal(first.rounds[0].status,'timelocked');assert.deepEqual(f.chain.calls,['propose']);await runKeeper({...f,execute:true,propose:true});assert.deepEqual(f.chain.calls,['propose']);f.chain.now+=3600;const done=await runKeeper({...f,execute:true});assert.equal(done.rounds[0].status,'closed');assert.deepEqual(f.chain.calls,['propose','activate','batch','close']);assert.equal(f.chain.waits,4);});
test('failed recipient stays open, rerun filters paid accounts and completes once',async t=>{const f=await fixture(t);f.activate();f.chain.fail.add(b);const first=await runKeeper({...f,execute:true});assert.equal(first.rounds[0].status,'partial');assert.deepEqual(first.rounds[0].unpaid,[b]);assert.equal(first.rounds[0].failed[0].account,b);assert.equal(f.chain.round[4],false);f.chain.fail.clear();const second=await runKeeper({...f,execute:true});assert.equal(second.rounds[0].status,'closed');assert.equal(f.chain.round[2],100n);await runKeeper({...f,execute:true,propose:true});assert.deepEqual(f.chain.calls,['batch','batch','close']);});
test('commitment mismatch rejects before transactions',async t=>{const f=await fixture(t);f.activate();f.chain.round[0]=ethers.ZeroHash;await assert.rejects(runKeeper({...f,execute:true}),/commitment/);assert.deepEqual(f.chain.calls,[]);});
test('tampered proof in a correctly rehashed journal is rejected',async t=>{const f=await fixture(t);rewrite(f,r=>{r.plan.batches[0].proofs[0]=[ethers.ZeroHash];});await assert.rejects(runKeeper({...f,execute:true,propose:true}),/plan|Merkle|batch/);assert.deepEqual(f.chain.calls,[]);});
test('configuration identity and reward token mismatches reject before proposals',async t=>{const f=await fixture(t);await assert.rejects(runKeeper({...f,config:{...f.config,curve:'sqrt'},execute:true,propose:true}),/config/);f.distributor.rewardToken=async()=>a;await assert.rejects(runKeeper({...f,execute:true,propose:true}),/reward token/);assert.deepEqual(f.chain.calls,[]);});
test('production execute and wrong RPC chain are rejected',async t=>{const f=await fixture(t);f.chain.id=8453n;await assert.rejects(runKeeper({...f,execute:true}),/chain|production/);f.config.chainId='8453';await assert.rejects(runKeeper({...f,execute:true}),/chain|production/);assert.deepEqual(f.chain.calls,[]);});
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
