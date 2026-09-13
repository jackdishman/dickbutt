import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ZeroAddress,ZeroHash} from 'ethers';
import {runCalculator} from '../../calculator/engine.js';
import {Journal} from '../../calculator/journal.js';
import {buildPlan} from '../../calculator/core.js';
import {verifyPayoutHistory} from '../verify-history.js';
const a='0x00000000000000000000000000000000000000aa',b='0x00000000000000000000000000000000000000bb',c='0x00000000000000000000000000000000000000cc';
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'independent-history-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let tip=10;
 const block=n=>({number:n,hash:'0x'+n.toString(16).padStart(64,'0'),timestamp:n*10});
 const provider={getBlock:async n=>block(n==='finalized'?tip:n)};
 const config={chainId:'31337',token:a,distributor:b,deployBlock:1,holderThresholdRaw:'50',payoutThresholdRaw:'1',curve:'linear',excluded:[ZeroAddress],batchSize:2,chunkSize:100,finalityTag:'finalized'};
 const events=[a,b].map((to,index)=>({blockNumber:1,index,args:{from:ZeroAddress,to,value:100n}}));
 const token={decimals:async()=>18,filters:{Transfer:()=>1},queryFilter:async(_f,from,to)=>events.filter(e=>e.blockNumber>=from&&e.blockNumber<=to)};
 const distributor={nextRoundId:async()=>1n,availableForNextRound:async()=>100n,maxProposableTotal:async()=>50n,minPayout:async()=>1n,rewardToken:async()=>c,roundInfo:async()=>[ZeroHash,0n,0n,false,false],pending:async()=>[ZeroHash,0n,0n]};
 const rewardTokenFactory=()=>({decimals:async()=>8});
 const args={dir,provider,token,distributor,config,rewardTokenFactory};
 await runCalculator({...args,bootstrap:true});tip=20;await runCalculator(args);
 return {...args,rows:new Journal(dir).entries(),setTip:n=>tip=n,events};
}
test('independent replay accepts valid bootstrap and holder payout periods',async t=>{
 const f=await fixture(t);assert.deepEqual(await verifyPayoutHistory(f),{periods:2,finalizedThrough:20});
});
test('consistent arithmetic and a rebuilt root cannot pay a wallet absent from chain history',async t=>{
 const f=await fixture(t),r=f.rows[1].record,payouts={[c]:r.plan.total};
 const plan=buildPlan(r.roundId,payouts,f.config.batchSize);plan.toBlock=r.plan.toBlock;
 r.newShares=payouts;r.payouts=payouts;r.root=plan.root;r.plan=plan;r.state.plans[r.roundId]=plan;
 await assert.rejects(verifyPayoutHistory(f),/independent payout calculation mismatch/);
});
test('invented starting balances are rejected even with unchanged payouts',async t=>{
 const f=await fixture(t);f.rows[0].record.state.balances[c]='1000000';
 await assert.rejects(verifyPayoutHistory(f),/independent payout calculation mismatch/);
});
test('a period above the real finality boundary is rejected',async t=>{
 const f=await fixture(t);f.setTip(15);
 await assert.rejects(verifyPayoutHistory(f),/beyond the selected finality/);
});
test('changed block identity and missing archive data stop verification',async t=>{
 const f=await fixture(t);f.rows[0].record.block.hash=ZeroHash;
 await assert.rejects(verifyPayoutHistory(f),/snapshot hash changed/);
 const g=await fixture(t);g.token.queryFilter=async()=>{throw Error('archive unavailable');};
 await assert.rejects(verifyPayoutHistory(g),/archive unavailable/);
});
