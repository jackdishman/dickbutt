import test from 'node:test';
import assert from 'node:assert/strict';
import {cappedPayouts, sum} from '../../calculator/core.js';
import {JOBS,validateSchedule} from '../../operations/schedule.js';
const address=n=>'0x'+BigInt(n).toString(16).padStart(40,'0');
test('Capped allocation: 5000 deterministic portfolios conserve every account credit and exact budget',()=>{
 let seed=0x12345678n;
 const random=()=>{seed=(1664525n*seed+1013904223n)%4294967296n;return seed;};
 for(let run=0;run<5000;run++){
  const values={};const count=Number(random()%40n)+1;
  for(let i=1;i<=count;i++)values[address(i)]=random()**3n;
  const saved={...values},threshold=random()**3n,cap=random()**3n;
  const {payouts,accrued}=cappedPayouts(values,threshold,cap);
  const eligible=Object.entries(values).filter(([,v])=>v>0n&&v>=threshold);
  const total=sum(Object.fromEntries(eligible)),budget=cap<total?cap:total;
  assert.deepEqual(values,saved);assert.equal(sum(payouts),budget);
  assert.equal(sum(payouts)+sum(accrued),sum(values));
  for(const [a,v]of Object.entries(values)){
   const paid=payouts[a]??0n;assert.ok(paid>=0n&&paid<=v);
   assert.equal(paid+(accrued[a]??0n),v);
   if(v<threshold)assert.equal(paid,0n);
   if(v>=threshold&&total>cap){const floor=v*cap/total;assert.ok(paid===floor||paid===floor+1n);}
  }
  // Input enumeration cannot favor a holder when the budget is capped.
  if(total>cap){const reversed=cappedPayouts(Object.fromEntries(Object.entries(values).reverse()),threshold,cap);
   assert.deepEqual(reversed.payouts,payouts);assert.deepEqual(reversed.accrued,accrued);}
 }
});
test('Uncapped legacy payout ordering remains byte-for-byte compatible with journal serialization',()=>{
 const values={[address(3)]:100n,[address(2)]:0n,[address(1)]:40n};
 const expected={[address(3)]:100n,[address(1)]:40n};
 const encode=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x);
 assert.equal(encode(cappedPayouts(values,1n,140n).payouts),encode(expected));
 assert.deepEqual(cappedPayouts(values,1n,0n),{payouts:{},accrued:values});
 assert.throws(()=>cappedPayouts(values,-1n,1n),/negative/);
 assert.throws(()=>cappedPayouts(values,1n,-1n),/negative/);
});
test('Proposal retries cannot be removed, slowed or moved to a second signing host',()=>{
 for(const override of [null,{everySeconds:120},{host:'keeper'},{key:'KEEPER_PRIVATE_KEY'}]){
  const jobs=JOBS.flatMap(j=>j.name==='propose-pending'?(override?[{...j,...override}]:[]):[j]);
  assert.ok(validateSchedule(jobs).some(e=>e.includes('propose-pending')));
 }
});
