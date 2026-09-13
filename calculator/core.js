import { ethers } from 'ethers';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
export const normalize = a => ethers.getAddress(a.toLowerCase()).toLowerCase();
export const sum = o => Object.values(o).reduce((s,v)=>s+BigInt(v),0n);
export function amounts(o={}) { const out={}; for(const [a,v] of Object.entries(o)){const k=normalize(a);if(out[k]!==undefined)throw Error('duplicate normalized address');out[k]=BigInt(v);if(out[k]<0n)throw Error('negative amount');}return out; }
export function bigIntSqrt(n){if(n<0n)throw Error('negative sqrt');if(n<2n)return n;let x=n,y=(x+1n)/2n;while(y<x){x=y;y=(x+n/x)/2n;}return x;}
export function computeTWAB(start,transfers,timestamps,startTs,endTs,excluded=[]){
 const balances=amounts(start),weighted={},last={},deny=new Set([ethers.ZeroAddress,...excluded.map(normalize)]);startTs=BigInt(startTs);endTs=BigInt(endTs);if(endTs<=startTs)throw Error('period has no duration');
 const touch=(a,t)=>{const prev=last[a]??startTs;if(t<prev||t>endTs||t<startTs)throw Error('invalid event timestamp order');if(!deny.has(a))weighted[a]=(weighted[a]??0n)+(balances[a]??0n)*(t-prev);last[a]=t;};
 const events=[...transfers].sort((a,b)=>a.blockNumber-b.blockNumber||(a.index??a.logIndex??0)-(b.index??b.logIndex??0));
 for(const ev of events){const from=normalize(ev.args.from),to=normalize(ev.args.to),value=BigInt(ev.args.value),ts=timestamps.get(ev.blockNumber);if(ts===undefined)throw Error('missing timestamp');if(value<0n)throw Error('negative transfer');touch(from,BigInt(ts));if(from!==to)touch(to,BigInt(ts));if(from!==ethers.ZeroAddress){if((balances[from]??0n)<value)throw Error('transfer exceeds balance');balances[from]=(balances[from]??0n)-value;}if(to!==ethers.ZeroAddress)balances[to]=(balances[to]??0n)+value;}
 for(const a of new Set([...Object.keys(balances),...Object.keys(last)]))touch(a,endTs);
 return {twab:Object.fromEntries(Object.entries(weighted).map(([a,n])=>[a,n/(endTs-startTs)])),endingBalances:balances};
}
export function computeShares(twab,threshold,pot,curve){
 if(!['sqrt','linear'].includes(curve))throw Error('WEIGHTING must be sqrt or linear');if(threshold<0n||pot<0n)throw Error('negative threshold/pot');const rows=Object.entries(amounts(twab)).filter(([,v])=>v>=threshold),weights=rows.map(([a,v])=>[a,curve==='sqrt'?bigIntSqrt(v):v]),total=sum(Object.fromEntries(weights)),shares={};if(total)for(const[a,w]of weights){const v=w*pot/total;if(v)shares[a]=v;}return {shares,qualifying:rows.length,dust:pot-sum(shares)};
}
export function buildPlan(roundId,payouts,batchSize){
 // No default: 250 was the old contract comment's unsupported figure, and 256 native recipients
 // already measured 14.66M execution gas against Base's 16,777,216 per-transaction cap. A config
 // that forgets batchSize must fail here, not silently build batches that cannot be mined.
 if(!Number.isSafeInteger(batchSize)||batchSize<1)throw Error('invalid batch size: set batchSize explicitly from measured gas');roundId=BigInt(roundId).toString();const total=sum(payouts);if(!total)return null;
 const tree=StandardMerkleTree.of(Object.entries(amounts(payouts)).sort(([a],[b])=>a.localeCompare(b)).map(([a,v])=>[roundId,a,v.toString()]),['uint256','address','uint256']);const recipients=[...tree.entries()].map(([i,v])=>({account:v[1],amount:v[2],proof:tree.getProof(i)})),batches=[];for(let i=0;i<recipients.length;i+=batchSize){const rows=recipients.slice(i,i+batchSize);batches.push({roundId,accounts:rows.map(r=>r.account),amounts:rows.map(r=>r.amount),proofs:rows.map(r=>r.proof)});}return {roundId,root:tree.root,total:total.toString(),payouts,tree:tree.dump(),batches};
}
