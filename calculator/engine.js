import fs from 'node:fs';import path from 'node:path';import {ethers} from 'ethers';import {Journal,hash} from './journal.js';import {amounts,sum,computeTWAB,computeShares,buildPlan} from './core.js';import {selectBoundary,reconcile,scanEvents,ERC20_ABI} from './chain.js';
export async function runCalculator({dir='.',provider,token,distributor,config,rewardTokenFactory=(address)=>new ethers.Contract(address,ERC20_ABI,provider)}){
 const journal=new Journal(dir);journal.lock();try{
 const recovered=journal.rebuild();if(!recovered&&fs.existsSync(path.join(dir,'state.json')))throw Error('legacy state without journal: explicit audited migration required');
 const state=recovered??{lastProcessedBlock:config.deployBlock-1,balances:{},accrued:{},plans:{}};
 const configHash=hash(config);if(state.configHash&&state.configHash!==configHash)throw Error('configuration changed: audited migration required');
 const boundary=await selectBoundary(provider,config.finalityTag),blockTag=boundary.number;if(blockTag<=state.lastProcessedBlock)return {unchanged:true};
 if(state.blockHash){const previous=await provider.getBlock(state.lastProcessedBlock);if(previous?.hash!==state.blockHash)throw Error('previous snapshot hash changed');}
 const startingAccrual=amounts(state.accrued),{localReserved,recredits}=await reconcile(distributor,state,blockTag,config.chunkSize);
 const [next,available,minPayout,decimals,rewardToken]=await Promise.all([distributor.nextRoundId({blockTag}),distributor.availableForNextRound({blockTag}),distributor.minPayout({blockTag}),token.decimals({blockTag}),distributor.rewardToken({blockTag})]);
 if(Number(decimals)!==18)throw Error('unexpected holder token decimals');
 // Metadata is also read at the snapshot; never call latest through a helper.
 const reward=rewardTokenFactory(rewardToken);
 const rewardDecimals=Number(await reward.decimals({blockTag}));
 const roundId=BigInt(next).toString();if(state.plans[roundId])throw Error(`unproposed local plan already reserves round ${roundId}`);
 const availableRaw=BigInt(available),carry=sum(state.accrued),pot=availableRaw-carry-localReserved;if(pot<0n)throw Error('insolvent local accrual/reservations');
 const fromBlock=state.lastProcessedBlock+1,startBlock=await provider.getBlock(state.lastProcessedBlock);if(!startBlock)throw Error('missing period start block');
 const transfers=await scanEvents(token,token.filters.Transfer(),fromBlock,blockTag,config.chunkSize),timestamps=new Map();for(const n of new Set(transfers.map(e=>e.blockNumber))){const b=await provider.getBlock(n);if(!b)throw Error('missing transfer block');timestamps.set(n,b.timestamp);}
 const {twab,endingBalances}=computeTWAB(state.balances,transfers,timestamps,startBlock.timestamp,boundary.timestamp,config.excluded);
 const {shares,qualifying,dust}=computeShares(twab,BigInt(config.holderThresholdRaw),pot,config.curve),accrued=amounts(state.accrued);for(const[a,v]of Object.entries(shares))accrued[a]=(accrued[a]??0n)+v;
 const threshold=BigInt(config.payoutThresholdRaw)>BigInt(minPayout)?BigInt(config.payoutThresholdRaw):BigInt(minPayout),payouts={};for(const[a,v]of Object.entries(accrued))if(v>0n&&v>=threshold){payouts[a]=v;delete accrued[a];}
 const plan=buildPlan(roundId,payouts,config.batchSize);if(plan){if(BigInt(plan.total)>availableRaw-localReserved)throw Error('plan exceeds available funds');plan.toBlock=blockTag;state.plans[roundId]=plan;}
 const end=await provider.getBlock(blockTag);if(end?.hash!==boundary.hash)throw Error('snapshot hash changed during calculation');
 Object.assign(state,{lastProcessedBlock:blockTag,blockHash:boundary.hash,balances:endingBalances,accrued,configHash});
 const record={version:1,config,configHash,block:{number:blockTag,hash:boundary.hash,finality:config.finalityTag},fromBlock,periodStartTs:startBlock.timestamp,periodEndTs:boundary.timestamp,startingAccrual,recredits,newShares:shares,payouts,endingAccrual:accrued,available:availableRaw,localReserved,pot,dust,qualifying,rewardToken,rewardDecimals,roundId:plan?.roundId??null,root:plan?.root??null,plan,state};journal.append(record);return record;
 }finally{journal.unlock();}
}
