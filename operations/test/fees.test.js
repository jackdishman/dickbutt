import test from 'node:test';
import assert from 'node:assert/strict';
import {runFeeCycle} from '../fees.js';
function fixture(){
 const sent=[]; const tx=name=>async()=>{sent.push(name);return {hash:name,wait:async()=>({status:1})};};
 const c={provider:{getNetwork:async()=>({chainId:31337n}),getBlock:async()=>({timestamp:1000})},signerAddress:'keeper',execute:true,
 locker:{ownsLocker:async()=>true,lastHarvestAt:async()=>0n,minInterval:async()=>60n,harvest:tx('locker')},
 aero:{holdsPosition:async()=>true,lastHarvestAt:async()=>999n,minInterval:async()=>60n,harvest:tx('aero')},
 legacy:{isTokenCreator:async()=>true,safeCount:async()=>2n,harvestFrom:async i=>tx(`legacy${i}`)()},
 feeRouter:{splitDickbutt:tx('dick'),splitWeth:tx('weth')},
 executor:{getAddress:async()=> 'executor',isKeeper:async()=>true,priceFloorExpiresAt:async()=>1100n,minSpcxcPerWeth:async()=>1n,lastSwapAt:async()=>0n,minSwapInterval:async()=>0n,maxSwapPerCall:async()=>500n,processWeth:tx('swap')},
 weth:{balanceOf:async()=>1000n},quote:async amount=>amount*2n}; return {c,sent};
}
test('harvests available sources, splits before capped quote and swap',async()=>{
 const {c,sent}=fixture(); const result=await runFeeCycle(c);assert.deepEqual(sent,['locker','legacy0','legacy1','dick','weth','swap']);assert.equal(result.actions.at(-1).action,'swap');
});
test('dry-run never calls writes; mainnet execute rejected',async()=>{
 const {c,sent}=fixture();await runFeeCycle({...c,execute:false});assert.deepEqual(sent,[]);
 await assert.rejects(runFeeCycle({...c,provider:{...c.provider,getNetwork:async()=>({chainId:8453n})}}),/disabled/);assert.deepEqual(sent,[]);
});
test('expired floor blocks swap and reports pending refresh without losing harvested fees',async()=>{
 const {c,sent}=fixture();c.executor.priceFloorExpiresAt=async()=>999n; const out=await runFeeCycle(c);assert.ok(!sent.includes('swap'));assert.equal(out.swapStatus,'price-floor-refresh-required');
});
test('bad quote and reverted receipts abort',async()=>{
 const {c}=fixture();await assert.rejects(runFeeCycle({...c,quote:async()=>0n}),/quote/);
 c.locker.harvest=async()=>({hash:'fail',wait:async()=>({status:0})});await assert.rejects(runFeeCycle(c),/receipt/);
});

test('a source still awaiting its custody handoff is skipped and reported; the rest of the cycle runs',async()=>{
 const {c,sent}=fixture();c.locker.ownsLocker=async()=>false;c.legacy.isTokenCreator=async()=>false;
 const out=await runFeeCycle(c);
 assert.deepEqual(sent,['dick','weth','swap'],'routing and the swap must not wait on a handoff');
 assert.deepEqual(out.awaitingHandoff,['locker','legacy']);
 assert.ok(out.actions.some(a=>a.action==='locker'&&a.status==='awaiting-handoff'&&/does not own the locker/.test(a.reason)));
 assert.ok(out.actions.some(a=>a.action==='legacy'&&a.status==='awaiting-handoff'));
 // The dry run shows the same picture, so an operator sees the handoff state before signing anything.
 const dry=await runFeeCycle({...fixture().c,execute:false,aero:{holdsPosition:async()=>false}});
 assert.deepEqual(dry.awaitingHandoff,['aero']);
});
