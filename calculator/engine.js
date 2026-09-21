import fs from 'node:fs';import path from 'node:path';import {ethers} from 'ethers';import {Journal,hash} from './journal.js';import {amounts,sum,computeTWAB,computeShares,buildPlan,cappedPayouts} from './core.js';import {selectBoundary,reconcile,scanEvents,ERC20_ABI} from './chain.js';
import {readPruningPolicy,uint256String} from './config.js';
export async function runCalculator({dir='.',provider,token,distributor,config,bootstrap=false,rewardTokenFactory=(address)=>new ethers.Contract(address,ERC20_ABI,provider)}){
 readPruningPolicy(config);
 const journal=new Journal(dir);journal.lock();try{
 const recovered=journal.rebuild();if(!recovered&&fs.existsSync(path.join(dir,'state.json')))throw Error('legacy state without journal: explicit audited migration required');
 const result=await runCalculatorFromState({startingState:recovered,provider,token,distributor,config,bootstrap,rewardTokenFactory});
 if(!result.unchanged&&!result.pendingPlan)journal.append(result);
 return result;
 }finally{journal.unlock();}
}

/** Calculate one period without journal access. The caller must establish the starting state's
 * trust independently; never supply an unverified proposer record or state cache here.
 * Cloning keeps the caller's verified state unchanged on success, early return or failure.
 */
export async function runCalculatorFromState({startingState,provider,token,distributor,config,bootstrap=false,rewardTokenFactory=(address)=>new ethers.Contract(address,ERC20_ABI,provider)}){
 const pruneSettledPlans=readPruningPolicy(config);
 const state=startingState==null?{lastProcessedBlock:config.deployBlock-1,balances:{},accrued:{},plans:{},...(pruneSettledPlans?{highestPrunedRoundId:'0'}:{})}:structuredClone(startingState);
 const configHash=hash(config);if(state.configHash&&state.configHash!==configHash)throw Error('configuration changed: audited migration required');
 const boundary=await selectBoundary(provider,config.finalityTag),blockTag=boundary.number;if(blockTag<=state.lastProcessedBlock)return {unchanged:true};
 if(state.blockHash){const previous=await provider.getBlock(state.lastProcessedBlock);if(previous?.hash!==state.blockHash)throw Error('previous snapshot hash changed');}
 const startingAccrual=amounts(state.accrued),{localReserved,recredits,prunedRounds}=await reconcile(distributor,state,blockTag,config.chunkSize,{pruneSettledPlans});
 const [next,available,minPayout,decimals,rewardToken,maxProposable]=await Promise.all([distributor.nextRoundId({blockTag}),distributor.availableForNextRound({blockTag}),distributor.minPayout({blockTag}),token.decimals({blockTag}),distributor.rewardToken({blockTag}),distributor.maxProposableTotal({blockTag})]);
 if(Number(decimals)!==18)throw Error('unexpected holder token decimals');
 // Metadata is also read at the snapshot; never call latest through a helper.
 const reward=rewardTokenFactory(rewardToken);
 const rewardDecimals=Number(await reward.decimals({blockTag}));
 const roundId=BigInt(next).toString(),held=state.plans[roundId];
 if(pruneSettledPlans&&uint256String(roundId,'next round id',{allowZero:false})<=uint256String(state.highestPrunedRoundId,'highestPrunedRoundId'))throw Error('next round id reuses a previously pruned round');
 // A plan that is built but not yet proposed is the ordinary gap between the calculate and propose
 // steps, not a fault. Throwing made the scheduled job unrecoverable: the keeper run that clears the
 // plan by proposing it is the only thing that can unjam this, and it only ran on a zero exit.
 if(held&&!held.settled)return {pendingPlan:true,roundId,plan:held};
 if(held)throw Error(`settled local plan still occupies the next round id ${roundId}`);
 const availableRaw=BigInt(available),carry=sum(state.accrued),roundCap=BigInt(maxProposable);
 let pot=availableRaw-carry-localReserved;if(pot<0n)throw Error('insolvent local accrual/reservations');
 // Balances have to be rebuilt from the token's first block, so without this the first period's
 // time-weighted average spans the token's entire history and a recent holder averages to nothing.
 // A bootstrap period commits balances and a zero pot; the first real period measures from here.
 if(bootstrap){if(state.lastProcessedBlock!==config.deployBlock-1)throw Error('bootstrap is only valid for the first period');pot=0n;}
 // The distributor caps one round at a share of its unreserved balance. Allocate at most that much
 // in new shares; the remainder stays in the contract and reappears in the next period's available.
 // Without this the calculator would plan rounds the contract always rejects.
 // Preserve the historical new-share calculation. If accumulated credit exceeds the cap,
 // cappedPayouts allocates proportional instalments and keeps every unpaid raw unit as credit.
 const uncapped=pot,room=carry<roundCap?roundCap-carry:roundCap;if(pot>room)pot=room;
 const fromBlock=state.lastProcessedBlock+1,startBlock=await provider.getBlock(state.lastProcessedBlock);if(!startBlock)throw Error('missing period start block');
 const transfers=await scanEvents(token,token.filters.Transfer(),fromBlock,blockTag,config.chunkSize),timestamps=new Map();for(const n of new Set(transfers.map(e=>e.blockNumber))){const b=await provider.getBlock(n);if(!b)throw Error('missing transfer block');timestamps.set(n,b.timestamp);}
 const {twab,endingBalances}=computeTWAB(state.balances,transfers,timestamps,startBlock.timestamp,boundary.timestamp,config.excluded);
 const {shares,qualifying,dust}=computeShares(twab,BigInt(config.holderThresholdRaw),pot,config.curve),accrued=amounts(state.accrued);for(const[a,v]of Object.entries(shares))accrued[a]=(accrued[a]??0n)+v;
 const threshold=BigInt(config.payoutThresholdRaw)>BigInt(minPayout)?BigInt(config.payoutThresholdRaw):BigInt(minPayout);
 const allocation=cappedPayouts(accrued,threshold,roundCap),payouts=allocation.payouts;
 for(const a of Object.keys(accrued))delete accrued[a];Object.assign(accrued,allocation.accrued);
 const plan=buildPlan(roundId,payouts,config.batchSize);if(plan){if(BigInt(plan.total)>availableRaw-localReserved)throw Error('plan exceeds available funds');
  if(BigInt(plan.total)>roundCap)throw Error('capped allocation exceeds the distributor round share cap');
  plan.toBlock=blockTag;state.plans[roundId]=plan;}
 const end=await provider.getBlock(blockTag);if(end?.hash!==boundary.hash)throw Error('snapshot hash changed during calculation');
 Object.assign(state,{lastProcessedBlock:blockTag,blockHash:boundary.hash,balances:endingBalances,accrued,configHash});
 const record={version:1,config,configHash,block:{number:blockTag,hash:boundary.hash,finality:config.finalityTag},fromBlock,periodStartTs:startBlock.timestamp,periodEndTs:boundary.timestamp,bootstrap,startingAccrual,recredits,newShares:shares,payouts,endingAccrual:accrued,available:availableRaw,localReserved,pot,potBeforeCap:uncapped,roundCap,dust,qualifying,rewardToken,rewardDecimals,roundId:plan?.roundId??null,root:plan?.root??null,plan,...(pruneSettledPlans?{prunedRounds}:{}),state};return record;
}
