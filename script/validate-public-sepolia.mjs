// Signed public testnet validation. Never calls time-travel, impersonation, or balance override RPCs.
// Child CLIs receive only the private key for their individual role. This is one test host, not
// evidence of production host isolation. Progress and receipts contain public information only.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { runCalculator } from '../calculator/engine.js';
import { ERC20_ABI, DISTRIBUTOR_ABI } from '../calculator/chain.js';
import { Journal, stringify } from '../calculator/journal.js';
import {createRpcProvider} from '../operations/provider.js';

const manifestPath='config/deployment-sepolia-new.json';
const configPath='config/deployment-sepolia-new-calculator.json';
const dir=path.resolve('.context/public-sepolia');
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'runner.json'),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
const statePath=path.join(dir,'validation.json');
const state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath)): {chainId:84532,startedAt:new Date().toISOString(),transactions:[],checks:[]};
const save=()=>fs.writeFileSync(statePath,stringify(state)+'\n');
const event=x=>console.log(stringify({at:new Date().toISOString(),...x}));
const env=dotenv.parse(fs.readFileSync('../.env'));
env.RPC_URL=process.env.RPC_URL??env.RPC_URL;
const request=new ethers.FetchRequest(env.RPC_URL);request.timeout=30000;
const p=createRpcProvider(request,undefined,{batchMaxCount:1,cacheTimeout:-1});
p.pollingInterval=2000;
const pause=()=>new Promise(resolve=>setTimeout(resolve,30000));
const owner=new ethers.Wallet(env.DEPLOYER_PRIVATE_KEY,p);
const holderA='0x64AE6c377648394431F9CC04c05060e0B99a6Ca1';
const holderB='0x6a137AA8D1E8D7ca5D265b9133642b681A6f617a';
const holderC='0x865c288785C3Be0F3514457B8F3c4C248653A3db';
const stranger=new ethers.VoidSigner('0x564Afe0Edb11cc064a76D635Cd448d5f7827913A',p);
const artifact=(name,source=name)=>JSON.parse(fs.readFileSync(`out/${source}.sol/${name}.json`));
const at=(name,address,signer=owner,source=name)=>new ethers.Contract(address,artifact(name,source).abi,signer);
async function send(label,submit){
 let entry=state.transactions.find(t=>t.label===label);
 if(!entry){const tx=await submit();entry={label,hash:tx.hash};state.transactions.push(entry);save();event({type:'submitted',...entry});}
 const receipt=await p.waitForTransaction(entry.hash,1,120000);
 assert(receipt && receipt.status===1,`${label}: failed or unresolved receipt`);
 Object.assign(entry,{blockNumber:receipt.blockNumber,status:receipt.status,from:receipt.from,to:receipt.to});save();
 return receipt;
}
async function cli(label,args,role,accepted=[0]){
 const childEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(PRIVATE_KEY|MNEMONIC|RPC_URL|DOTENV_CONFIG_PATH)/.test(k)));
 childEnv.RPC_URL=env.RPC_URL;childEnv.DOTENV_CONFIG_PATH='/dev/null';
 if(role)childEnv[role]=env[role];
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,args,{env:childEnv,stdio:['ignore','pipe','pipe']});let out='',err='';
  child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);
  child.on('exit',code=>resolve({code,out,err}));
 });
 // Child CLIs sanitize RPC/signing errors. Do not persist any secret if an unexpected error includes it.
 for(const secret of Object.values(env).filter(v=>v.length>20)) {result.out=result.out.split(secret).join('[redacted]');result.err=result.err.split(secret).join('[redacted]');}
 fs.writeFileSync(path.join(dir,`${label}.log`),result.out+result.err);
 event({type:'cli',label,exitCode:result.code});
 assert(accepted.includes(result.code),`${label} exited ${result.code}; inspect ${label}.log`);
 return result;
}
async function rejected(label,call){
 let error;try{await call();}catch(e){error=e;}
 assert(error?.code==='CALL_EXCEPTION',`${label}: expected a contract revert, received ${error?.code??'success'}`);
 state.checks.push({label,passed:true,kind:'eth_call',reason:error.reason??error.shortMessage});save();
}
try {
 assert.equal((await p.getNetwork()).chainId,84532n);
 while(!fs.existsSync(manifestPath)){event({type:'waiting-for-deployment'});await pause();}
 const m=JSON.parse(fs.readFileSync(manifestPath)),c=m.contracts,config=JSON.parse(fs.readFileSync(configPath));
 assert.equal(m.chainId,84532);assert.equal(owner.address.toLowerCase(),m.roles.owner.toLowerCase());
 state.manifest=manifestPath;state.holders={holderA,holderB,holderC};save();
 const d=at('DickbuttRewardsDistributor',c.distributor),s=at('SepoliaToken',c.spcxc,owner,'SepoliaSupport');
 const dick=at('SepoliaToken',c.dickbutt,owner,'SepoliaSupport'),weth=at('SepoliaToken',c.weth,owner,'SepoliaSupport');
 const x=at('SpcxcSwapExecutor',c.executor);
 const balances=async(blockTag)=>{blockTag??=await p.getBlockNumber();return Object.fromEntries(await Promise.all(Object.entries({kc:m.roles.kcGreen,cdb:m.roles.cdbVault,burn:m.roles.burnAddress,executor:c.executor,distributor:c.distributor,holderA,holderB,holderC,dickSplit:m.splits.dickSplit,wethSplit:m.splits.wethSplit}).map(async([name,a])=>[name,{address:a,dick:String(await dick.balanceOf(a,{blockTag})),weth:String(await weth.balanceOf(a,{blockTag})),spcxc:String(await s.balanceOf(a,{blockTag}))}])));};
 if(!state.setup){
  await send('testnet-one-hour-delay',()=>d.setRoundDelay(3600));
  await send('mint-holder-a',()=>dick.mint(holderA,ethers.parseEther('7000000')));
  await send('mint-holder-b',()=>dick.mint(holderB,ethers.parseEther('14000000')));
  const lastMint=await send('mint-ineligible-holder-c',()=>dick.mint(holderC,ethers.parseEther('6800000')));
  await send('guardian-pause',()=>d.pauseProposals(true));assert.equal(await d.proposalsPaused(),true);
  await send('guardian-unpause',()=>d.pauseProposals(false));
  await rejected('stranger-cannot-propose',()=>d.connect(stranger).proposeRound.staticCall(ethers.id('invalid'),1));
  await rejected('keeper-cannot-set-floor',()=>x.connect(new ethers.VoidSigner(m.roles.keeper,p)).setPriceFloor.staticCall(100000000,Math.floor(Date.now()/1000)+3600));
  await rejected('ops-cannot-add-keeper',()=>d.connect(new ethers.VoidSigner(m.roles.ops,p)).setKeeper.staticCall(stranger.address,true));
  await rejected('stranger-cannot-change-blocked-recipients',()=>s.connect(stranger).setBlocked.staticCall(holderB,true));
  state.initialBalances=await balances();state.mintBlock=lastMint.blockNumber;state.setup=true;save();
 }
 if(!state.fees){
  if(!state.afterFees){
   await cli('floor-expired',['script/run-floor.mjs','--config',manifestPath,'--monitor'],null,[2]);
   await cli('floor-refresh',['script/run-floor.mjs','--config',manifestPath,'--execute'],'OPS_PRIVATE_KEY');
   await cli('fees-first-cycle',['script/run-fees.mjs','--config',manifestPath,'--execute'],'KEEPER_PRIVATE_KEY');
  }else if(BigInt(state.afterFees.executor.weth)>0n){
   // Resume the observed first-cycle missed swap without collecting another set of mock fees.
   const amount=BigInt(state.afterFees.executor.weth),keeper=new ethers.Wallet(env.KEEPER_PRIVATE_KEY,p);
   const q=new ethers.Contract(m.quoter,['function quoteExactInput(bytes,uint256) returns(uint256,uint160[],uint32[],uint256)'],p);
   const quote=(await q.quoteExactInput.staticCall(await x.swapPath(),amount))[0];
   await send('complete-first-cycle-swap',()=>x.connect(keeper).processWeth(quote*99n/100n,Math.floor(Date.now()/1000)+120));
  }
  const lastReceipt=state.transactions.find(t=>t.label==='complete-first-cycle-swap');
  if(lastReceipt)while(await p.getBlockNumber()<lastReceipt.blockNumber){await pause();}
  const b=await balances(lastReceipt?.blockNumber??await p.getBlockNumber());state.afterFees=b;save();
  const before=state.initialBalances,delta=(who,token)=>BigInt(b[who][token])-BigInt(before[who][token]);
  const rawD=ethers.parseEther('2100'),rawW=ethers.parseEther('0.01');
  assert.equal(delta('kc','dick'),(rawD-1n)/10n);
  assert.equal(delta('burn','dick'),(rawD-1n)*9n/10n+ethers.parseEther('5'));
  assert.equal(delta('kc','weth'),(rawW-1n)/10n);assert.equal(delta('cdb','weth'),(rawW-1n)/10n);
  const swapped=(rawW-1n)*8n/10n;
  assert.equal(delta('distributor','spcxc'),100000000n+swapped*200000000n/10n**18n);
  assert.equal(BigInt(b.executor.weth),0n);
  assert.equal(await weth.allowance(c.executor,await x.router()),0n);
  for(const safe of m.sources.legacySafes)assert.equal(await dick.balanceOf(safe),0n);
  state.checks.push({label:'all-first-cycle-fees-and-recipient-deltas-conserved',passed:true});
  state.fees=true;save();
 }
 if(!state.secondFees){
  state.beforeSecondFees??=await balances();save();
  let result=state.secondFeeResult;
  if(!result){
   const output=await cli('fees-second-cycle',['script/run-fees.mjs','--config',manifestPath,'--execute'],'KEEPER_PRIVATE_KEY');
   result=output.out.trim().split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).at(-1);
   state.secondFeeResult=result;save();
  }
  assert.equal(result.swapStatus,'processed');
  const receipts=await Promise.all(result.actions.filter(a=>a.hash).map(a=>p.getTransactionReceipt(a.hash)));
  assert(receipts.every(r=>r?.status===1));
  const blockTag=Math.max(...receipts.map(r=>r.blockNumber));
  const b=await balances(blockTag),before=state.beforeSecondFees,delta=(who,token)=>BigInt(b[who][token])-BigInt(before[who][token]);
  const dAvailable=ethers.parseEther('1000')+BigInt(before.dickSplit.dick)-1n;
  const wAvailable=ethers.parseEther('0.01')+BigInt(before.wethSplit.weth)-1n;
  assert.equal(delta('kc','dick'),dAvailable/10n);assert.equal(delta('burn','dick'),dAvailable*9n/10n+ethers.parseEther('5'));
  assert.equal(delta('kc','weth'),wAvailable/10n);assert.equal(delta('cdb','weth'),wAvailable/10n);
  assert.equal(delta('distributor','spcxc'),100000000n+(wAvailable*8n/10n)*200000000n/10n**18n);
  assert.equal(BigInt(b.executor.weth),0n);
  state.afterSecondFees=b;state.secondFees=true;state.checks.push({label:'second-public-fee-cycle-with-receipt-block-fix',passed:true});save();
 }
 const token=new ethers.Contract(c.dickbutt,ERC20_ABI,p),distributor=new ethers.Contract(c.distributor,DISTRIBUTOR_ABI,p);
 const journalDir=path.join(dir,'journal');
 while(!state.proposed){
  const finalized=await p.getBlock('finalized');
  if(finalized.number<state.mintBlock){event({type:'waiting-for-finality',finalized:finalized.number,target:state.mintBlock});await pause();continue;}
  const journal=new Journal(journalDir);fs.mkdirSync(journal.periods,{recursive:true});
  if(journal.entries().length===0){
   const boot=await runCalculator({dir:journalDir,provider:p,token,distributor,config,bootstrap:true});
   assert.equal(boot.plan,null);state.bootstrapBlock=boot.block.number;save();event({type:'bootstrapped',block:boot.block.number});await pause();continue;
  }
  const record=await runCalculator({dir:journalDir,provider:p,token,distributor,config});
  const plan=record.plan;
  if(!plan){event({type:'waiting-for-next-finalized-period'});await pause();continue;}
  assert.deepEqual(Object.keys(plan.payouts).sort(),[holderA.toLowerCase(),holderB.toLowerCase()].sort());
  const a=BigInt(plan.payouts[holderA.toLowerCase()]),b=BigInt(plan.payouts[holderB.toLowerCase()]);
  assert(b===a*2n||b===a*2n+1n,'linear 1:2 payout ratio');
  state.plan=plan;save();
  await cli('propose-round',['script/run-keeper.mjs','--config',configPath,'--journal',journalDir,'--execute','--propose-only'],'PROPOSER_PRIVATE_KEY');
  const pending=await d.pending(plan.roundId);assert.equal(pending.root,plan.root);
  state.readyAt=Number(pending.readyAt);state.proposed=true;save();event({type:'public-round-proposed',roundId:plan.roundId,total:plan.total,readyAt:new Date(state.readyAt*1000).toISOString()});
 }
 if(!state.completed){
  while((await p.getBlock('latest')).timestamp<state.readyAt){event({type:'waiting-for-onchain-timelock',readyAt:new Date(state.readyAt*1000).toISOString()});await pause();}
  if(!state.partialVerified){
   await send('block-holder-b-for-retry-test',()=>s.setBlocked(holderB,true));
   await cli('payout-with-blocked-recipient',['script/run-keeper.mjs','--config',configPath,'--journal',journalDir,'--execute'],'KEEPER_PRIVATE_KEY',[2]);
   assert.equal(await d.paid(state.plan.roundId,holderA),true);assert.equal(await d.paid(state.plan.roundId,holderB),false);
   assert.equal(await s.balanceOf(holderA),BigInt(state.plan.payouts[holderA.toLowerCase()]));assert.equal(await s.balanceOf(holderB),0n);
   state.partialVerified=true;save();
  }
  await send('unblock-holder-b',()=>s.setBlocked(holderB,false));
  await cli('payout-retry',['script/run-keeper.mjs','--config',configPath,'--journal',journalDir,'--execute'],'KEEPER_PRIVATE_KEY');
  const nonce=await p.getTransactionCount(m.roles.keeper);
  await cli('payout-idempotent-repeat',['script/run-keeper.mjs','--config',configPath,'--journal',journalDir,'--execute'],'KEEPER_PRIVATE_KEY');
  assert.equal(await p.getTransactionCount(m.roles.keeper),nonce);
  const round=await d.roundInfo(state.plan.roundId);assert.equal(round.closed,true);assert.equal(round.total,round.distributed);
  assert.equal(await d.totalReserved(),0n);
  for(const holder of [holderA,holderB])assert.equal(await s.balanceOf(holder),BigInt(state.plan.payouts[holder.toLowerCase()]));
  assert.equal(await s.balanceOf(holderC),0n);
  state.finalBalances=await balances();state.finalReserve=String(await d.totalReserved());
  state.checks.push({label:'public-timelock-partial-failure-retry-no-duplicate-payout-and-zero-reserve',passed:true});
  await send('restore-default-24-hour-delay',()=>d.setRoundDelay(86400));
  state.completed=true;state.completedAt=new Date().toISOString();save();event({type:'public-validation-complete',report:statePath});
 }
}catch(e){state.lastError={at:new Date().toISOString(),code:e.code??null,message:e.code&&e.code!=='ERR_ASSERTION'?'RPC or signing error; inspect confirmed receipts':e.message};save();event({type:'validation-stopped',...state.lastError});process.exitCode=1;}
finally{p.destroy();}
