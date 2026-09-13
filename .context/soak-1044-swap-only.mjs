// One reviewed recovery of the retained Sepolia swap. Never repeats fee collection.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {ethers} from 'ethers';
import {createRpcProvider,closeProvider} from '../operations/provider.js';
import {acquireExecutionLock} from '../keeper/engine.js';

const output='.context/test-results/soak-1044-swap-recovery.json';
const marker='config/fee-pending-transaction.json';
const lock='.context/public-sepolia/.soak-lock';
const p=createRpcProvider('https://sepolia.base.org');
const report={startedAt:new Date().toISOString(),mode:'reviewed-swap-only',chainId:84532};
const json=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n';
const persist=()=>{const fd=fs.openSync(output,'w',0o600);try{fs.writeFileSync(fd,json(report));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
let held=false,release;
try{
 assert(!fs.existsSync(output),'recovery already has a record; reconcile it before any further action');
 assert.equal((await p.getNetwork()).chainId,84532n);
 const m=JSON.parse(fs.readFileSync('config/deployment-sepolia-new.json')),c=m.contracts;
 assert.equal(m.chainId,84532);
 assert.equal(c.distributor.toLowerCase(),'0xc0524a57cda6558357667d41b0ab1752cd83d2d6');
 const wallet=new ethers.Wallet(process.env.KEEPER_PRIVATE_KEY,p);
 assert.equal(wallet.address.toLowerCase(),m.roles.keeper.toLowerCase());
 fs.mkdirSync(lock);held=true;
 fs.writeFileSync(path.join(lock,'owner.json'),json({pid:process.pid,host:os.hostname(),at:new Date().toISOString(),purpose:'reviewed retained-swap recovery'}));
 release=acquireExecutionLock('84532',wallet.address);
 const state=JSON.parse(fs.readFileSync('.context/public-sepolia/soak.json'));
 assert.equal(state.pendingJob?.log.endsWith('/soak-18-fees.log'),true);
 assert.equal(state.pendingJob.exitCode,1);
 assert.equal(state.feeCycles.length,1);
 assert(!fs.existsSync(marker),'pending transaction needs separate reconciliation');
 const prior=JSON.parse(fs.readFileSync('.context/test-results/soak-1044-reconciliation.json'));
 assert(!prior.fatal);assert(Object.values(prior.checks).every(c=>c.ok));
 for(const old of prior.receipts){
  const r=await p.getTransactionReceipt(old.hash),tx=await p.getTransaction(old.hash);
  assert.equal(r?.status,1);assert.equal(r.blockNumber,old.block);
  assert.equal(tx.from.toLowerCase(),wallet.address.toLowerCase());assert.equal(tx.nonce,old.nonce);
 }
 assert.equal(await p.getTransactionCount(wallet.address,'latest'),31);
 assert.equal(await p.getTransactionCount(wallet.address,'pending'),31);
 const abi=n=>JSON.parse(fs.readFileSync(`out/${n}.sol/${n}.json`)).abi;
 const executor=new ethers.Contract(c.executor,abi('SpcxcSwapExecutor'),wallet);
 const d=new ethers.Contract(c.distributor,abi('DickbuttRewardsDistributor'),p);
 const token=a=>new ethers.Contract(a,['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)'],p);
 const weth=token(c.weth),spcxc=token(c.spcxc);
 const block=await p.getBlock('latest'),snapshot={blockTag:block.number};
 assert.equal(await executor.weth(snapshot),c.weth);
 assert.equal((await executor.distributor(snapshot)).toLowerCase(),c.distributor.toLowerCase());
 assert.equal(await executor.isKeeper(wallet.address,snapshot),true);
 const amount=await weth.balanceOf(c.executor,snapshot);
 assert.equal(amount,8000000000000000n);
 assert.equal(await spcxc.balanceOf(c.distributor,snapshot),304000001n);
 assert.equal(await d.roundDelay(snapshot),86400n);assert.equal(await d.totalReserved(snapshot),0n);
 assert((await executor.maxSwapPerCall(snapshot))>=amount);
 assert((await executor.priceFloorExpiresAt(snapshot))>BigInt(block.timestamp+120));
 assert((await executor.minSpcxcPerWeth(snapshot))>0n);
 const quoter=new ethers.Contract(m.quoter,['function quoteExactInput(bytes,uint256) returns(uint256,uint160[],uint32[],uint256)'],p);
 const route=await executor.swapPath(snapshot);
 const quote=(await quoter.quoteExactInput.staticCall(route,amount,snapshot))[0];
 assert.equal(quote,1600000n);
 const minimum=quote*9900n/10000n,deadline=block.timestamp+120;
 assert.equal(await executor.processWeth.staticCall(minimum,deadline),quote);
 const request=await wallet.populateTransaction({...await executor.processWeth.populateTransaction(minimum,deadline),nonce:31});
 assert.equal(request.chainId,84532n);assert.equal(request.nonce,31);
 const signed=await wallet.signTransaction(request),hash=ethers.keccak256(signed);
 Object.assign(report,{status:'prepared',hash,nonce:31,executor:c.executor,distributor:c.distributor,amount,quote,minimum,deadline,before:prior.after,reconciledFeeTransactions:prior.receipts.map(({logs,...r})=>r)});
 persist();
 const fd=fs.openSync(marker,'wx',0o600);
 try{fs.writeFileSync(fd,json({action:'swap',status:'prepared',hash,chainId:'84532',signer:wallet.address,nonce:31,recovery:output}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const tx=await p.broadcastTransaction(signed);assert.equal(tx.hash,hash);
 report.status='submitted';persist();
 const receipt=await tx.wait(1);assert.equal(receipt?.status,1);
 const tag={blockTag:receipt.blockNumber};
 const processed=receipt.logs.filter(l=>l.address.toLowerCase()===c.executor.toLowerCase()).flatMap(l=>{try{const e=executor.interface.parseLog(l);return e.name==='WethProcessed'?[e]:[];}catch{return[];}});
 assert.equal(processed.length,1);assert.equal(processed[0].args.swapped,amount);assert.equal(processed[0].args.spcxcOut,quote);
 assert.equal(await weth.balanceOf(c.executor,tag),0n);
 assert.equal(await spcxc.balanceOf(c.distributor,tag),305600001n);
 assert.equal(await weth.allowance(c.executor,await executor.router(tag),tag),0n);
 assert.equal(await d.totalReserved(tag),0n);assert.equal(await d.roundDelay(tag),86400n);
 Object.assign(report,{status:'confirmed-and-verified',finishedAt:new Date().toISOString(),receipt:{hash,status:receipt.status,block:receipt.blockNumber,gasUsed:receipt.gasUsed,logs:receipt.logs},executorWeth:'0',distributorSpcxc:'305600001',allowance:'0',reserved:'0'});persist();
 assert.equal(JSON.parse(fs.readFileSync(marker)).hash,hash);fs.unlinkSync(marker);
 console.log(json({status:report.status,hash,block:receipt.blockNumber,amount,output:quote,distributorSpcxc:report.distributorSpcxc}));
}catch(e){
 report.error={code:e.code,action:e.action,message:e.shortMessage??e.message};
 const key=process.env.KEEPER_PRIVATE_KEY;if(key)report.error.message=report.error.message.split(key).join('[redacted]');
 // Never replace a previous recovery record on a repeated invocation.
 if(report.hash||!fs.existsSync(output)){report.status=report.status??'attention-before-signing';persist();}
 console.error(json({status:'attention',error:report.error,report:output}));process.exitCode=1;
}finally{release?.();if(held)fs.rmSync(lock,{recursive:true});closeProvider(p);}
