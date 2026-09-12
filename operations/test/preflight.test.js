import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePoolFacts, validateDeployment, validateSwapRoute} from '../preflight.js';
const a='0x0000000000000000000000000000000000000001';
const b='0x0000000000000000000000000000000000000002';
const f='0x0000000000000000000000000000000000000003';
const good={token0:a,token1:b,factory:f,managerFactory:f,fee:3000,tickSpacing:200,liquidity:1n,positionLiquidity:1n,tickLower:-887200,tickUpper:887200,positionToken0:a,positionToken1:b,positionTickSpacing:200,unstakedFee:0};
const wanted={tokens:[a,b],factory:f,tickSpacing:200,swapFee:3000};
test('only accepts intended funded full-range 0.3% position',()=>{
 assert.deepEqual(validatePoolFacts(good,wanted),[]);
 for(const patch of [{fee:10000},{token0:f},{managerFactory:a},{liquidity:0n},{positionLiquidity:0n},{tickLower:-100},{positionToken1:f},{tickSpacing:100},{positionTickSpacing:100},{unstakedFee:100000}]) assert.ok(validatePoolFacts({...good,...patch},wanted).length);
});
test('absent pool or position cannot pass preflight',()=>{
 assert.ok(validatePoolFacts(null,wanted).length);
 assert.ok(validatePoolFacts({...good,positionLiquidity:undefined},wanted).length);
});
test('deployment needs explicit distinct destinations and governance',()=>{
 assert.ok(validateDeployment({}).length);
 const addresses={kcGreen:a,cdbVault:b,burnAddress:f,owner:'0x0000000000000000000000000000000000000004',keeper:'0x0000000000000000000000000000000000000005'};
 assert.deepEqual(validateDeployment(addresses),[]);
 assert.ok(validateDeployment({...addresses,cdbVault:a}).some(e=>e.includes('distinct')));
 assert.ok(validateDeployment({...addresses,owner:'0x0000000000000000000000000000000000000000'}).length);
 // An unfilled template reports only the missing addresses; absent values are not duplicates.
 const template={kcGreen:null,cdbVault:null,burnAddress:f,owner:null,keeper:null};
 assert.equal(validateDeployment(template).length,4);
 assert.ok(!validateDeployment(template).some(e=>e.includes('distinct')));
});

test('swap route must resolve to the configured two-hop pools with liquidity',()=>{
 const wanted={wethUsdcPool:a,usdcSpcxcPool:b};
 const live={wethUsdc:a,usdcSpcxc:b,wethUsdcLiquidity:1n,usdcSpcxcLiquidity:1n};
 assert.deepEqual(validateSwapRoute(live,wanted),[]);
 assert.deepEqual(validateSwapRoute(live,{wethUsdcPool:a.toUpperCase().replace('0X','0x'),usdcSpcxcPool:b}),[]);
 // A different tick spacing resolves to another pool; the configured address must still win.
 assert.ok(validateSwapRoute({...live,usdcSpcxc:f},wanted).some(e=>e.includes('differs from factory discovery')));
 assert.ok(validateSwapRoute({...live,wethUsdc:'0x0000000000000000000000000000000000000000'},wanted).some(e=>e.includes('No wethUsdc pool exists')));
 assert.ok(validateSwapRoute({...live,usdcSpcxcLiquidity:0n},wanted).some(e=>e.includes('no active liquidity')));
 assert.ok(validateSwapRoute({...live,usdcSpcxcLiquidity:undefined},wanted).some(e=>e.includes('no active liquidity')));
 assert.ok(validateSwapRoute(live,{wethUsdcPool:a,usdcSpcxcPool:null}).some(e=>e.includes('explicit address')));
 assert.ok(validateSwapRoute(null,wanted).length);
});
