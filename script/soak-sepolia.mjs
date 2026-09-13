// One finite tick of the extended public-testnet test. A scheduled task invokes this every 30 minutes.
// Uses the existing authorized test deployment only; never deploys or transacts on mainnet.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import assert from 'node:assert/strict';import {spawn} from 'node:child_process';
import dotenv from 'dotenv';import {ethers} from 'ethers';
import {createRpcProvider,closeProvider} from '../operations/provider.js';
import {stringify,Journal} from '../calculator/journal.js';
const dryRun=process.argv.includes('--dry-run');
if(process.argv.some((arg,i)=>i>1&&arg!=='--dry-run'))throw Error('Usage: node script/soak-sepolia.mjs [--dry-run]');
const dir=path.resolve('.context/public-sepolia'),file=path.join(dir,'soak.json'),lock=path.join(dir,'.soak-lock');
const manifest='config/deployment-sepolia-new.json',calculator='config/deployment-sepolia-new-calculator.json',journal=path.join(dir,'journal');
const initial=JSON.parse(fs.readFileSync(path.join(dir,'validation.json')));
if(!initial.completed){console.log(JSON.stringify({status:'waiting-for-initial-validation',readyAt:initial.readyAt??null}));process.exit(0);}
// Independent payout replay requires historical state. The former public endpoint
// pruned a journal boundary during the extended test; do not weaken verification.
// This default served the required history on recheck. An explicit archive RPC may override it.
const env=dotenv.parse(fs.readFileSync('../.env'));env.RPC_URL=process.env.RPC_URL??'https://sepolia.base.org';
const p=createRpcProvider(env.RPC_URL);let held=false;
const loadRun=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;
let run=null;
const save=()=>fs.writeFileSync(file,stringify(run)+'\n');
try {
 assert.equal((await p.getNetwork()).chainId,84532n);
 const m=JSON.parse(fs.readFileSync(manifest)),c=m.contracts;assert.equal(m.chainId,84532);
 assert.equal(c.distributor.toLowerCase(),'0xc0524a57cda6558357667d41b0ab1752cd83d2d6');
 const now=(await p.getBlock('latest')).timestamp;
 if(dryRun){run=loadRun();console.log(stringify({status:run?.status??'ready-to-start',durationHours:48,state:run,now}));process.exitCode=0;}
 else {
  fs.mkdirSync(lock);held=true;fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,host:os.hostname(),at:new Date().toISOString()}));
  // Read mutable progress only after exclusive ownership; a concurrent reader must never
  // overwrite another runner's state or mark its in-flight job as failed.
  run=loadRun();
  run??={status:'running',chainId:84532,startedAt:now,endsAt:now+48*3600,feeCycles:[],jobs:[],nextFeesAt:now,nextFloorAt:now,additionalProposalAt:now+13*3600};save();
  if(run.status==='completed'){console.log(stringify({status:'completed',report:file}));}
  else {
   if(run.lastError)throw Error('a prior extended-test error requires review before further writes');
   if(run.pendingJob)throw Error(`previous job ${run.pendingJob.label} requires receipt and process review; automatic replay refused`);
   const abi=n=>JSON.parse(fs.readFileSync(`out/${n}.sol/${n}.json`)).abi;
   const d=new ethers.Contract(c.distributor,abi('DickbuttRewardsDistributor'),p);
   assert.equal(await d.roundDelay(),86400n,'normal 24-hour delay must be restored before the extended test');
   const token=a=>new ethers.Contract(a,['function balanceOf(address) view returns(uint256)','event Transfer(address indexed from,address indexed to,uint256 value)'],p);
   const dick=token(c.dickbutt),weth=token(c.weth),spcxc=token(c.spcxc);
   const snapshot=async blockTag=>{
    blockTag??=await p.getBlockNumber();const out={block:blockTag};
    for(const [role,address]of Object.entries({kc:m.roles.kcGreen,cdb:m.roles.cdbVault,burn:m.roles.burnAddress,executor:c.executor,distributor:c.distributor,dickSplit:m.splits.dickSplit,wethSplit:m.splits.wethSplit,holderA:initial.holders.holderA,holderB:initial.holders.holderB,holderC:initial.holders.holderC}))
     out[role]={address,dick:String(await dick.balanceOf(address,{blockTag})),weth:String(await weth.balanceOf(address,{blockTag})),spcxc:String(await spcxc.balanceOf(address,{blockTag}))};
    return out;
   };
   const resultFrom=out=>out.trim().split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).at(-1);
   const cli=async(label,args,key)=>{
    const job={label,startedAt:new Date().toISOString(),log:path.join(dir,`soak-${run.jobs.length}-${label}.log`)};
    run.pendingJob=job;save();
    const childEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(PRIVATE_KEY|MNEMONIC|RPC_URL|DOTENV_CONFIG_PATH)/.test(k)));
    Object.assign(childEnv,{RPC_URL:env.RPC_URL,RPC_IPV4_ONLY:'1',DOTENV_CONFIG_PATH:'/dev/null',CALCULATOR_DATA_DIR:journal});if(key)childEnv[key]=env[key];
    const output=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{env:childEnv,stdio:['ignore','pipe','pipe']});job.pid=child.pid;save();let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('exit',code=>resolve({out,err,code}));});
    let log=output.out+output.err;for(const [k,v]of Object.entries(env))if(/PRIVATE_KEY|MNEMONIC/.test(k)&&v)log=log.split(v).join('[redacted]');fs.writeFileSync(job.log,log);
    job.exitCode=output.code;job.finishedAt=new Date().toISOString();job.result=resultFrom(output.out);run.jobs.push(job);save();
    if(output.code!==0)throw Error(`${label} exited ${output.code}; inspect ${job.log} before rerun`);
    delete run.pendingJob;save();return job.result;
   };
   if(now<run.endsAt&&now>=run.nextFloorAt){await cli('floor',['script/run-floor.mjs','--config',manifest,'--execute'],'OPS_PRIVATE_KEY');run.nextFloorAt=now+6*3600;save();}
   if(now<run.endsAt&&now>=run.nextFeesAt){
    const before=await snapshot();
    const result=await cli('fees',['script/run-fees.mjs','--config',manifest,'--execute'],'KEEPER_PRIVATE_KEY');
    assert.equal(result.swapStatus,'processed');assert.equal(result.awaitingHandoff.length,0);assert.equal(result.attention.length,0);
    const receipts=await Promise.all(result.actions.filter(a=>a.hash).map(a=>p.getTransactionReceipt(a.hash)));assert(receipts.every(r=>r?.status===1));
    const after=await snapshot(Math.max(...receipts.map(r=>r.blockNumber)));
    const delta=(who,t)=>BigInt(after[who][t])-BigInt(before[who][t]);
    const D=ethers.parseEther('1000')+BigInt(before.dickSplit.dick)-1n,W=ethers.parseEther('0.01')+BigInt(before.wethSplit.weth)-1n;
    assert.equal(delta('kc','dick'),D/10n);assert.equal(delta('burn','dick'),D*9n/10n+ethers.parseEther('5'));
    assert.equal(delta('kc','weth'),W/10n);assert.equal(delta('cdb','weth'),W/10n);
    assert.equal(delta('distributor','spcxc'),100000000n+(W*8n/10n)*200000000n/10n**18n);
    assert.equal(BigInt(after.executor.weth),0n);
    run.feeCycles.push({at:now,before,after,transactions:result.actions.filter(a=>a.hash)});run.nextFeesAt=now+6*3600;save();
   }
   // Commit only one additional round, early enough to finish its normal delay within this run.
   if(!run.additionalProposalDone&&now>=run.additionalProposalAt&&now+25*3600<run.endsAt){
    await cli('calculate',['calculate-rewards.js','--config',calculator],null);
    const result=await cli('propose',['script/run-keeper.mjs','--config',calculator,'--journal',journal,'--execute','--propose-only'],'PROPOSER_PRIVATE_KEY');
    if(result.transactions.some(t=>t.action==='propose')){run.additionalProposalDone=true;run.additionalProposal=result;save();}
   }
   const payout=await cli('payout',['script/run-keeper.mjs','--config',calculator,'--journal',journal,'--execute'],'KEEPER_PRIVATE_KEY');
   run.lastPayout=payout;run.lastCheckAt=now;
   await cli('monitor',['script/run-monitor.mjs','--config',manifest,'--journal',journal],null);
   if(now>=run.endsAt){
    assert(run.additionalProposalDone,'extended run did not complete its additional normal-delay proposal');
    assert(payout.rounds.every(r=>r.status==='closed'),'a planned round remains incomplete');assert.equal(await d.totalReserved(),0n);
    const totals={};for(const {record}of new Journal(journal).entries())if(record.plan)for(const [a,v]of Object.entries(record.plan.payouts))totals[a]=(totals[a]??0n)+BigInt(v);
    for(const [a,total]of Object.entries(totals))assert.equal(await spcxc.balanceOf(a),total,'holder receipts differ from total planned payments');
    run.status='completed';run.completedAt=now;run.finalBalances=await snapshot();run.finalReserve='0';
   }
   save();console.log(stringify({status:run.status,feeCycles:run.feeCycles.length,additionalProposalDone:run.additionalProposalDone??false,endsAt:run.endsAt,payoutTransactions:payout.transactions,report:file}));
  }
 }
}catch(e){if(held&&run){run.lastError={at:new Date().toISOString(),message:e.code&&e.code!=='ERR_ASSERTION'?'RPC or signing operation failed; inspect receipts':e.message};save();}console.error(stringify({status:'attention',message:run?.lastError?.message??e.message}));process.exitCode=1;}
finally{if(held)fs.rmSync(lock,{recursive:true});closeProvider(p);}
