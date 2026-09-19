import test from 'node:test';
import assert from 'node:assert/strict';
import {aerodromeHarvesterName, validateRewardPoolConfig, verifyAerodromeRuntime} from '../aerodrome.js';
import {validatePoolFacts} from '../preflight.js';
import {buildManifest} from '../deployment.js';
const a=n=>'0x'+String(n).padStart(40,'0');
const desired={kind:'vamm',tokens:[a(1),a(2)],factory:a(3),pool:a(4),lpOwner:a(5),stable:false,staking:'unstaked',swapFeeBps:30};
const facts={token0:a(1),token1:a(2),factory:a(3),discoveredPool:a(4),registered:true,paused:false,stable:false,feeBps:30n,reserve0:100n,reserve1:200n,totalSupply:100n,lpOwner:a(5),lpBalance:10n};

test('vAMM preflight refuses the wrong pair, factory, pool, staking or fee economics',()=>{
  assert.deepEqual(validateRewardPoolConfig(desired),[]);
  assert.deepEqual(validatePoolFacts(facts,desired),[]);
  assert.deepEqual(validatePoolFacts({...facts,token0:a(2),token1:a(1)},desired),[]);
  for(const patch of [{token1:a(6)},{factory:a(6)},{registered:false},{discoveredPool:a(6)},{paused:true},
    {stable:true},{feeBps:100n},{reserve0:0n},{reserve1:0n},{totalSupply:0n},{lpBalance:0n},{lpOwner:a(6)}]) {
    assert.ok(validatePoolFacts({...facts,...patch},desired).length,JSON.stringify(patch,(_k,v)=>typeof v==='bigint'?String(v):v));
  }
  assert.ok(validatePoolFacts(null,desired).length);
});

test('manifest selects the correct runtime ABI and preserves old NFT rehearsals explicitly',()=>{
  const contracts=Object.fromEntries(['weth','usdc','dickbutt','spcxc','distributor','executor','feeRouter','clanker','aero','legacy'].map((k,i)=>[k,a(i+10)]));
  const manifest=buildManifest({chainId:31337,quoter:a(30),contracts:{...contracts,aerodromeKind:'vamm',rewardsPool:a(4),rewardsFactory:a(3)},roles:{}});
  assert.equal(aerodromeHarvesterName({kind:manifest.sources.aerodromeKind}),'AerodromeVammHarvester');
  assert.equal(manifest.sources.rewardsPool,a(4)); assert.equal(manifest.sources.rewardsFactory,a(3));
  assert.equal(aerodromeHarvesterName({}),'AerodromeFeeHarvester');
  assert.throws(()=>aerodromeHarvesterName({kind:'typo'}),/unsupported/);
});

test('fee runtime refuses substituted pools, tokens or destinations before any writes',async()=>{
  const getters={pool:a(4),factory:a(3),dickbutt:a(1),spcxc:a(2),spcxcDestination:a(6),burnAddress:a(7)};
  const deployed=Object.fromEntries(Object.entries(getters).map(([key,value])=>[key,async()=>value]));
  const manifest={sources:{aerodromeKind:'vamm',rewardsPool:a(4),rewardsFactory:a(3)},contracts:{dickbutt:a(1),spcxc:a(2),distributor:a(6)},roles:{burnAddress:a(7)}};
  await verifyAerodromeRuntime(deployed,manifest);
  for(const key of Object.keys(getters)) await assert.rejects(verifyAerodromeRuntime({...deployed,[key]:async()=>a(99)},manifest),new RegExp(key+' differs'));
  await assert.rejects(verifyAerodromeRuntime(deployed,{...manifest,roles:{}}),/must record burnAddress/);
  await verifyAerodromeRuntime({}, {sources:{aerodromeKind:'slipstream'}});
});
