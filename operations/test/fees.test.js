import test from 'node:test';
import assert from 'node:assert/strict';
import {runFeeCycle} from '../fees.js';
function fixture(){
 const sent=[]; const tx=name=>async()=>{sent.push(name);return {hash:name,wait:async()=>({status:1,blockNumber:100})};};
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
test('legacy claims wait for the Clanker collection receipt before reading the newly funded Safes',async()=>{
 const {c,sent}=fixture();let releaseReceipt;
 const receipt=new Promise(resolve=>{releaseReceipt=resolve;});
 c.locker.harvest=async()=>{sent.push('locker');return {hash:'locker',wait:()=>receipt};};
 c.aero.lastHarvestAt=async()=>0n;
 const running=runFeeCycle(c);
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(sent,['locker'],'no later source, split or swap may run before collection confirms');
 releaseReceipt({status:1,blockNumber:100});
 await running;
 assert.deepEqual(sent,['locker','aero','legacy0','legacy1','dick','weth','swap']);
});
test('a later NFT custody transfer enables Aerodrome in the next executed cycle',async()=>{
 const {c,sent}=fixture();let holdsNft=false;
 c.aero.holdsPosition=async()=>holdsNft;c.aero.lastHarvestAt=async()=>0n;
 const before=await runFeeCycle(c);
 assert.deepEqual(before.awaitingHandoff,['aero']);assert.ok(!sent.includes('aero'));
 assert.equal(before.swapStatus,'processed','existing Clanker/legacy fees still complete');
 sent.length=0;holdsNft=true;
 const after=await runFeeCycle(c);
 assert.deepEqual(after.awaitingHandoff,[]);
 assert.deepEqual(sent,['locker','aero','legacy0','legacy1','dick','weth','swap']);
 assert.equal(after.swapStatus,'processed');
});
test('a lagging latest RPC read cannot hide the WETH delivered by the confirmed split',async()=>{
 const {c,sent}=fixture();
 c.weth.balanceOf=async(_address,overrides)=>overrides?.blockTag===100?1000n:0n;
 c.quote=async(amount,overrides)=>{assert.equal(overrides.blockTag,100);return amount*2n;};
 const result=await runFeeCycle(c);
 assert.equal(result.swapStatus,'processed');assert.equal(sent.at(-1),'swap');
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

test('one reverting Safe is skipped and reported while the rest of the cycle completes',async()=>{
 // Safe owners can disable the module after the handoff check has passed.
 const {c,sent}=fixture();
 c.legacy.harvestFrom=async i=>{if(Number(i)===1)throw Object.assign(Error('execution reverted: module not enabled'),{shortMessage:'module not enabled',code:'CALL_EXCEPTION',action:'estimateGas'});return {hash:`legacy${i}`,wait:async()=>{sent.push(`legacy${i}`);return {status:1};}};};
 const out=await runFeeCycle(c);
 assert.deepEqual(sent,['locker','legacy0','dick','weth','swap']);
 assert.equal(out.legacyStatus,'partial');
 assert.equal(out.swapStatus,'processed');
 assert.deepEqual(out.attention,[{action:'legacy1',reason:'module not enabled'}]);
 assert.deepEqual(out.awaitingHandoff,[],'a revert is not a missing handoff');
});
test('a legacy transaction that was broadcast and then failed stays fatal',async()=>{
 const {c}=fixture();
 c.legacy.harvestFrom=async()=>({hash:'legacy-broadcast',wait:async()=>({status:0})});
 // Skipping here would drop an unresolved hash that the pending-transaction marker exists to catch.
 await assert.rejects(runFeeCycle(c),/receipt/);
});
test('an ambiguous legacy send or RPC error stops the cycle',async()=>{
 for(const failure of [Object.assign(Error('connection lost'),{code:'NETWORK_ERROR'}),
  Object.assign(Error('send failed'),{code:'CALL_EXCEPTION',action:'sendTransaction'})]) {
  const {c,sent}=fixture();c.legacy.harvestFrom=async()=>{throw failure;};
  await assert.rejects(runFeeCycle(c),e=>e===failure);
  assert.deepEqual(sent,['locker'],'do not continue after an uncertain broadcast');
 }
});
test('an awaited handoff is quiet but a skipped Safe asks for attention',async()=>{
 const {c}=fixture();c.legacy.isTokenCreator=async()=>false;
 const out=await runFeeCycle(c);
 assert.equal(out.legacyStatus,'awaiting-handoff');
 assert.deepEqual(out.attention,[],'the pre-handoff state must not page anyone every six hours');
});
