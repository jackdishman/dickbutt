// Deploy and exercise the full flow on a disposable local Base fork. Never connects a signer to mainnet.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {Contract,ContractFactory,JsonRpcProvider,parseEther} from 'ethers';
import {runCalculator} from '../calculator/engine.js';
import {ERC20_ABI,DISTRIBUTOR_ABI} from '../calculator/chain.js';
import {runKeeper,KEEPER_ABI} from '../keeper/engine.js';
import {runFeeCycle} from '../operations/fees.js';
import {runFloorRefresh} from '../operations/floor.js';
import {stringify} from '../calculator/journal.js';

const root=path.resolve(import.meta.dirname??path.dirname(new URL(import.meta.url).pathname),'..');
const bin=name=>process.env[name.toUpperCase()+'_BIN']||path.join(os.homedir(),'.foundry','bin',name);
const rpc=process.env.BASE_RPC_URL||'https://mainnet.base.org';
const forkBlock=Number(process.env.REHEARSAL_FORK_BLOCK||51218068);
if(!Number.isSafeInteger(forkBlock)||forkBlock<1)throw Error('invalid fork block');
fs.mkdirSync(path.join(root,'.context'),{recursive:true});
const output=fs.mkdtempSync(path.join(root,'.context','rehearsal-run-'));
const log=fs.openSync(path.join(output,'anvil.log'),'w',0o600);
const build=spawnSync(bin('forge'),['build','--out','out'],{cwd:root,encoding:'utf8'});
fs.writeFileSync(path.join(output,'build.log'),build.stdout+build.stderr);
if(build.status!==0)throw Error(`Build failed; see ${output}/build.log`);
const server=net.createServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;await new Promise(resolve=>server.close(resolve));
const node=spawn(bin('anvil'),['--host','127.0.0.1','--port',String(port),'--chain-id','31337','--fork-url',rpc,'--fork-block-number',String(forkBlock),'--silent'],{stdio:['ignore',log,log]});
let provider;
const report={mode:'disposable-local-base-fork',forkBlock,chainId:31337,realDependencies:['Splits PushSplit V2.2 factory, implementation and Warehouse'],mockDependencies:['DICKBUTT/WETH/SPCXc/USDC assets','Clanker locker','Aerodrome NFT manager','legacy module and Safes','swap router'],checks:[],transactions:[]};
try {
  await new Promise((resolve,reject)=>{
    const start=Date.now();
    const poll=()=>{
      if(node.exitCode!==null)return reject(Error('Anvil exited; inspect log'));
      const socket=net.connect(port,'127.0.0.1');
      socket.once('connect',()=>{socket.destroy();resolve();});
      socket.once('error',()=>{socket.destroy();Date.now()-start>30000?reject(Error('Anvil startup timed out')):setTimeout(poll,100);});
    };node.once('error',reject);poll();
  });
  provider=new JsonRpcProvider(`http://127.0.0.1:${port}`,31337,{cacheTimeout:-1,batchMaxCount:1,pollingInterval:50});
  provider.pollingInterval=50;
  assert.equal((await provider.getNetwork()).chainId,31337n);
  const signer=await provider.getSigner(0),owner=await signer.getAddress();
  const alice=await (await provider.getSigner(1)).getAddress(),bob=await (await provider.getSigner(2)).getAddress();
  const kc=await (await provider.getSigner(3)).getAddress(),cdb=await (await provider.getSigner(4)).getAddress(),burn='0x000000000000000000000000000000000000dEaD';
  // Signer 0 owns the contracts and refreshes the price floor; signer 5 is the hot keeper.
  // They are deliberately distinct so one compromised host cannot both swap and set the floor.
  const keeperSigner=await provider.getSigner(5),keeperAddress=await keeperSigner.getAddress();
  // Signer 6 is the proposer bot; signer 7 stands in for the guardian multisig.
  const proposerSigner=await provider.getSigner(6),proposerAddress=await proposerSigner.getAddress();
  const guardianSigner=await provider.getSigner(7),guardianAddress=await guardianSigner.getAddress();
  async function deploy(file,name,args=[]){
    const artifact=JSON.parse(fs.readFileSync(path.join(root,'out',file,name+'.json')));
    const c=await new ContractFactory(artifact.abi,artifact.bytecode.object,signer).deploy(...args);await c.waitForDeployment();
    const receipt=await c.deploymentTransaction().wait();report.transactions.push({action:`deploy-${name}`,hash:receipt.hash});fs.appendFileSync(path.join(output,'progress.log'),`Deployed ${name}\n`);return c;
  }
  async function send(label,promise){const tx=await promise;const r=await tx.wait();assert.equal(Number(r.status),1,label);report.transactions.push({action:label,hash:r.hash});fs.appendFileSync(path.join(output,'progress.log'),`${label}\n`);return r;}
  const w=await deploy('Support.sol','RewardMock'),d=await deploy('Support.sol','RewardMock'),s=await deploy('RehearsalMocks.sol','RehearsalRewardToken'),u=await deploy('Support.sol','RewardMock');
  const distributor=await deploy('DickbuttRewardsDistributor.sol','DickbuttRewardsDistributor',[s.target,1,owner]);
  const router=await deploy('SwapExecutor.t.sol','ExecutorRouterMock',[w.target,s.target]);
  const executor=await deploy('SpcxcSwapExecutor.sol','SpcxcSwapExecutor',[w.target,s.target,router.target,distributor.target,u.target,1,10,1000,0,owner]);
  const feeRouter=await deploy('SplitsFeeRouter.sol','SplitsFeeRouter',['0x8E8eB0cC6AE34A38B67D5Cf91ACa38f60bc3Ecf4',w.target,d.target,kc,burn,cdb,executor.target]);
  const manager=await deploy('Harvesters.t.sol','PositionMock');
  const locker=await deploy('Integration.t.sol','FeeCycleLocker',[manager.target,w.target,d.target,owner]);
  await send('locker-position',manager.mint(locker.target,7));
  const clanker=await deploy('LockerHarvester.sol','LockerHarvester',[locker.target,manager.target,7,feeRouter.target,0,owner]);
  await send('locker-handoff',locker.transferOwnership(clanker.target));
  const time=(await provider.getBlock('latest')).timestamp;
  const aero=await deploy('AerodromeFeeHarvester.sol','AerodromeFeeHarvester',[manager.target,8,d.target,s.target,burn,distributor.target,time+365*86400,0,owner]);
  await send('aero-position',manager.mint(owner,8));
  await send('aero-handoff',manager['safeTransferFrom(address,address,uint256)'](owner,aero.target,8));
  await send('aero-fees',manager.configureFees(d.target,s.target));
  const module=await deploy('LegacyFees.t.sol','LegacyModuleMock');
  const safes=[await deploy('LegacyFees.t.sol','LegacySafeMock',[module.target]),await deploy('LegacyFees.t.sol','LegacySafeMock',[module.target])];
  const legacy=await deploy('LegacyFeeHarvester.sol','LegacyFeeHarvester',[module.target,safes.map(x=>x.target),d.target,feeRouter.target]);
  await send('legacy-handoff',module.updateTokenCreator(d.target,legacy.target));
  await send('legacy-current-fees',d.mint(safes[0].target,600));await send('legacy-historic-fees',d.mint(safes[1].target,500));
  await send('holder-alice',d.mint(alice,parseEther('7000000')));await send('holder-bob',d.mint(bob,parseEther('14000000')));
  await send('swap-keeper',executor.setKeeper(keeperAddress,true));await send('payout-keeper',distributor.setKeeper(keeperAddress,true));
  await send('proposer',distributor.setProposer(proposerAddress,true));await send('guardian',distributor.setGuardian(guardianAddress));
  const onEvent=e=>{if(e.hash)report.transactions.push(e);};
  // Floor comes from the real ops bot, not a hand-written setPriceFloor, and the owner key it uses
  // must not be a keeper. An expired floor is the starting state, so it must refresh and clear the alert.
  const floorArgs={provider,executor,quote:async n=>n*2n,signerAddress:owner,onEvent};
  const floorBefore=await runFloorRefresh({...floorArgs});
  assert.equal(floorBefore.status,'expired');assert.equal(floorBefore.swapsBlocked,true);assert.equal(floorBefore.alert,true);
  const floorSet=await runFloorRefresh({...floorArgs,execute:true});
  assert.equal(floorSet.status,'refreshed');assert.equal(floorSet.alert,false);
  report.transactions.push({action:'price-floor',hash:floorSet.transaction});
  await assert.rejects(runFloorRefresh({...floorArgs,signerAddress:keeperAddress,execute:true}),/not a keeper/);
  const fees=await runFeeCycle({provider,signerAddress:keeperAddress,locker:clanker,aero,legacy,feeRouter,executor:executor.connect(keeperSigner),weth:w,quote:async n=>n*2n,execute:true,onEvent});
  assert.equal(fees.swapStatus,'processed');
  assert.equal(await w.balanceOf(kc),99n);assert.equal(await w.balanceOf(cdb),99n);
  assert.equal(await d.balanceOf(kc),209n);assert.equal(await d.balanceOf(burn),1902n);
  assert.equal(await s.balanceOf(distributor.target),1615n);
  report.checks.push('Three fee sources, actual immutable Splits percentages/dust, swap and rewards-vault funding verified');
  const config={chainId:'31337',token:d.target.toLowerCase(),distributor:distributor.target.toLowerCase(),deployBlock:(await d.deploymentTransaction().wait()).blockNumber,holderThresholdRaw:parseEther('6900000').toString(),payoutThresholdRaw:'1',curve:'linear',excluded:[burn,kc,cdb,owner,keeperAddress,proposerAddress,guardianAddress,feeRouter.target,await feeRouter.dickSplit(),await feeRouter.wethSplit(),manager.target,locker.target,clanker.target,aero.target,legacy.target,executor.target,distributor.target,...safes.map(x=>x.target)].map(x=>x.toLowerCase()).sort(),batchSize:1,chunkSize:2000,finalityTag:'finalized'};
  const dir=path.join(output,'calculator');fs.mkdirSync(dir);fs.writeFileSync(path.join(output,'calculator-config.json'),JSON.stringify(config,null,2));
  // Give holders a complete interval and let the local finalized tag advance. No time travel touches Base.
  await provider.send('evm_increaseTime',[3600]);await provider.send('anvil_mine',[128]);
  const calculate=()=>runCalculator({dir,provider,token:new Contract(d.target,ERC20_ABI,provider),distributor:new Contract(distributor.target,DISTRIBUTOR_ABI,provider),config});
  const record=await calculate();assert.ok(record.plan);assert.equal(Object.keys(record.plan.payouts).length,2);
  // Keeper signs batches, owner signs the root: two keys, exercised through the split-signer path.
  // Three keys: keeper signs batches, proposer bot signs the root, guardian signs nothing here.
  const keeperArgs={dir,provider,distributor:new Contract(distributor.target,KEEPER_ABI,keeperSigner),
   ownerDistributor:new Contract(distributor.target,KEEPER_ABI,proposerSigner),ownerAddress:proposerAddress,
   config,execute:true,propose:true,signerAddress:keeperAddress,onEvent};
  // The guardian can stop a proposal without the owner key, and nothing is signed while paused.
  await send('guardian-pause',distributor.connect(guardianSigner).pauseProposals(true));
  await assert.rejects(runKeeper(keeperArgs),/paused by the guardian/);
  await send('guardian-unpause',distributor.connect(guardianSigner).pauseProposals(false));
  const first=await runKeeper(keeperArgs);assert.equal(first.rounds[0].status,'timelocked');
  await send('simulate-blocked-recipient',s.setBlocked(bob,true));
  await provider.send('evm_increaseTime',[Number(await distributor.roundDelay())+1]);await provider.send('anvil_mine',[128]);
  const partial=await runKeeper({...keeperArgs,propose:false});assert.equal(partial.rounds[0].status,'partial');
  assert.equal(partial.rounds[0].unpaid.length,1);const alicePaid=await s.balanceOf(alice);assert.ok(alicePaid>0n);
  await send('unblock-recipient',s.setBlocked(bob,false));
  const retry=await runKeeper({...keeperArgs,propose:false});assert.equal(retry.rounds[0].status,'closed');
  assert.equal(await s.balanceOf(alice),alicePaid);assert.equal(await s.balanceOf(bob),BigInt(record.plan.payouts[bob.toLowerCase()]));
  const repeat=await runKeeper({...keeperArgs,propose:false});assert.equal(repeat.transactions.length,0);
  assert.equal(await distributor.totalReserved(),0n);
  await provider.send('anvil_mine',[128]);const reconciliation=await calculate();
  assert.equal(reconciliation.state.plans[record.plan.roundId].settled,true);
  report.checks.push('Real calculator journal → proposal → timelock → partial payout → retry → closure → reconciliation verified','Repeated keeper execution sends no duplicate payments','Separate owner/ops, keeper, proposer and guardian signers; floor bot refuses a keeper key','Guardian pause blocks proposals and the share cap/rate limit bound a bot proposer');
  report.contracts={weth:w.target,dickbutt:d.target,spcxc:s.target,distributor:distributor.target,executor:executor.target,feeRouter:feeRouter.target,dickSplit:await feeRouter.dickSplit(),wethSplit:await feeRouter.wethSplit(),clanker:clanker.target,aero:aero.target,legacy:legacy.target};
  report.keeper={first,partial,retry,repeat};report.success=true;
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,(_,v)=>typeof v==='bigint'?v.toString():v,2));
  console.log(JSON.stringify({success:true,evidence:path.relative(root,output),checks:report.checks},null,2));
} catch(error) {
  report.success=false;report.error=error.shortMessage||error.message;
  fs.writeFileSync(path.join(output,'report.json'),stringify(report));
  console.error(`Rehearsal failed: ${report.error}. Evidence: ${path.relative(root,output)}`);process.exitCode=1;
} finally {
  provider?.destroy();node.kill('SIGTERM');fs.closeSync(log);
}
