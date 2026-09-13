// Synthetic capacity test with an independently accumulated time-integral reference.
// No RPC, keys or transactions. Does not measure production RPC indexing throughput.
import assert from 'node:assert/strict';import fs from 'node:fs';
import {performance} from 'node:perf_hooks';import {StandardMerkleTree} from '@openzeppelin/merkle-tree';
import {computeTWAB,computeShares,buildPlan,sum} from '../calculator/core.js';
const count=10000,eventCount=200000,end=BigInt(eventCount+1),initial=7000000n*10n**18n;
const accounts=Array.from({length:count},(_,i)=>'0x'+(i+1).toString(16).padStart(40,'0'));
const start=Object.fromEntries(accounts.map(a=>[a,initial])),integrals=new Map(accounts.map(a=>[a,initial*end])),ending=new Map(accounts.map(a=>[a,initial]));
const events=[],timestamps=new Map();
for(let i=0;i<eventCount;i++){
 const from=accounts[i%count],to=accounts[(i*73+17)%count],value=BigInt(i%11+1)*10n**18n,time=i+1;
 events.push({blockNumber:time,index:0,args:{from,to,value}});timestamps.set(time,time);
 const remaining=end-BigInt(time);integrals.set(from,integrals.get(from)-value*remaining);integrals.set(to,integrals.get(to)+value*remaining);
 ending.set(from,ending.get(from)-value);ending.set(to,ending.get(to)+value);
}
const began=performance.now();const {twab,endingBalances}=computeTWAB(start,events,timestamps,0,end,[]);
for(const a of accounts){assert.equal(twab[a],integrals.get(a)/end);assert.equal(endingBalances[a],ending.get(a));}
const twabMs=performance.now()-began,pot=1234567890123n;
const {shares,qualifying,dust}=computeShares(twab,6900000n*10n**18n,pot,'linear');assert.equal(qualifying,count);assert.equal(sum(shares)+dust,pot);
const planStart=performance.now(),plan=buildPlan('9007199254740993',shares,50);
assert.equal(plan.batches.length,200);let verified=0;
for(const batch of plan.batches)for(let i=0;i<batch.accounts.length;i++){
 assert(StandardMerkleTree.verify(plan.root,['uint256','address','uint256'],[plan.roundId,batch.accounts[i],batch.amounts[i]],batch.proofs[i]));verified++;
}
assert.equal(verified,count);
const result={passed:true,synthetic:true,holders:count,transfers:eventCount,proofsVerified:verified,batches:plan.batches.length,twabMs:Math.round(twabMs),planAndProofVerificationMs:Math.round(performance.now()-planStart),payoutTotal:plan.total,roundingDust:String(dust),heapUsedMiB:Math.round(process.memoryUsage().heapUsed/1024**2)};
fs.mkdirSync('.context/test-results',{recursive:true});fs.writeFileSync('.context/test-results/calculator-stress.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
