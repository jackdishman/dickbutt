import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertExecutionNetwork } from '../execution-network.js';
import { runFeeCycle } from '../fees.js';
import { runFloorRefresh } from '../floor.js';
import { JOBS } from '../schedule.js';
import { renderSystemd, renderCron, parseScheduleArgs } from '../../script/render-schedule.mjs';
import { parseFeeArgs } from '../../script/run-fees.mjs';
import { parseFloorArgs } from '../../script/run-floor.mjs';
import { parseKeeperArgs } from '../../script/run-keeper.mjs';

const a = i => '0x' + i.toString(16).padStart(40,'0');
function inputs() {
  const contracts = Object.fromEntries(['weth','usdc','dickbutt','spcxc','distributor','executor','feeRouter','clanker','aero','legacy'].map((key,i)=>[key,a(i+1)]));
  const roles = Object.fromEntries(['owner','keeper','proposer','guardian','ops','kcGreen','cdbVault','burnAddress'].map((key,i)=>[key,a(i+20)]));
  const manifest = {chainId:8453,network:'base-mainnet',contracts,roles,quoter:a(50),sources:{aerodromeKind:'vamm',rewardsPool:a(51),rewardsFactory:a(52)}};
  const config = {chainId:'8453',token:contracts.dickbutt,distributor:contracts.distributor,deployBlock:1,holderThresholdRaw:'6900000000000000000000000',payoutThresholdRaw:'1',curve:'linear',excluded:[...Object.values(contracts),...Object.values(roles),a(51)],batchSize:200,chunkSize:1000,finalityTag:'finalized'};
  return {manifest,config};
}
function cycle() {
  const {manifest}=inputs(),sent=[];
  const tx = name => async()=>{sent.push(name);return {hash:name,wait:async()=>({status:1,blockNumber:100})};};
  const at = name => ({getAddress:async()=>manifest.contracts[name]});
  const executor = {...at('executor'),weth:async()=>manifest.contracts.weth,spcxc:async()=>manifest.contracts.spcxc,distributor:async()=>manifest.contracts.distributor,
    owner:async()=>manifest.roles.owner,isKeeper:async address=>address===manifest.roles.keeper,isFloorSetter:async address=>address===manifest.roles.ops,
    priceFloorExpiresAt:async()=>1100n,minSpcxcPerWeth:async()=>19n*10n**17n,lastSwapAt:async()=>0n,minSwapInterval:async()=>0n,
    maxSwapPerCall:async()=>10n**18n,MAX_FLOOR_LIFETIME:async()=>86400n,floorLowerBound:async()=>10n**18n,
    processWeth:tx('swap'),setPriceFloor:tx('floor')};
  const feeRouter={...at('feeRouter'),swapExecutor:async()=>manifest.contracts.executor,weth:async()=>manifest.contracts.weth,dickbutt:async()=>manifest.contracts.dickbutt,
    kcGreen:async()=>manifest.roles.kcGreen,cdbVault:async()=>manifest.roles.cdbVault,burnAddress:async()=>manifest.roles.burnAddress,splitDickbutt:tx('dick'),splitWeth:tx('weth')};
  const locker={...at('clanker'),destination:async()=>manifest.contracts.feeRouter,ownsLocker:async()=>true,lastHarvestAt:async()=>0n,minInterval:async()=>0n,harvest:tx('locker')};
  const aero={...at('aero'),pool:async()=>manifest.sources.rewardsPool,factory:async()=>manifest.sources.rewardsFactory,dickbutt:async()=>manifest.contracts.dickbutt,spcxc:async()=>manifest.contracts.spcxc,spcxcDestination:async()=>manifest.contracts.distributor,burnAddress:async()=>manifest.roles.burnAddress,holdsPosition:async()=>true,lastHarvestAt:async()=>0n,minInterval:async()=>0n,harvest:tx('aero')};
  const legacy={...at('legacy'),destination:async()=>manifest.contracts.feeRouter,token:async()=>manifest.contracts.dickbutt,isTokenCreator:async()=>true,safeCount:async()=>2n,harvestFrom:async i=>tx('legacy'+i)()};
  const provider={getNetwork:async()=>({chainId:8453n}),getCode:async()=> '0x6001',getBlock:async()=>({timestamp:1000,number:100})};
  return {sent,args:{provider,executor,feeRouter,locker,aero,legacy,weth:{...at('weth'),balanceOf:async()=>100n},quote:async amount=>amount*2n,execute:true,allowMainnet:true,config:manifest,signerAddress:manifest.roles.keeper}};
}

test('Base execution is disabled by default and opt-in is specific to Base',()=>{
  for(const chainId of [31337n,84532n])assert.doesNotThrow(()=>assertExecutionNetwork({chainId,execute:true}));
  assert.throws(()=>assertExecutionNetwork({chainId:8453n,execute:true}),/disabled/);
  assert.doesNotThrow(()=>assertExecutionNetwork({chainId:8453n}));
  for(const chainId of [1n,10n,999n])assert.throws(()=>assertExecutionNetwork({chainId,execute:true,allowMainnet:true}),/unsupported chain/);
  assert.throws(()=>assertExecutionNetwork({chainId:31337n,execute:true,allowMainnet:true}),/only on Base/);
  assert.throws(()=>assertExecutionNetwork({chainId:8453n,execute:true,allowMainnet:'true'}),/booleans/);
  assert.throws(()=>assertExecutionNetwork({chainId:8453n,execute:true,allowMainnet:true}),/matching reviewed/);
});

test('Base configuration rejects wrong chains, unsafe finality, missing identities, roles and exclusions',()=>{
  const {manifest,config}=inputs();
  const check=(c,configKind='manifest')=>assertExecutionNetwork({chainId:8453n,execute:true,allowMainnet:true,config:c,configKind});
  check(manifest);check(config,'calculator');
  for(const c of [{...manifest,chainId:84532},{...manifest,network:'local'},{...manifest,roles:{}},{...manifest,contracts:{...manifest.contracts,executor:manifest.contracts.feeRouter}}])assert.throws(()=>check(c));
  for(const c of [{...config,finalityTag:'latest'},{...config,deployBlock:0},{...config,batchSize:201},{...config,excluded:[]},{...config,distributor:a(0)},{...config,holderThresholdRaw:'0'}])assert.throws(()=>check(c,'calculator'));
});

test('explicit Base fee library opt-in executes all mock fee sources before split and swap',async()=>{
  const {args,sent}=cycle();const result=await runFeeCycle(args);
  assert.deepEqual(sent,['locker','aero','legacy0','legacy1','dick','weth','swap']);assert.equal(result.swapStatus,'processed');
});

test('Base fee library rejects mismatched objects, missing code, payees and signers before any write',async()=>{
  for(const change of [
    args=>{args.aero.getAddress=async()=>a(99);},
    args=>{args.provider.getCode=async()=> '0x';},
    args=>{args.feeRouter.kcGreen=async()=>a(99);},
    args=>{args.locker.destination=async()=>a(99);},
    args=>{args.signerAddress=a(99);},
    args=>{args.executor.isKeeper=async()=>false;},
    args=>{args.aero.pool=async()=>a(99);},
  ]){const {args,sent}=cycle();change(args);await assert.rejects(runFeeCycle(args));assert.deepEqual(sent,[]);}
});

test('explicit Base floor library opt-in requires the separate manifest floor setter and matching executor',async()=>{
  const {args,sent}=cycle();args.signerAddress=args.config.roles.ops;
  const result=await runFloorRefresh(args);assert.equal(result.status,'refreshed');assert.deepEqual(sent,['floor']);
  for(const change of [args=>{args.signerAddress=args.config.roles.keeper;},args=>{args.executor.distributor=async()=>a(99);},args=>{args.executor.owner=async()=>a(99);}]){
    const {args,sent}=cycle();args.signerAddress=args.config.roles.ops;change(args);await assert.rejects(runFloorRefresh(args));assert.deepEqual(sent,[]);
  }
});

test('explicit mainnet dry runs validate identity and never send mock transactions',async()=>{
  const {args,sent}=cycle();args.execute=false;
  await runFeeCycle(args);await runFloorRefresh({...args,signerAddress:args.config.roles.ops});assert.deepEqual(sent,[]);
});

test('mainnet schedule validates both files and attaches flags only to transaction commands',()=>{
  const {manifest,config}=inputs(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'mainnet-schedule-'));
  try {
    fs.writeFileSync(path.join(dir,'m.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(dir,'c.json'),JSON.stringify(config));
    const o={workdir:dir,manifest:'m.json',calculator:'c.json',journal:'data'};
    assert.ok(!renderSystemd(JOBS,o).includes('--allow-mainnet'));
    const active={...o,allowMainnet:true};
    const rendered=renderSystemd(JOBS,active),cron=renderCron(JOBS,active);
    assert.equal(rendered.match(/--allow-mainnet/g).length,5);assert.equal(cron.match(/--allow-mainnet/g).length,5);
    assert.ok(!renderSystemd(JOBS.filter(j=>j.name==='monitor'),active).includes('--allow-mainnet'));
    assert.ok(rendered.includes('--execute --propose-only --allow-mainnet'));
    assert.equal(parseScheduleArgs(['--allow-mainnet','--workdir',dir,'--manifest','m.json','--calculator','c.json']).allowMainnet,true);
    fs.writeFileSync(path.join(dir,'c.json'),JSON.stringify({...config,distributor:a(98),excluded:[...config.excluded,a(98)]}));
    assert.throws(()=>renderSystemd(JOBS,active),/identity mismatch/);
    fs.writeFileSync(path.join(dir,'c.json'),JSON.stringify({...config,excluded:[config.distributor]}));
    assert.throws(()=>renderCron(JOBS,active),/exclusions omit/);
    fs.unlinkSync(path.join(dir,'m.json'));assert.throws(()=>renderSystemd(JOBS,active),/readable reviewed manifest/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('fee, floor and keeper CLI mainnet flags are explicit and do not imply execution',()=>{
  const fee=parseFeeArgs(['--config','m.json','--allow-mainnet']);assert.equal(fee.allowMainnet,true);assert.equal(fee.execute,false);
  assert.equal(parseFeeArgs(['--config','m.json']).allowMainnet,false);
  assert.throws(()=>parseFeeArgs(['--config','--execute']),/missing value/);
  assert.throws(()=>parseFeeArgs(['--config','m.json','--unknown']),/unknown fee option/);
  const floor=parseFloorArgs(['--config','m.json','--allow-mainnet']);assert.equal(floor.allowMainnet,true);assert.equal(floor.execute,false);
  const keeper=parseKeeperArgs(['--config','c.json','--journal','data','--allow-mainnet']);assert.equal(keeper.allowMainnet,true);assert.equal(keeper.execute,false);
  assert.equal(parseFloorArgs(['--config','m.json']).allowMainnet,false);
  assert.equal(parseKeeperArgs(['--config','c.json','--journal','data']).allowMainnet,false);
});
