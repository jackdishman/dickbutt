// Deploy and exercise the full flow on a disposable local Base fork. Never connects a signer to mainnet.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {Contract,ContractFactory,JsonRpcProvider,HDNodeWallet,parseEther} from 'ethers';
import {runCalculator} from '../calculator/engine.js';
import {ERC20_ABI,DISTRIBUTOR_ABI} from '../calculator/chain.js';
import {runKeeper,KEEPER_ABI} from '../keeper/engine.js';
import {runFeeCycle} from '../operations/fees.js';
import {runFloorRefresh} from '../operations/floor.js';
import {stringify} from '../calculator/journal.js';
import {resolveRoundLimits} from '../operations/mainnet-deploy.js';

const root=path.resolve(import.meta.dirname??path.dirname(new URL(import.meta.url).pathname),'..');
const rewardPolicy=resolveRoundLimits(JSON.parse(fs.readFileSync(path.join(root,'config/base-mainnet.json'))).roundLimits);
const bin=name=>process.env[name.toUpperCase()+'_BIN']||[path.join(root,'.tools','foundry',name),path.join(os.homedir(),'.foundry','bin',name)].find(p=>fs.existsSync(p))||name;
const keepAlive=process.argv.slice(2).includes('--keep-alive');
const vamm=process.argv.slice(2).includes('--vamm');
if(process.argv.slice(2).some(arg=>!['--keep-alive','--vamm'].includes(arg)))throw Error('Usage: npm run rehearse -- [--keep-alive] [--vamm]');
// Public development mnemonic. These wallets must only be used on the disposable local chain.
const mnemonic='test test test test test test test test test test test junk';
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
const node=spawn(bin('anvil'),['--host','127.0.0.1','--port',String(port),'--chain-id','31337','--mnemonic',mnemonic,'--fork-url',rpc,'--fork-block-number',String(forkBlock),'--prune-history','4096','--silent'],{stdio:['ignore',log,log]});
let provider;
const report={mode:'disposable-local-base-fork',forkBlock,chainId:31337,realDependencies:['Splits PushSplit V2.2 factory, implementation and Warehouse'],mockDependencies:['DICKBUTT/WETH/SPCXc/USDC assets','Clanker locker',vamm?'Aerodrome volatile ERC-20 pool/factory':'Aerodrome NFT manager','legacy module and Safes','swap router'],checks:[],transactions:[]};
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
  // Use actual private-key signing to exercise the wallet path used by the bot CLIs.
  const wallet=index=>HDNodeWallet.fromPhrase(mnemonic,undefined,`m/44'/60'/0'/0/${index}`).connect(provider);
  const signer=wallet(0),owner=await signer.getAddress();
  const alice=await (await provider.getSigner(1)).getAddress(),bob=await (await provider.getSigner(2)).getAddress();
  const belowMinimum=await (await provider.getSigner(9)).getAddress();
  const kc=await (await provider.getSigner(3)).getAddress(),cdb=await (await provider.getSigner(4)).getAddress(),burn='0x000000000000000000000000000000000000dEaD';
  // Signer 0 owns the contracts and refreshes the price floor; signer 5 is the hot keeper.
  // They are deliberately distinct so one compromised host cannot both swap and set the floor.
  const keeperSigner=wallet(5),keeperAddress=await keeperSigner.getAddress();
  // Signer 6 is the proposer bot; signer 7 stands in for the guardian multisig; signer 8 is the ops
  // bot that refreshes the price floor under the executor's narrow floor-setter role.
  const proposerSigner=wallet(6),proposerAddress=await proposerSigner.getAddress();
  const guardianSigner=wallet(7),guardianAddress=await guardianSigner.getAddress();
  const opsSigner=wallet(8),opsAddress=await opsSigner.getAddress();
  async function deploy(file,name,args=[]){
    const artifact=JSON.parse(fs.readFileSync(path.join(root,'out',file,name+'.json')));
    const c=await new ContractFactory(artifact.abi,artifact.bytecode.object,signer).deploy(...args);await c.waitForDeployment();
    const receipt=await c.deploymentTransaction().wait();report.transactions.push({action:`deploy-${name}`,hash:receipt.hash});fs.appendFileSync(path.join(output,'progress.log'),`Deployed ${name}\n`);return c;
  }
  async function send(label,promise){const tx=await promise;const r=await tx.wait();assert.equal(Number(r.status),1,label);report.transactions.push({action:label,hash:r.hash});fs.appendFileSync(path.join(output,'progress.log'),`${label}\n`);return r;}
  const w=await deploy('Support.sol','RewardMock'),d=await deploy('Support.sol','RewardMock'),s=await deploy('RehearsalMocks.sol','RehearsalRewardToken'),u=await deploy('Support.sol','RewardMock');
  const distributor=await deploy('DickbuttRewardsDistributor.sol','DickbuttRewardsDistributor',[s.target,1,owner]);
  await send('configured-review-delay',distributor.setRoundDelay(rewardPolicy.roundDelay));
  await send('configured-round-limits',distributor.setRoundLimits(rewardPolicy.maxRoundBps,rewardPolicy.minRoundInterval));
  report.rewardPolicy=rewardPolicy;
  const router=await deploy('SwapExecutor.t.sol','ExecutorRouterMock',[w.target,s.target]);
  const executor=await deploy('SpcxcSwapExecutor.sol','SpcxcSwapExecutor',[w.target,s.target,router.target,distributor.target,u.target,1,10,1000,0,owner]);
  const feeRouter=await deploy('SplitsFeeRouter.sol','SplitsFeeRouter',['0x8E8eB0cC6AE34A38B67D5Cf91ACa38f60bc3Ecf4',w.target,d.target,kc,burn,cdb,executor.target]);
  const manager=await deploy('Harvesters.t.sol','PositionMock');
  const locker=await deploy('Integration.t.sol','FeeCycleLocker',[manager.target,w.target,d.target,owner]);
  await send('locker-position',manager.mint(locker.target,7));
  const clanker=await deploy('LockerHarvester.sol','LockerHarvester',[locker.target,manager.target,7,feeRouter.target,0,owner]);
  await send('locker-handoff',locker.transferOwnership(clanker.target));
  const time=(await provider.getBlock('latest')).timestamp;
  let aero, vammPool, vammFactory;
  if(vamm){
    vammFactory=await deploy('VammHarvester.t.sol','VammFactoryMock');
    vammPool=await deploy('VammHarvester.t.sol','VammPoolMock',[vammFactory.target,d.target,s.target]);
    await send('vamm-register',vammFactory.configure(vammPool.target,true));
    aero=await deploy('AerodromeVammHarvester.sol','AerodromeVammHarvester',[vammFactory.target,vammPool.target,d.target,s.target,burn,distributor.target,time+365*86400,0,owner]);
    await send('vamm-lp-mint',vammPool.mint(owner,1000));
    await send('vamm-lp-handoff',vammPool.transfer(aero.target,1000));
  }else{
    aero=await deploy('AerodromeFeeHarvester.sol','AerodromeFeeHarvester',[manager.target,8,d.target,s.target,burn,distributor.target,time+365*86400,0,owner]);
    await send('aero-position',manager.mint(owner,8));
    await send('aero-handoff',manager['safeTransferFrom(address,address,uint256)'](owner,aero.target,8));
    await send('aero-fees',manager.configureFees(d.target,s.target));
  }
  async function accrueVammFees(){if(vamm)await send('vamm-fees',vammPool.accrue(aero.target,13,17));}
  await accrueVammFees();
  const module=await deploy('LegacyFees.t.sol','LegacyModuleMock');
  const safes=[await deploy('LegacyFees.t.sol','LegacySafeMock',[module.target]),await deploy('LegacyFees.t.sol','LegacySafeMock',[module.target])];
  const legacy=await deploy('LegacyFeeHarvester.sol','LegacyFeeHarvester',[module.target,safes.map(x=>x.target),d.target,feeRouter.target]);
  await send('legacy-handoff',module.updateTokenCreator(d.target,legacy.target));
  await send('legacy-current-fees',d.mint(safes[0].target,600));await send('legacy-historic-fees',d.mint(safes[1].target,500));
  await send('holder-alice',d.mint(alice,parseEther('6900000')));await send('holder-bob',d.mint(bob,parseEther('13800000')));
  await send('holder-below-minimum',d.mint(belowMinimum,parseEther('6900000')-1n));
  await send('swap-keeper',executor.setKeeper(keeperAddress,true));await send('payout-keeper',distributor.setKeeper(keeperAddress,true));
  // Bound first, then approve: no floor setter is ever live unbounded. The keeper is refused as a setter.
  await send('floor-lower-bound',executor.setFloorLowerBound(10n**18n));await send('floor-setter',executor.setFloorSetter(opsAddress,true));
  await assert.rejects(executor.setFloorSetter(keeperAddress,true),/floor setter cannot be a keeper/);
  await assert.rejects(executor.connect(opsSigner).setKeeper(opsAddress,true));
  await assert.rejects(executor.connect(opsSigner).setPriceFloor(10n**18n-1n,time+3600),/floor below owner bound/);
  await send('proposer',distributor.setProposer(proposerAddress,true));await send('guardian',distributor.setGuardian(guardianAddress));
  const onEvent=e=>{if(e.hash)report.transactions.push(e);};
  // Floor comes from the real ops bot under the floor-setter role, never the owner key. An expired
  // floor is the starting state, so it must refresh and clear the alert.
  const floorArgs={provider,executor:executor.connect(opsSigner),quote:async n=>n*2n,signerAddress:opsAddress,onEvent};
  const floorBefore=await runFloorRefresh({...floorArgs});
  assert.equal(floorBefore.status,'expired');assert.equal(floorBefore.swapsBlocked,true);assert.equal(floorBefore.alert,true);
  const floorSet=await runFloorRefresh({...floorArgs,execute:true});
  assert.equal(floorSet.status,'refreshed');assert.equal(floorSet.alert,false);
  report.transactions.push({action:'price-floor',hash:floorSet.transaction});
  await assert.rejects(runFloorRefresh({...floorArgs,signerAddress:keeperAddress,execute:true}),/not a keeper/);
  await assert.rejects(runFloorRefresh({...floorArgs,signerAddress:alice,execute:true}),/neither an approved floor setter/);
  assert.equal(floorSet.lowerBoundUnset,false);
  const fees=await runFeeCycle({provider,signerAddress:keeperAddress,locker:clanker,aero,legacy,feeRouter,executor:executor.connect(keeperSigner),weth:w,quote:async n=>n*2n,execute:true,onEvent});
  assert.equal(fees.swapStatus,'processed');
  assert.equal(await w.balanceOf(kc),99n);assert.equal(await w.balanceOf(cdb),99n);
  assert.equal(await d.balanceOf(kc),209n);assert.equal(await d.balanceOf(burn),1902n);
  assert.equal(await s.balanceOf(distributor.target),1615n);
  report.checks.push('Three fee sources, actual immutable Splits percentages/dust, swap and rewards-vault funding verified');
  const config={chainId:'31337',token:d.target.toLowerCase(),distributor:distributor.target.toLowerCase(),deployBlock:(await d.deploymentTransaction().wait()).blockNumber,holderThresholdRaw:parseEther('6900000').toString(),payoutThresholdRaw:'1',curve:'linear',excluded:[burn,kc,cdb,owner,keeperAddress,proposerAddress,guardianAddress,opsAddress,feeRouter.target,await feeRouter.dickSplit(),await feeRouter.wethSplit(),manager.target,locker.target,clanker.target,aero.target,legacy.target,executor.target,distributor.target,...safes.map(x=>x.target)].map(x=>x.toLowerCase()).sort(),batchSize:1,chunkSize:2000,finalityTag:'finalized'};
  const dir=path.join(output,'calculator');fs.mkdirSync(dir);fs.writeFileSync(path.join(output,'calculator-config.json'),JSON.stringify(config,null,2));
  // Give holders a complete interval and let the local finalized tag advance. No time travel touches Base.
  await provider.send('evm_increaseTime',[1]);await provider.send('anvil_mine',[128]);
  const calculate=(bootstrap=false)=>runCalculator({dir,provider,token:new Contract(d.target,ERC20_ABI,provider),distributor:new Contract(distributor.target,DISTRIBUTOR_ABI,provider),config,bootstrap});
  // Bootstrap period: balances are committed with a zero pot so round 1 does not weight holders over the
  // token's whole history. The pot is untouched and reappears in the next period.
  const boot=await calculate(true);assert.equal(boot.bootstrap,true);assert.equal(boot.pot,0n);assert.equal(boot.plan,null);
  await provider.send('evm_increaseTime',[6*3600]);await provider.send('anvil_mine',[128]);
  const record=await calculate();assert.ok(record.plan);assert.equal(Object.keys(record.plan.payouts).length,2);
  assert.equal(record.plan.payouts[belowMinimum.toLowerCase()],undefined);
  assert.ok(record.plan.payouts[alice.toLowerCase()],'exactly 6.9M qualifies');
  assert.equal(record.plan.total,'807','half of the 1615 available, untouched by the bootstrap period');
  // Keeper signs batches, owner signs the root: two keys, exercised through the split-signer path.
  // Three keys: keeper signs batches, proposer bot signs the root, guardian signs nothing here.
  const keeperArgs={dir,provider,distributor:new Contract(distributor.target,KEEPER_ABI,keeperSigner),
   ownerDistributor:new Contract(distributor.target,KEEPER_ABI,proposerSigner),ownerAddress:proposerAddress,
   config,execute:true,propose:true,signerAddress:keeperAddress,onEvent};
  const proposerArgs={...keeperArgs,distributor:new Contract(distributor.target,KEEPER_ABI,proposerSigner),
    signerAddress:proposerAddress,proposeOnly:true};
  // The guardian can stop a proposal without the owner key, and nothing is signed while paused.
  await send('guardian-pause',distributor.connect(guardianSigner).pauseProposals(true));
  await assert.rejects(runKeeper(keeperArgs),/paused by the guardian/);
  await send('guardian-unpause',distributor.connect(guardianSigner).pauseProposals(false));
  const first=await runKeeper(proposerArgs);assert.equal(first.rounds[0].status,rewardPolicy.roundDelay===0?'activation-ready':'timelocked');
  assert.ok(first.transactions.every(tx=>tx.action==='propose'),'the proposer never activates or pays');
  await send('simulate-blocked-recipient',s.setBlocked(bob,true));
  if(rewardPolicy.roundDelay>0)await provider.send('evm_increaseTime',[rewardPolicy.roundDelay+1]);
  await provider.send('anvil_mine',[128]);
  const partial=await runKeeper({...keeperArgs,propose:false});assert.equal(partial.rounds[0].status,'partial');
  assert.equal(partial.rounds[0].unpaid.length,1);const alicePaid=await s.balanceOf(alice);assert.ok(alicePaid>0n);
  await send('unblock-recipient',s.setBlocked(bob,false));
  const retry=await runKeeper({...keeperArgs,propose:false});assert.equal(retry.rounds[0].status,'closed');
  assert.equal(await s.balanceOf(alice),alicePaid);assert.equal(await s.balanceOf(bob),BigInt(record.plan.payouts[bob.toLowerCase()]));
  const repeat=await runKeeper({...keeperArgs,propose:false});assert.equal(repeat.transactions.length,0);
  assert.equal(await distributor.totalReserved(),0n);
  await provider.send('anvil_mine',[128]);const reconciliation=await calculate();
  assert.equal(reconciliation.state.plans[record.plan.roundId].settled,true);
  // --- A foreign root lands at our next round id (a stolen proposer key, or an operator working outside
  // the journal). The keeper must keep other rounds moving, never pay the foreign round, and recover once
  // the guardian has cancelled it, with every recipient of the abandoned plan recredited exactly once.
  assert.ok(reconciliation.plan,'the remaining half of the pot is planned as round 2');
  const abandoned=reconciliation.plan;assert.equal(abandoned.roundId,'2');
  await provider.send('evm_increaseTime',[Number(await distributor.minRoundInterval())+1]);await provider.send('anvil_mine',[1]);
  const foreignRoot='0x'+'f0'.repeat(32);
  await send('foreign-proposal',distributor.proposeRound(foreignRoot,1));
  await provider.send('anvil_mine',[128]); // let the local finalized tag see the foreign round
  const blocked=await runKeeper(keeperArgs);
  assert.equal(blocked.rounds.find(r=>r.roundId==='2').status,'foreign-commitment');
  assert.equal(blocked.rounds.find(r=>r.roundId==='1').status,'closed');
  assert.equal(blocked.transactions.length,0,'nothing is signed against a foreign root');
  await assert.rejects(calculate(),/foreign root is pending/);
  await send('guardian-cancel',distributor.connect(guardianSigner).cancelPendingRound(2));
  const cancelled=await runKeeper({...keeperArgs,propose:false});
  assert.equal(cancelled.rounds.find(r=>r.roundId==='2').status,'superseded');
  // The recredited carry is half the pot and so is the cap: lift the cap for the recovery round.
  await send('lift-cap',distributor.setRoundLimits(10000,0));
  await provider.send('anvil_mine',[128]);
  const recovered=await calculate();
  assert.equal(recovered.state.plans['2'].superseded,true);
  assert.equal(Object.values(recovered.recredits).reduce((s,v)=>s+BigInt(v),0n),BigInt(abandoned.total),'abandoned plan recredited exactly once');
  assert.equal(recovered.plan.roundId,'3');
  assert.ok(BigInt(recovered.plan.total)>=BigInt(abandoned.total),'round 3 carries the abandoned payouts forward');
  const reproposed=await runKeeper(proposerArgs);assert.equal(reproposed.rounds.find(r=>r.roundId==='3').status,rewardPolicy.roundDelay===0?'activation-ready':'timelocked');
  await send('restore-cap',distributor.setRoundLimits(5000,0)); // the cap only gates proposals; activation and payment are unaffected
  if(rewardPolicy.roundDelay>0)await provider.send('evm_increaseTime',[rewardPolicy.roundDelay+1]);
  await provider.send('anvil_mine',[128]);
  const aliceBefore=await s.balanceOf(alice),bobBefore=await s.balanceOf(bob);
  const paidOut=await runKeeper({...keeperArgs,propose:false});assert.equal(paidOut.rounds.find(r=>r.roundId==='3').status,'closed');
  assert.equal((await s.balanceOf(alice))-aliceBefore,BigInt(recovered.plan.payouts[alice.toLowerCase()]));
  assert.equal((await s.balanceOf(bob))-bobBefore,BigInt(recovered.plan.payouts[bob.toLowerCase()]));
  assert.equal(await distributor.totalReserved(),0n);
  report.checks.push('Real calculator journal → proposal → configured review delay → partial payout → retry → closure → reconciliation verified','Repeated keeper execution sends no duplicate payments','Separate owner, ops (floor setter), keeper, proposer and guardian signers; floor setter is bounded and refused as keeper; floor bot refuses a keeper key','Guardian pause blocks proposals and the share cap/rate limit bound a bot proposer','Bootstrap period commits balances with a zero pot','A foreign root at a planned round id is reported without halting other rounds, then superseded and recredited exactly once after the guardian cancels it');
  if(rewardPolicy.roundDelay===0){
    await send('restore-normal-round-policy',distributor.setRoundLimits(rewardPolicy.maxRoundBps,rewardPolicy.minRoundInterval));
    report.sixHourCycles=[];
    for(let cycle=0;cycle<2;cycle++){
      await provider.send('evm_increaseTime',[6*3600]);await provider.send('anvil_mine',[128]);
      await runFloorRefresh({...floorArgs,execute:true});
      await accrueVammFees();
      const cycleFees=await runFeeCycle({provider,signerAddress:keeperAddress,locker:clanker,aero,legacy,feeRouter,
        executor:executor.connect(keeperSigner),weth:w,quote:async n=>n*2n,execute:true,onEvent});
      assert.equal(cycleFees.swapStatus,'processed');
      await provider.send('anvil_mine',[128]);
      const cycleRecord=await calculate();assert.ok(cycleRecord.plan);
      const before=new Map(await Promise.all(Object.keys(cycleRecord.plan.payouts).map(async account=>[account,await s.balanceOf(account)])));
      const proposal=await runKeeper(proposerArgs);
      assert.equal(proposal.rounds.find(r=>r.roundId===cycleRecord.plan.roundId).status,'activation-ready');
      assert.ok(proposal.transactions.every(tx=>tx.action==='propose'));
      const [, , readyAt]=await distributor.pending(cycleRecord.plan.roundId);
      const paid=await runKeeper({...keeperArgs,propose:false});
      assert.equal(paid.rounds.find(r=>r.roundId===cycleRecord.plan.roundId).status,'closed');
      for(const[account,amount]of Object.entries(cycleRecord.plan.payouts))assert.equal(await s.balanceOf(account)-before.get(account),BigInt(amount));
      const again=await runKeeper({...keeperArgs,propose:false});assert.equal(again.transactions.length,0);
      const paidAt=(await provider.getBlock('latest')).timestamp;
      assert.ok(BigInt(paidAt)-readyAt<60n,'local payment unexpectedly waited beyond one minute');
      report.sixHourCycles.push({roundId:cycleRecord.plan.roundId,periodStart:cycleRecord.periodStartTs,periodEnd:cycleRecord.periodEndTs,
        earningTimeAdvancedSeconds:6*3600,readyAt:readyAt.toString(),paidAt,recipients:Object.keys(cycleRecord.plan.payouts).length,
        payouts:cycleRecord.plan.payouts,extraReviewSeconds:0,holderSignatures:0});
    }
    report.checks.push('Two further six-hour earning cycles produced ready proposals and keeper payments without review time travel or holder signatures');
  }
  if(vamm){assert.equal(await vammPool.balanceOf(aero.target),1000n);report.checks.push('ERC-20 vAMM LP transfer and repeated claims preserve all LP principal');}
  report.aerodromeKind=vamm?'vamm':'slipstream';
  report.contracts={weth:w.target,dickbutt:d.target,spcxc:s.target,distributor:distributor.target,executor:executor.target,feeRouter:feeRouter.target,dickSplit:await feeRouter.dickSplit(),wethSplit:await feeRouter.wethSplit(),clanker:clanker.target,aero:aero.target,legacy:legacy.target};
  report.wallets=[];
  assert.equal(await s.balanceOf(belowMinimum),0n,'below-threshold holder received rewards');
  report.checks.push('Exactly 6.9M DICKBUTT qualifies; one raw unit below does not; neither holder signs payout transactions');
  for(const [role,address] of Object.entries({owner,keeper:keeperAddress,proposer:proposerAddress,guardian:guardianAddress,ops:opsAddress,holderA:alice,holderB:bob,holderBelowMinimum:belowMinimum,kcGreen:kc,cdbVault:cdb})) {
    report.wallets.push({role,address,ethWei:String(await provider.getBalance(address)),dickbuttRaw:String(await d.balanceOf(address)),spcxcRaw:String(await s.balanceOf(address))});
  }
  report.rpcUrl=`http://127.0.0.1:${port}`;
  report.totalReserved=String(await distributor.totalReserved());
  report.signing='Separate HD wallets; locally signed transactions; public development mnemonic';
  report.localManifest={chainId:31337,network:'local',deployedAtBlock:(await provider.getBlock('latest')).number,
    contracts:report.contracts,splits:{dickSplit:await feeRouter.dickSplit(),wethSplit:await feeRouter.wethSplit()},
    sources:{aerodromeKind:report.aerodromeKind,...(vamm?{rewardsPool:vammPool.target,rewardsFactory:vammFactory.target}:{}),locker:locker.target,positionManager:manager.target,legacySafes:safes.map(x=>x.target)},
    roles:{owner,keeper:keeperAddress,proposer:proposerAddress,guardian:guardianAddress,ops:opsAddress,kcGreen:kc,cdbVault:cdb,burnAddress:burn},
    notes:['Local chain only; mock tokens, fee sources and swap router. Genuine Splits from the Base fork.']};
  report.keeper={first,partial,retry,repeat,blocked,cancelled,reproposed,paidOut};report.success=true;
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,(_,v)=>typeof v==='bigint'?v.toString():v,2));
  console.log(JSON.stringify({success:true,evidence:path.relative(root,output),checks:report.checks},null,2));
  if(keepAlive){
    fs.writeFileSync(path.join(root,'.context','current-local.json'),JSON.stringify({runnerPid:process.pid,rpcUrl:report.rpcUrl,evidence:path.relative(root,output),manifest:report.localManifest,wallets:report.wallets},null,2));
    fs.writeFileSync(path.join(output,'local.env'),[
      `RPC_URL=${report.rpcUrl}`,`KEEPER_PRIVATE_KEY=${keeperSigner.privateKey}`,
      `PROPOSER_PRIVATE_KEY=${proposerSigner.privateKey}`,`OPS_PRIVATE_KEY=${opsSigner.privateKey}`,
      `OWNER_PRIVATE_KEY=${signer.privateKey}`,`GUARDIAN_PRIVATE_KEY=${guardianSigner.privateKey}`,
      `HOLDER_A_PRIVATE_KEY=${wallet(1).privateKey}`,`HOLDER_B_PRIVATE_KEY=${wallet(2).privateKey}`,
    ].join('\n')+'\n',{mode:0o600});
    console.log(JSON.stringify({type:'local-running',rpcUrl:report.rpcUrl,chainId:31337,evidence:path.relative(root,output),note:'Local development wallets only. Stop with Ctrl-C.'}));
    await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);node.once('exit',resolve);});
  }
} catch(error) {
  report.success=false;report.error=error.shortMessage||error.message;
  fs.writeFileSync(path.join(output,'report.json'),stringify(report));
  console.error(`Rehearsal failed: ${report.error}. Evidence: ${path.relative(root,output)}`);process.exitCode=1;
} finally {
  provider?.destroy();node.kill('SIGTERM');fs.closeSync(log);
}
