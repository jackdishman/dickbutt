import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ZeroAddress,ZeroHash} from 'ethers';
import {runCalculator} from '../../engine.js';

export const holderA='0x00000000000000000000000000000000000000aa';
export const holderB='0x00000000000000000000000000000000000000bb';
const reward='0x00000000000000000000000000000000000000cc';

/** Deterministic archive: each calculated plan is fully paid/closed in its next block. */
export async function historyFixture(t,{pruneSettledPlans,calculate=runCalculator}={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pruning-history-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let tip=10;
 const plans=new Map(),block=n=>({number:n,hash:'0x'+n.toString(16).padStart(64,'0'),timestamp:n*10});
 const config={chainId:'31337',token:holderA,distributor:holderB,deployBlock:1,holderThresholdRaw:'50',payoutThresholdRaw:'1',curve:'linear',excluded:[ZeroAddress],batchSize:2,chunkSize:100,finalityTag:'finalized',...(pruneSettledPlans===undefined?{}:{pruneSettledPlans})};
 const provider={getBlock:async n=>block(n==='finalized'?tip:n)};
 const events=[holderA,holderB].map((to,index)=>({blockNumber:1,index,args:{from:ZeroAddress,to,value:100n}}));
 const token={decimals:async()=>18,filters:{Transfer:()=>1},queryFilter:async(_f,from,to)=>events.filter(e=>e.blockNumber>=from&&e.blockNumber<=to)};
 const distributor={
  nextRoundId:async({blockTag})=>1n+BigInt([...plans.values()].filter(p=>p.toBlock<blockTag).length),
  availableForNextRound:async()=>100n,maxProposableTotal:async()=>50n,minPayout:async()=>1n,rewardToken:async()=>reward,
  roundInfo:async(id,{blockTag})=>{const p=plans.get(String(id));return !p||p.toBlock>=blockTag?[ZeroHash,0n,0n,false,false]:[p.root,BigInt(p.total),BigInt(p.total),false,true];},
  pending:async()=>[ZeroHash,0n,0n],filters:{Paid:id=>String(id)},
  queryFilter:async(id,from,to)=>{
   const p=plans.get(String(id));if(!p||p.toBlock+1<from||p.toBlock+1>to)return [];
   return Object.entries(p.payouts).map(([account,amount],index)=>({blockNumber:p.toBlock+1,index,args:{account,amount:BigInt(amount)}}));
  }
 };
 const rewardTokenFactory=()=>({decimals:async()=>8}),args={dir,provider,token,distributor,config,rewardTokenFactory};
 const records=[await calculate({...args,bootstrap:true})];
 const advance=async()=>{tip+=10;const record=await calculate(args);records.push(record);if(record.plan)plans.set(record.plan.roundId,record.plan);return record;};
 return {...args,records,plans,advance};
}
