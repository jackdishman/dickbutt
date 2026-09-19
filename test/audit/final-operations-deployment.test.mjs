import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AbstractProvider, Interface, Network, Wallet } from 'ethers';
import { main } from '../../script/deploy-mainnet.mjs';
import { acquireDeploymentLocks, requireSettledDeployer } from '../../operations/deployment-lock.js';

const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const block={number:2000,hash:'0x'+'ab'.repeat(32),timestamp:1_800_000_000};
const abi=new Interface([
  'function decimals() view returns(uint8)', 'function token0() view returns(address)',
  'function token1() view returns(address)', 'function factory() view returns(address)',
  'function getPool(address,address,bool) view returns(address)', 'function isPool(address) view returns(bool)',
  'function getFee(address,bool) view returns(uint256)', 'function isPaused() view returns(bool)',
  'function stable() view returns(bool)', 'function getReserves() view returns(uint256,uint256,uint256)',
  'function balanceOf(address) view returns(uint256)', 'function totalSupply() view returns(uint256)',
]);

// Deliberately cannot broadcast. The incomplete artifact aborts before ContractFactory/signing.
class OfflineDeploymentProvider extends AbstractProvider {
  constructor(config,observe,{output,nonce=0}={}){super(8453,{cacheTimeout:-1});this.config=config;this.observe=observe;this.output=output;this.nonce=nonce;}
  get pollingInterval(){return 4000;}
  set pollingInterval(v){assert.equal(v,4000);}
  async _detectNetwork(){return Network.from(8453);}
  async getBlock(){return block;}
  async getBalance(){this.observe.balanceChecks++;await new Promise(resolve=>setTimeout(resolve,50));return 10n**18n;}
  async getTransactionCount(address,tag){
    assert.ok(fs.existsSync(`${this.output}.deployment-lock`),'nonce verification requires the output lock');
    assert.ok(fs.existsSync(path.join(os.tmpdir(),`dickbutt-deployer-8453-${address.toLowerCase()}.lock`)),'nonce verification requires the signer lock');
    this.observe.nonceChecks++;
    return tag==='pending'?this.nonce:0;
  }
  async _perform(request){
    assert.ok(['getCode','call'].includes(request.method),`NO SIGNING/BROADCAST SUPPORTED: ${request.method}`);
    const c=this.config;
    if(request.method==='getCode')return request.address.toLowerCase()===c.dickbutt.toLowerCase()&&request.blockTag==='0x3e7'?'0x':'0x6000';
    const call=abi.parseTransaction(request.transaction);
    const values={decimals:[request.transaction.to.toLowerCase()===c.spcxc.toLowerCase()?8:18],token0:[c.dickbutt],token1:[c.spcxc],factory:[c.rewardsPool.factory],
      getPool:[c.rewardsPool.pool],isPool:[true],getFee:[30],isPaused:[false],stable:[false],getReserves:[100,100,block.timestamp],balanceOf:[100],totalSupply:[100]};
    assert.ok(values[call.name],call.name);
    return abi.encodeFunctionResult(call.name,values[call.name]);
  }
}

function fixture(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'audit-concurrent-deploy-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const config=JSON.parse(fs.readFileSync(new URL('../../config/base-mainnet.json',import.meta.url)));
  Object.assign(config.deployment,{proposer:addr(9001),floorSetter:addr(9002)});
  Object.assign(config.rewardsPool,{pool:addr(9003),lpOwner:addr(9004)});
  config.calculatorExclusions.required.push(...[addr(9001),addr(9002),addr(9003)].map(address=>({address})));
  const params={dickbuttDeployBlock:1000,holderThresholdRaw:'6900000000000000000000000',payoutThresholdRaw:'1',minPayoutRaw:'1',batchSize:200,chunkSize:2000,curve:'linear',
    maxSwapPerCallWei:'100000000000000',minSwapIntervalSeconds:21600,floorLowerBoundRaw:'1',lockerMinIntervalSeconds:3600,aerodromeMinIntervalSeconds:3600,aerodromeUnlockTime:block.timestamp+86400};
  const configPath=path.join(dir,'config.json'),paramsPath=path.join(dir,'params.json'),out=path.join(dir,'manifest.json');
  fs.writeFileSync(configPath,JSON.stringify(config));fs.writeFileSync(paramsPath,JSON.stringify(params));
  const observe={balanceChecks:0,nonceChecks:0};
  const run=async({wallet=Wallet.createRandom(),output=out,nonce=0}={})=>{
    const provider=new OfflineDeploymentProvider(config,observe,{output,nonce});
    // Wallet is ephemeral, unfunded, never used to sign anything.
    try{return await main(['--execute','--config',configPath,'--params',paramsPath,'--out',output],
      {BASE_RPC_URL:'http://offline.invalid',DEPLOYER_PRIVATE_KEY:wallet.privateKey},
      {providerFactory:()=>provider,buildLoader:()=>({artifacts:{DickbuttRewardsDistributor:{abi:[]}},buildHash:'0x'+'cd'.repeat(32)})});}
    finally{provider.destroy();}
  };
  return {run,observe,out};
}

test('OPS-M-02: simultaneous fresh deployments cannot both enter one output ledger',async t=>{
  const f=fixture(t);
  const results=await Promise.allSettled([f.run(),f.run()]);
  assert.equal(results.every(r=>r.status==='rejected'),true,'offline fixture must stop every run before signing');
  assert.equal(f.observe.balanceChecks,1,'only one process may pass the fresh-ledger boundary; the other must stop on its exclusive lock');
  assert.ok(results.some(r=>/deployment lock exists/.test(r.reason.message)));
  assert.ok(!fs.existsSync(`${f.out}.deployment-lock`),'ordinary failure releases the output lock');
  await assert.rejects(f.run(),/\.partial exists/,'a fresh retry sees preserved progress instead of a stale lock');
});

test('OPS-M-02: the same deployer cannot concurrently target separate output paths',async t=>{
  const f=fixture(t),wallet=Wallet.createRandom(),second=f.out.replace('manifest.json','second.json');
  const results=await Promise.allSettled([f.run({wallet}),f.run({wallet,output:second})]);
  assert.equal(f.observe.balanceChecks,1);
  assert.ok(results.some(r=>/deployment lock exists/.test(r.reason.message)));
  assert.ok(!fs.existsSync(`${second}.deployment-lock`),'failed signer acquisition releases the already-acquired output lock');
  assert.ok(!fs.existsSync(path.join(os.tmpdir(),`dickbutt-deployer-8453-${wallet.address.toLowerCase()}.lock`)));
});

test('OPS-M-02: pending nonce is checked under both locks before creating a fresh ledger',async t=>{
  const f=fixture(t),wallet=Wallet.createRandom();
  await assert.rejects(f.run({wallet,nonce:1}),/deployer has pending transactions/);
  assert.equal(f.observe.nonceChecks,2);
  assert.ok(!fs.existsSync(`${f.out}.partial`),'pending/ambiguous sends must not create a new recovery ledger');
  // After explicit operator/RPC reconciliation, the same output and signer can be retried.
  await assert.rejects(f.run({wallet}),/Cannot read properties/,'inert artifact ends this test before signing');
  assert.ok(fs.existsSync(`${f.out}.partial`));
});

test('OPS-M-02: malformed or unavailable nonce data fails closed',async()=>{
  for(const value of [-1,NaN,undefined,Number.MAX_SAFE_INTEGER+1]) {
    await assert.rejects(requireSettledDeployer({getTransactionCount:async()=>value},addr(99)),/invalid deployer nonce/);
  }
  await assert.rejects(requireSettledDeployer({getTransactionCount:async()=>{throw Error('RPC unavailable');}},addr(99)),/RPC unavailable/);
});

test('OPS-M-02: path aliases share an output lock and release is idempotent',t=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'audit-deploy-alias-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'real'));fs.symlinkSync(path.join(dir,'real'),path.join(dir,'alias'));
  const release=acquireDeploymentLocks(path.join(dir,'real/out.json'),8453,addr(9991));
  try{assert.throws(()=>acquireDeploymentLocks(path.join(dir,'alias/out.json'),8453,addr(9992)),/deployment lock exists/);}
  finally{release();release();}
  const next=acquireDeploymentLocks(path.join(dir,'alias/out.json'),8453,addr(9992));next();
});
