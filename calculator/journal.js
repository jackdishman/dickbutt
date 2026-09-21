import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { readPruningPolicy, uint256String } from './config.js';
export const stringify=x=>JSON.stringify(x,(_k,v)=>typeof v==='bigint'?v.toString():v);
export const hash=x=>createHash('sha256').update(stringify(x)).digest('hex');
function syncDir(dir){const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function atomic(file,data,exclusive=false){const tmp=`${file}.${randomUUID()}.tmp`,fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(exclusive){fs.linkSync(tmp,file);fs.unlinkSync(tmp);}else fs.renameSync(tmp,file);syncDir(path.dirname(file));}
// Pruning is a journal format option, not a claim that any round was paid. These local
// checks bind compact removals/cursors to immutable prior plans; independent chain replay
// must still verify closure, payment logs, and every raw unit of recredit before a send.
function validatePruning(r,previous) {
 if(!readPruningPolicy(r.config??{})) {
  if(r.prunedRounds!==undefined||r.state?.highestPrunedRoundId!==undefined)throw Error('pruning state requires explicit configuration');
  return;
 }
 if(previous&&(!readPruningPolicy(previous.config??{})||previous.configHash!==r.configHash))throw Error('pruning configuration changed within journal');
 if(hash(r.config)!==r.configHash||r.state?.configHash!==r.configHash)throw Error('pruning configuration identity mismatch');
 if(r.block?.finality!=='finalized'||!Number.isSafeInteger(r.block?.number))throw Error('pruning record must use finalized history');
 const highest=uint256String(r.state.highestPrunedRoundId,'highestPrunedRoundId');
 let expectedHighest=previous?uint256String(previous.state.highestPrunedRoundId,'previous highestPrunedRoundId'):0n;
 if(!Array.isArray(r.prunedRounds))throw Error('pruning record requires prunedRounds');
 const remaining={...(previous?.state.plans??{})},seen=new Set();
 for(const summary of r.prunedRounds) {
  const id=uint256String(summary.roundId,'pruned round id',{allowZero:false}),prior=remaining[summary.roundId];
  const keys=['roundId','root','settledAt','superseded',...(summary.superseded===true?['foreignRoot']:[])];
  if(Object.keys(summary).length!==keys.length||keys.some(key=>!Object.hasOwn(summary,key)))throw Error('invalid pruned round summary');
  if(seen.has(summary.roundId)||!prior||prior.settled||prior.roundId!==summary.roundId||summary.root!==prior.root)throw Error('pruned round differs from prior retained plan');
  if(summary.settledAt!==r.block.number||typeof summary.superseded!=='boolean')throw Error('invalid pruned settlement identity');
  if(summary.superseded&&(!/^0x[0-9a-f]{64}$/i.test(summary.foreignRoot)||/^0x0{64}$/i.test(summary.foreignRoot)||summary.foreignRoot.toLowerCase()===summary.root.toLowerCase()))throw Error('invalid pruned foreign root');
  seen.add(summary.roundId);delete remaining[summary.roundId];
  if(id>expectedHighest)expectedHighest=id;
 }
 if(highest!==expectedHighest)throw Error('highestPrunedRoundId differs from journal removals');
 if(r.plan) {
  const id=uint256String(r.plan.roundId,'new round id',{allowZero:false});
  if(id<=highest||remaining[r.plan.roundId]||seen.has(r.plan.roundId))throw Error('new plan reuses a retained or pruned round');
  remaining[r.plan.roundId]=r.plan;
 }
 if(hash(remaining)!==hash(r.state.plans))throw Error('retained plans differ from journal pruning transitions');
}
function validate(r,previous){const keys=new Set([...Object.keys(r.startingAccrual||{}),...Object.keys(r.recredits||{}),...Object.keys(r.newShares||{}),...Object.keys(r.payouts||{}),...Object.keys(r.endingAccrual||{})]);for(const a of keys){const expected=BigInt(r.startingAccrual?.[a]||0)+BigInt(r.recredits?.[a]||0)+BigInt(r.newShares?.[a]||0)-BigInt(r.payouts?.[a]||0);if(expected<0n||expected!==BigInt(r.endingAccrual?.[a]||0))throw Error(`accrual replay mismatch for ${a}`);}if(r.plan){const total=Object.values(r.plan.payouts||{}).reduce((s,v)=>s+BigInt(v),0n);if(total!==BigInt(r.plan.total)||r.plan.roundId!==r.roundId||r.plan.root!==r.root)throw Error('plan commitment replay mismatch');}if(previous&&(Number(r.fromBlock)!==Number(previous.state.lastProcessedBlock)+1||Number(r.periodStartTs)!==Number(previous.periodEndTs)))throw Error('period continuity mismatch');validatePruning(r,previous);}
export class Journal{constructor(dir){this.dir=path.resolve(dir);this.periods=path.join(this.dir,'periods');this.lockPath=path.join(this.dir,'.writer-lock');this.held=false;}lock(){fs.mkdirSync(this.periods,{recursive:true});try{fs.mkdirSync(this.lockPath);}catch(e){throw Error(`writer lock exists at ${this.lockPath}; verify recorded owner is stopped before removing stale lock`,{cause:e});}this.held=true;fs.writeFileSync(path.join(this.lockPath,'owner.json'),stringify({pid:process.pid,host:os.hostname(),started:new Date().toISOString()}));}unlock(){if(this.held){fs.rmSync(this.lockPath,{recursive:true});this.held=false;}}entries(){let previous=null,previousRecord=null;return fs.readdirSync(this.periods).filter(f=>/^\d{8}\.json$/.test(f)).sort().map((file,i)=>{if(file!==`${String(i+1).padStart(8,'0')}.json`)throw Error('journal sequence gap');const row=JSON.parse(fs.readFileSync(path.join(this.periods,file),'utf8'));if(row.previous!==previous||hash({previous:row.previous,record:row.record})!==row.hash)throw Error('journal hash mismatch');validate(row.record,previousRecord);previous=row.hash;previousRecord=row.record;return row;});}rebuild(){const rows=this.entries();return rows.at(-1)?.record.state??null;}append(record){if(!this.held)throw Error('writer lock required');const rows=this.entries(),row={previous:rows.at(-1)?.hash??null,record};row.hash=hash(row);atomic(path.join(this.periods,`${String(rows.length+1).padStart(8,'0')}.json`),stringify(row),true);this.cache(record.state);return row;}cache(state){if(!this.held)throw Error('writer lock required');atomic(path.join(this.dir,'state.json'),stringify(state));}}
