import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { Journal, hash, stringify } from '../calculator/journal.js';
import { buildPlan, normalize } from '../calculator/core.js';
import { verifyPayoutHistory } from './verify-history.js';

export const KEEPER_ABI = [
 'function rewardToken() view returns(address)',
 'function nextRoundId() view returns(uint256)',
 'function totalReserved() view returns(uint256)',
 'function roundInfo(uint256) view returns(bytes32 root,uint256 total,uint256 distributed,bool active,bool closed)',
 'function pending(uint256) view returns(bytes32 root,uint256 total,uint256 readyAt)',
 'function paid(uint256,address) view returns(bool)',
 'function isKeeper(address) view returns(bool)',
 'function isProposer(address) view returns(bool)',
 'function proposalsPaused() view returns(bool)',
 'function maxProposableTotal() view returns(uint256)',
 'function nextProposalAllowedAt() view returns(uint256)',
 'function owner() view returns(address)',
 'function proposeRound(bytes32,uint256) returns(uint256)',
 'function activateRound(uint256)',
 'function distributeBatch(uint256,address[],uint256[],bytes32[][])',
 'function closeRound(uint256)',
 'event PaymentFailed(uint256 indexed roundId,address indexed account,uint256 amount)',
];

/** Block the current thread; the CLIs are single-purpose processes with nothing else to do meanwhile. */
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms)); }

/**
 * One signer, one process at a time on this host. The fee cycle and the payout job share a key and a
 * schedule that will sometimes overlap, so a caller may wait a bounded time for the lock rather than
 * page about a collision. A lock that outlives the wait is treated as stale-or-stuck and still fails.
 */
export function acquireExecutionLock(chainId, address, {waitMs=0,pollMs=2000}={}) {
 const location=path.join(os.tmpdir(),`dickbutt-keeper-${chainId}-${normalize(address)}.lock`);
 const deadline=Date.now()+waitMs;
 for (;;) {
  try { fs.mkdirSync(location, {mode:0o700}); break; }
  catch {
   if (Date.now()>=deadline) {
    let holder='';try{holder=` held by ${fs.readFileSync(path.join(location,'owner.json'),'utf8')}`;}catch{}
    throw Error(`keeper lock exists: ${location}${holder}; verify its owner and pending transactions before manual recovery`);
   }
   sleepSync(Math.min(pollMs,deadline-Date.now()));
  }
 }
 fs.writeFileSync(path.join(location,'owner.json'),stringify({pid:process.pid,host:os.hostname(),started:new Date().toISOString()}),{mode:0o600});
 return ()=>fs.rmSync(location,{recursive:true});
}

function verifyPlan(record, config) {
 const plan=record.plan;
 if (!plan) return null;
 if (BigInt(plan.roundId)<1n || String(plan.roundId)!==String(record.roundId)) throw Error('invalid plan round id');
 const rebuilt=buildPlan(plan.roundId,plan.payouts,config.batchSize);
 if (!rebuilt || rebuilt.root!==record.root || rebuilt.root!==plan.root || rebuilt.total!==String(plan.total)
     || hash(rebuilt.batches)!==hash(plan.batches) || hash(rebuilt.tree)!==hash(plan.tree)
     || hash(record.payouts)!==hash(plan.payouts)) throw Error(`Merkle plan or batch mismatch for round ${plan.roundId}`);
 if (Object.values(plan.payouts).some(value=>BigInt(value)<=0n)) throw Error('plan contains nonpositive payout');
 return rebuilt;
}

async function inspect(distributor,plan) {
 const [round,pending,next]=await Promise.all([distributor.roundInfo(plan.roundId),distributor.pending(plan.roundId),distributor.nextRoundId()]);
 const [root,total,distributed,active,closed]=round;
 const [pendingRoot,pendingTotal,readyAt]=pending;
 const exists=root!==ethers.ZeroHash || BigInt(total)!==0n || active || closed;
 const waiting=pendingRoot!==ethers.ZeroHash || BigInt(pendingTotal)!==0n;
 if ((active&&closed)||(exists&&waiting)||(exists&&!active&&!closed)||BigInt(distributed)>BigInt(total)) throw Error(`invalid round ${plan.roundId} status`);
 if ((exists||waiting) && BigInt(next)<=BigInt(plan.roundId)) throw Error('next round id inconsistent with commitment');
 if (!exists&&!waiting && BigInt(next)!==BigInt(plan.roundId)) throw Error(`local round id ${plan.roundId} differs from next round id ${next}`);
 // A root this journal did not produce sits at our round id. Rounds are independent, so this one is
 // reported and left alone rather than halting every other round: the keeper holds no proofs for a
 // foreign root and so cannot pay it, and the monitor raises the alarm. Once the guardian has closed
 // it the calculator recredits our plan and re-plans it under the next free id.
 const onChainRoot=exists?root:waiting?pendingRoot:null;
 if (onChainRoot===ethers.ZeroHash) throw Error(`round ${plan.roundId} commitment mismatch: zero root with committed state`);
 if (onChainRoot && onChainRoot.toLowerCase()!==plan.root.toLowerCase()) return {foreign:true,foreignRoot:onChainRoot,exists,waiting,active,closed,distributed:BigInt(distributed),readyAt:BigInt(readyAt)};
 if (exists && BigInt(total)!==BigInt(plan.total)) throw Error(`round ${plan.roundId} commitment mismatch`);
 if (waiting && BigInt(pendingTotal)!==BigInt(plan.total)) throw Error(`pending round ${plan.roundId} commitment mismatch`);
 return {foreign:false,exists,waiting,active,closed,distributed:BigInt(distributed),readyAt:BigInt(readyAt)};
}

/** Consume authentic calculator Journal records; all transaction dependencies are injected. */
export async function runKeeper({dir,provider,distributor,config,execute=false,propose=false,proposeOnly=false,signerAddress,
 ownerDistributor=distributor,ownerAddress=signerAddress,confirmations=1,lockWaitSeconds=0,onEvent=()=>{},verifyHistory=verifyPayoutHistory}) {
 // proposeOnly lets the proposer bot run without the keeper key on its host. It commits roots and
 // stops; activation is permissionless and payment belongs to the keeper.
 if (proposeOnly&&!propose) throw Error('proposeOnly requires propose');
 if (!Number.isSafeInteger(confirmations)||confirmations<1) throw Error('confirmations must be a positive integer');
 const chainId=(await provider.getNetwork()).chainId.toString();
 if (execute&&!['31337','84532'].includes(chainId)) throw Error('production transaction execution is disabled; allowed chains: 31337, 84532');
 if (chainId!==String(config.chainId)) throw Error('RPC chain does not match calculator config');
 if (normalize(await distributor.getAddress())!==normalize(config.distributor)) throw Error('distributor does not match calculator config');
 if (execute&&!signerAddress) throw Error('execute requires signerAddress');
 const locks=[],journal=new Journal(dir);
 const result={mode:execute?'execute':'dry-run',chainId,rounds:[],transactions:[]};
 const emit=event=>onEvent({...event,chainId});
 try {
  if (execute) {
   const signingAddresses=[...new Set([signerAddress,...(propose?[ownerAddress]:[])].map(normalize))].sort();
   for (const address of signingAddresses) locks.push(acquireExecutionLock(chainId,address,{waitMs:lockWaitSeconds*1000}));
   // Another job can broadcast while this run is waiting for its signer lock, then release
   // the lock after an RPC timeout. A pre-lock nonce check cannot detect that unresolved send.
   // Check every signer here, under all locks, before consulting this job's separate marker.
   for (const address of signingAddresses) {
    const [latest,pending]=await Promise.all([provider.getTransactionCount(address,'latest'),provider.getTransactionCount(address,'pending')]);
    if (!Number.isSafeInteger(latest)||latest<0||!Number.isSafeInteger(pending)||pending<0) throw Error('invalid signer nonce response; reconcile RPC state before keeper execution');
    if (latest!==pending) throw Error('signer has pending transactions; resolve them before keeper execution');
   }
  }
  journal.lock();
  const rows=journal.entries();
  if (!rows.length) throw Error('no calculator journal records');
  const expectedHash=hash(config), rewardToken=normalize(await distributor.rewardToken());
  const plans=[],seen=new Set();
  for (const {record} of rows) {
   if (record.version!==1 || hash(record.config)!==expectedHash || record.configHash!==expectedHash || record.state.configHash!==expectedHash) throw Error('journal configuration identity mismatch');
   if (normalize(record.rewardToken)!==rewardToken) throw Error('journal reward token mismatch');
   const block=await provider.getBlock(record.block.number);
   if (!block || block.hash!==record.block.hash) throw Error('journal snapshot hash changed');
   const plan=verifyPlan(record,config);
   if (plan) { if(seen.has(plan.roundId))throw Error('duplicate journal plan round id');seen.add(plan.roundId);plans.push(plan); }
  }
  // Proposer-host journal copies are untrusted calculation results. Recompute their
  // eligibility, balances and payouts independently before approving any mutation.
  result.historyVerification=await verifyHistory({rows,config,provider});
  // Check every commitment before the first mutation, including older closed rounds.
  for (const plan of plans) await inspect(distributor,plan);
  if (execute && propose && normalize(await ownerDistributor.getAddress())!==normalize(config.distributor)) throw Error('owner distributor does not match config');
  const marker=path.join(journal.dir,'keeper-pending-transaction.json');
  if (execute&&fs.existsSync(marker)) {
   const pending=JSON.parse(fs.readFileSync(marker,'utf8'));
   const receipt=await provider.getTransactionReceipt(pending.hash);
   if (!receipt || await receipt.confirmations()<confirmations) throw Error(`unresolved transaction ${pending.hash}; inspect receipt before rerun`);
   fs.unlinkSync(marker);
   emit({type:'recovered-transaction',hash:pending.hash,status:Number(receipt.status)});
  }
  async function send(action,roundId,submit) {
   const tx=await submit();
   const markerFd=fs.openSync(marker,'wx',0o600);
   try { fs.writeFileSync(markerFd,stringify({chainId,distributor:config.distributor,action,roundId,hash:tx.hash}));fs.fsyncSync(markerFd); }
   finally { fs.closeSync(markerFd); }
   const dirFd=fs.openSync(journal.dir,'r');
   try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
   emit({type:'transaction-submitted',action,roundId,hash:tx.hash});
   let receipt;
   try { receipt=await tx.wait(confirmations); }
   catch (error) {
    // A mined revert is terminal. An unknown/replaced/pending transaction remains a recovery barrier.
    if (error.receipt && Number(error.receipt.status)===0) fs.unlinkSync(marker);
    throw Error(`${action} transaction failed; inspect ${tx.hash} before rerun`);
   }
   if (!receipt) throw Error(`missing receipt for transaction ${tx.hash}`);
   fs.unlinkSync(marker);
   if (Number(receipt.status)!==1) throw Error(`${action} transaction receipt failed: ${tx.hash}`);
   result.transactions.push({action,roundId,hash:tx.hash});
   emit({type:'transaction-confirmed',action,roundId,hash:tx.hash});
   return receipt;
  }
  async function unpaid(plan) {
   const accounts=Object.keys(plan.payouts).sort();
   const flags=await Promise.all(accounts.map(account=>distributor.paid(plan.roundId,account)));
   return accounts.filter((_account,index)=>!flags[index]);
  }
  for (const plan of plans) {
   let state=await inspect(distributor,plan);
   const report={roundId:plan.roundId,root:plan.root,total:plan.total,status:'proposal-required',unpaid:[],failed:[]};
   result.rounds.push(report);
   if (state.foreign) {
    report.status=state.closed?'superseded':'foreign-commitment';report.foreignRoot=state.foreignRoot;
    emit({type:report.status,roundId:plan.roundId,localRoot:plan.root,foreignRoot:state.foreignRoot});
    continue;
   }
   if (!state.exists&&!state.waiting) {
    if (!execute||!propose) continue;
    // The proposer is a bot role now; the owner keeps the ability implicitly. Check the
    // contract's own limits first so an operator sees why, instead of a bare revert.
    const [proposer,contractOwner,paused,maxTotal,allowedAt]=await Promise.all([
     ownerDistributor.isProposer(ownerAddress),ownerDistributor.owner(),ownerDistributor.proposalsPaused(),
     ownerDistributor.maxProposableTotal(),ownerDistributor.nextProposalAllowedAt()]);
    if (!proposer&&normalize(contractOwner)!==normalize(ownerAddress)) throw Error('proposal signer is neither an approved proposer nor the distributor owner');
    if (paused) throw Error('proposals are paused by the guardian; resolve before reproposing');
    if (BigInt(plan.total)>BigInt(maxTotal)) throw Error(`round ${plan.roundId} total ${plan.total} exceeds the contract share cap ${maxTotal}`);
    const latest=await provider.getBlock('latest');
    if (BigInt(allowedAt)>BigInt(latest.timestamp)) {report.status='proposal-rate-limited';report.readyAt=allowedAt.toString();continue;}
    await send('propose',plan.roundId,()=>ownerDistributor.proposeRound(plan.root,plan.total));
    state=await inspect(distributor,plan);
   }
   if (state.waiting) {
    const block=await provider.getBlock('latest');
    report.readyAt=state.readyAt.toString();
    if (proposeOnly) {report.status=BigInt(block.timestamp)<state.readyAt?'timelocked':'activation-ready';continue;}
    if (BigInt(block.timestamp)<state.readyAt) {report.status='timelocked';continue;}
    if (!execute) {report.status='activation-ready';continue;}
    await send('activate',plan.roundId,()=>distributor.activateRound(plan.roundId));
    state=await inspect(distributor,plan);
   }
   if (proposeOnly) {report.status=state.closed?'closed':state.active?'distribution-ready':'proposal-required';continue;}
   report.unpaid=await unpaid(plan);
   if (state.closed) {report.status=report.unpaid.length?'closed-unpaid':'closed';continue;}
   if (!state.active) throw Error('round failed to activate');
   if (!execute) {report.status=report.unpaid.length?'distribution-ready':'close-ready';continue;}
   if (report.unpaid.length && !await distributor.isKeeper(signerAddress)) throw Error('signer is not an approved keeper');
   for (const batch of plan.batches) {
    // Reread flags before each batch, so crash recovery and other keepers remain idempotent.
    state=await inspect(distributor,plan);
    if (!state.active) break;
    const flags=await Promise.all(batch.accounts.map(account=>distributor.paid(plan.roundId,account)));
    const indices=flags.flatMap((paid,index)=>paid?[]:[index]);
    if (!indices.length) continue;
    const receipt=await send('batch',plan.roundId,()=>distributor.distributeBatch(plan.roundId,indices.map(i=>batch.accounts[i]),indices.map(i=>batch.amounts[i]),indices.map(i=>batch.proofs[i])));
    for (const log of receipt.logs) {
     if (normalize(log.address)!==normalize(config.distributor)) continue;
     let event;try{event=distributor.interface.parseLog(log);}catch{continue;}
     if (event?.name==='PaymentFailed'&&String(event.args.roundId)===plan.roundId) {
      const failure={account:normalize(event.args.account),amount:event.args.amount.toString()};
      report.failed.push(failure);emit({type:'payment-failed',roundId:plan.roundId,...failure});
     }
    }
   }
   report.unpaid=await unpaid(plan);
   state=await inspect(distributor,plan);
   if (state.closed) report.status=report.unpaid.length?'closed-unpaid':'closed';
   else if (!report.unpaid.length && state.distributed===BigInt(plan.total)) {
    await send('close',plan.roundId,()=>distributor.closeRound(plan.roundId));
    state=await inspect(distributor,plan);
    if (!state.closed) throw Error('close receipt did not close round');
    report.status='closed';
   } else report.status='partial';
  }
  emit({type:'keeper-complete',rounds:result.rounds});
  return result;
 } finally {
  journal.unlock();
  for (const release of locks.reverse()) release();
 }
}
