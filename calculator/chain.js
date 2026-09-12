import {ethers} from 'ethers';import {amounts,normalize,sum} from './core.js';
export const ERC20_ABI=['event Transfer(address indexed from,address indexed to,uint256 value)','function decimals() view returns(uint8)'];
export const DISTRIBUTOR_ABI=['event Paid(uint256 indexed roundId,address indexed account,uint256 amount)','function nextRoundId() view returns(uint256)','function availableForNextRound() view returns(uint256)','function maxProposableTotal() view returns(uint256)','function minPayout() view returns(uint256)','function rewardToken() view returns(address)','function roundInfo(uint256) view returns(bytes32,uint256,uint256,bool,bool)','function pending(uint256) view returns(bytes32,uint256,uint256)'];
export async function selectBoundary(provider,tag='finalized'){if(!['finalized','safe'].includes(tag))throw Error('FINALITY_TAG must be finalized or safe');const block=await provider.getBlock(tag);if(!block||!block.hash||!Number.isSafeInteger(block.number))throw Error(`${tag} block unavailable; refusing fallback`);return block;}
export async function scanEvents(contract,filter,from,to,chunk=2000){if(!Number.isSafeInteger(chunk)||chunk<1)throw Error('invalid scan chunk');const out=[];for(let start=from;start<=to;start+=chunk){const end=Math.min(start+chunk-1,to);const rows=await contract.queryFilter(filter,start,end);for(const row of rows){if(row.removed||row.blockNumber<start||row.blockNumber>end)throw Error('event outside snapshot');out.push(row);}}return out;}
export async function reconcile(distributor,state,block,chunk=2000){
 const accrued=amounts(state.accrued),plans=structuredClone(state.plans??{}),recredits={};let localReserved=0n;
 for(const plan of Object.values(plans)){
 if(plan.settled)continue;
 const [root,total,distributed,active,closed]=await distributor.roundInfo(plan.roundId,{blockTag:block});
 if(root===ethers.ZeroHash&&BigInt(total)===0n&&!active&&!closed){
   if (typeof distributor.pending === 'function') {
     const [pendingRoot,pendingTotal] = await distributor.pending(plan.roundId,{blockTag:block});
     if (pendingRoot !== ethers.ZeroHash || BigInt(pendingTotal) !== 0n) {
       if (pendingRoot.toLowerCase()!==plan.root.toLowerCase() || BigInt(pendingTotal)!==BigInt(plan.total)) throw Error(`round ${plan.roundId} commitment mismatch`);
       continue;
     }
   }
   localReserved+=BigInt(plan.total);continue;
 }
 if(root.toLowerCase()!==plan.root.toLowerCase()||BigInt(total)!==BigInt(plan.total))throw Error(`round ${plan.roundId} commitment mismatch`);
 if(active&&closed)throw Error('invalid round status');if(!closed)continue;
 const paid=new Set();let paidTotal=0n;for(const ev of await scanEvents(distributor,distributor.filters.Paid(plan.roundId),plan.toBlock,block,chunk)){const a=normalize(ev.args.account),v=BigInt(ev.args.amount);if(paid.has(a)||plan.payouts[a]===undefined||BigInt(plan.payouts[a])!==v)throw Error('invalid payment event');paid.add(a);paidTotal+=v;}
 if(paidTotal!==BigInt(distributed))throw Error('payment total mismatch');
 for(const[a,v]of Object.entries(plan.payouts)){if(!paid.has(a)){accrued[a]=(accrued[a]??0n)+BigInt(v);recredits[a]=(recredits[a]??0n)+BigInt(v);}}plan.settled=true;plan.settledAt=block;
 }
 state.accrued=accrued;state.plans=plans;return {localReserved,recredits};
}
