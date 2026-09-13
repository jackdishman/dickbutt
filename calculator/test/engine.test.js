import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {runCalculator} from '../engine.js';import {Journal} from '../journal.js';import {sum} from '../core.js';
const a='0x00000000000000000000000000000000000000aa',z='0x0000000000000000000000000000000000000000',h='0x'+'ab'.repeat(32);
function fixture(){const calls=[],dir=fs.mkdtempSync(path.join(os.tmpdir(),'engine-'));let boundary=10;const provider={getBlock:async n=>({number:n==='finalized'?boundary:n,hash:h,timestamp:(n==='finalized'?boundary:n)*10})};const read=v=>async o=>{assert.equal(o.blockTag,boundary);calls.push(o.blockTag);return v;};const token={decimals:read(18n),filters:{Transfer:()=>1},queryFilter:async(_f,from)=>from===1?[{blockNumber:1,index:0,args:{from:z,to:a,value:100n}}]:[]};const distributor={nextRoundId:read(9007199254740993n),availableForNextRound:read(100n),maxProposableTotal:read((1n<<128n)),minPayout:read(1n),rewardToken:read(a),roundInfo:async(_r,o)=>{assert.equal(o.blockTag,boundary);return ['0x'+'00'.repeat(32),0n,0n,false,false];}};return {dir,calls,provider,token,distributor,rewardTokenFactory:()=>({decimals:read(18n)}),config:{deployBlock:1,holderThresholdRaw:'1',payoutThresholdRaw:'1',curve:'sqrt',excluded:[z],batchSize:250,finalityTag:'finalized',chainId:'1',token:a,distributor:a},advance:()=>boundary++};}
test('all reads pinned, huge round id preserved, recovery and local collision cannot double accrue',async()=>{const f=fixture();const r=await runCalculator(f);assert.equal(r.plan.roundId,'9007199254740993');assert.equal(r.plan.total,'100');const j=new Journal(f.dir);assert.equal(j.rebuild().lastProcessedBlock,10);fs.unlinkSync(path.join(f.dir,'state.json'));f.advance();const again=await runCalculator(f);assert.equal(again.pendingPlan,true);assert.equal(again.roundId,'9007199254740993');assert.equal(j.rebuild().lastProcessedBlock,10);assert.ok(f.calls.length>=5);});
test('snapshot hash change leaves no committed period',async()=>{const f=fixture();let count=0;f.provider.getBlock=async n=>({number:n==='finalized'?10:n,hash:++count>3?'0x'+'cd'.repeat(32):h,timestamp:(n==='finalized'?10:n)*10});await assert.rejects(runCalculator(f),/snapshot/);assert.equal(new Journal(f.dir).rebuild(),null);});
test('zero-payout periods journal carried balances and rebuild without hidden inputs',async()=>{const f=fixture();f.config.payoutThresholdRaw='1000';const first=await runCalculator(f);assert.equal(first.plan,null);assert.equal(first.endingAccrual[a],100n);fs.unlinkSync(path.join(f.dir,'state.json'));f.advance();const second=await runCalculator(f);assert.equal(second.pot,0n);assert.equal(second.endingAccrual[a],100n);assert.equal(second.periodStartTs,100);assert.equal(second.periodEndTs,110);const j=new Journal(f.dir);assert.equal(j.entries().length,2);assert.equal(j.rebuild().accrued[a],'100');});
test('config economics change and insolvency abort without advancing journal',async()=>{const f=fixture();f.config.payoutThresholdRaw='1000';await runCalculator(f);f.advance();f.config.curve='linear';await assert.rejects(runCalculator(f),/configuration/);f.config.curve='sqrt';f.distributor.availableForNextRound=async()=>99n;await assert.rejects(runCalculator(f),/insolvent/);assert.equal(new Journal(f.dir).entries().length,1);});
test('round share cap bounds new shares and rolls the remainder into the next period',async()=>{
 const f=fixture();
 // Contract admits only 40 raw units per round out of the 100 available.
 f.distributor.maxProposableTotal=async o=>{assert.ok(o.blockTag);return 40n;};
 const first=await runCalculator(f);
 assert.equal(first.potBeforeCap,100n);
 assert.equal(first.pot,40n);
 assert.equal(first.roundCap,40n);
 assert.equal(first.plan.total,'40');
 // Simulate that plan being proposed and paid: the round id advances and the pot shrinks.
 const consumed=BigInt(first.plan.total);
 f.distributor.nextRoundId=async()=>9007199254740994n;
 f.distributor.availableForNextRound=async()=>100n-consumed;
 f.advance();
 const second=await runCalculator(f);
 // Period 1's plan is not yet confirmed on-chain, so it stays locally reserved and the
 // second period only sees what is left beyond it. The reservation clears once it settles.
 assert.equal(second.localReserved,consumed);
 assert.equal(second.potBeforeCap,100n-consumed-consumed);
 assert.ok(BigInt(second.plan.total)<=40n,'every plan stays proposable on-chain');
});
test('a rate-limited proposal recovers on the next scheduled run without intervention',async()=>{
 const f=fixture();
 const first=await runCalculator(f);
 assert.equal(first.plan.total,'100');
 const journal=new Journal(f.dir);
 // The proposal is rejected by the contract's rate limit, so the plan stays local and unproposed.
 // Every later scheduled run must exit cleanly: the propose step that clears this is chained after
 // the calculate step, so a throw here is what made the job permanently stuck.
 for (let run=0;run<3;run++) {
  f.advance();
  const blocked=await runCalculator(f);
  assert.equal(blocked.pendingPlan,true,'a pending plan is a normal state, not a failure');
  assert.equal(blocked.plan.root,first.plan.root);
  assert.equal(journal.entries().length,1,'a blocked run must not journal a period');
 }
 // The proposal lands on a later run: the round id advances and the calculator moves on by itself.
 f.distributor.nextRoundId=async()=>9007199254740994n;
 f.distributor.availableForNextRound=async()=>300n;
 f.advance();
 const recovered=await runCalculator(f);
 assert.ok(!recovered.pendingPlan);
 assert.equal(recovered.roundId,'9007199254740994');
 assert.equal(recovered.localReserved,100n,'the unsettled round stays reserved');
 assert.equal(recovered.plan.total,'200');
 assert.equal(journal.entries().length,2);
});
test('carry pushing the payable total past the cap fails loudly rather than starving a holder',async()=>{
 const f=fixture();
 f.config.payoutThresholdRaw='50';
 f.distributor.maxProposableTotal=async()=>40n;
 const first=await runCalculator(f);
 assert.equal(first.plan,null,'40 accrued is below the 50 payout threshold');
 assert.equal(sum(first.endingAccrual),40n);
 f.advance();
 // Second period lifts the holder to 80, which is payable but larger than one round's cap.
 await assert.rejects(runCalculator(f),/exceeds the distributor round share cap/);
});

test('bootstrap commits balances with a zero pot and is refused after the first period',async()=>{
 const f=fixture();
 const boot=await runCalculator({...f,bootstrap:true});
 assert.equal(boot.bootstrap,true);assert.equal(boot.pot,0n);assert.equal(boot.plan,null);assert.deepEqual(boot.newShares,{});
 assert.equal(boot.state.balances[a],100n,'balances are committed even though nothing is shared');
 f.advance();
 await assert.rejects(runCalculator({...f,bootstrap:true}),/only valid for the first period/);
 assert.equal(new Journal(f.dir).entries().length,1,'a refused bootstrap commits nothing');
 // The untouched pot reappears in the first real period, measured from the bootstrap boundary.
 const real=await runCalculator(f);
 assert.equal(real.bootstrap,false);assert.equal(real.plan.total,'100');assert.equal(real.periodStartTs,100);
});
test('carry below the cap leaves room for the new shares so the round stays proposable',async()=>{
 const f=fixture();
 const b='0x00000000000000000000000000000000000000bb';
 f.token.queryFilter=async(_f,from)=>from===1?[{blockNumber:1,index:0,args:{from:z,to:a,value:90n}},{blockNumber:1,index:1,args:{from:z,to:b,value:10n}}]:[];
 f.config.curve='linear';f.config.payoutThresholdRaw='8';
 f.distributor.maxProposableTotal=async()=>50n;
 const first=await runCalculator(f);
 // 100 available, cap 50: a takes 45 and is paid; b's 5 is below the 8 threshold and carries.
 assert.equal(first.plan.total,'45');assert.equal(first.endingAccrual[b],5n);
 f.distributor.nextRoundId=async()=>9007199254740994n;f.distributor.availableForNextRound=async()=>200n;f.advance();
 const second=await runCalculator(f);
 // Room under the cap is 50 minus the 5 carried, so only 45 of new shares are allocated: a 40, b 4.
 // b's 9 is now payable and the round totals 49, inside the cap. Without the room it would be 55 and fail.
 assert.equal(second.pot,45n);assert.equal(second.plan.total,'49');assert.equal(second.payouts[b],9n);
});
