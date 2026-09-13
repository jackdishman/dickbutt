import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validatePoolFacts, validateDeployment, validateSwapRoute, validateExclusions} from '../preflight.js';
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
 const addresses={kcGreen:a,cdbVault:b,burnAddress:f,owner:'0x0000000000000000000000000000000000000004',keeper:'0x0000000000000000000000000000000000000005',floorSetter:'0x0000000000000000000000000000000000000006',proposer:'0x0000000000000000000000000000000000000007',guardian:'0x0000000000000000000000000000000000000004'};
 assert.deepEqual(validateDeployment(addresses),[]);
 assert.ok(validateDeployment({...addresses,cdbVault:a}).some(e=>e.includes('distinct')));
 assert.ok(validateDeployment({...addresses,owner:'0x0000000000000000000000000000000000000000'}).length);
 assert.ok(validateDeployment({...addresses,floorSetter:addresses.keeper}).some(e=>e.includes('floorSetter must not be the keeper')));
 // An unfilled template reports only the missing addresses; absent values are not duplicates.
 const template={kcGreen:null,cdbVault:null,burnAddress:f,owner:null,keeper:null,floorSetter:null};
 assert.equal(validateDeployment(template).length,7);
 assert.ok(!validateDeployment(template).some(e=>e.includes('distinct')));
});

const productionRoles={kcGreen:a,cdbVault:b,burnAddress:f,owner:'0x0000000000000000000000000000000000000004',keeper:'0x0000000000000000000000000000000000000005',floorSetter:'0x0000000000000000000000000000000000000006',proposer:'0x0000000000000000000000000000000000000007',guardian:'0x0000000000000000000000000000000000000004'};
test('production preflight requires an explicit proposer and guardian',()=>{
 for(const name of ['proposer','guardian']){
  for(const value of [undefined,null,'0x0000000000000000000000000000000000000000']){
   const errors=validateDeployment({...productionRoles,[name]:value});
   assert.ok(errors.some(e=>e.includes(`deployment.${name}`)),`${name}=${value} must not pass`);
  }
 }
 assert.deepEqual(validateDeployment(productionRoles),[],'guardian may share the owner multisig');
});
test('production preflight rejects keeper administrators and treasury recipients that are bot wallets',()=>{
 for(const name of ['owner','proposer','guardian','floorSetter']){
  assert.ok(validateDeployment({...productionRoles,[name]:productionRoles.keeper}).length,`keeper cannot double as ${name}`);
 }
 for(const recipient of ['kcGreen','cdbVault']){
  for(const bot of ['keeper','proposer','floorSetter']){
   assert.ok(validateDeployment({...productionRoles,[recipient]:productionRoles[bot]}).some(e=>e.includes('operational bot key')),`${recipient} cannot be ${bot}`);
  }
 }
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

test('every recorded pipeline address, the locker and its pool must be in the exclusion set',()=>{
 const pool='0x0000000000000000000000000000000000000009',locker='0x0000000000000000000000000000000000000008';
 const config={clankerLocker:locker,clankerPool:pool,rewardsPool:{pool:null},deployment:{kcGreen:a,cdbVault:b,burnAddress:f,keeper:'0x0000000000000000000000000000000000000005',floorSetter:null,owner:null,proposer:null,guardian:null},
  calculatorExclusions:{required:[{address:a},{address:b},{address:f},{address:locker},{address:pool},{address:['0x0000000000000000000000000000000000000005']}]}};
 assert.deepEqual(validateExclusions(config),[]);
 assert.ok(validateExclusions({...config,calculatorExclusions:{required:config.calculatorExclusions.required.filter(e=>e.address!==pool)}}).some(e=>e.includes('clankerPool')&&e.includes('missing')));
 assert.ok(validateExclusions({...config,clankerPool:null}).some(e=>e.includes('must record the DICKBUTT/WETH pool')));
 assert.ok(validateExclusions({...config,deployment:{...config.deployment,floorSetter:'0x0000000000000000000000000000000000000006'}}).some(e=>e.includes('deployment.floorSetter')));
 // The live mainnet configuration passes its own check.
 assert.deepEqual(validateExclusions(JSON.parse(fs.readFileSync(new URL('../../config/base-mainnet.json',import.meta.url)))),[]);
});
