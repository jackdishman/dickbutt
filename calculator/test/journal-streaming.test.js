import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Journal,hash,stringify} from '../journal.js';
import {historyFixture} from './helpers/history-fixture.js';

const record=number=>({fromBlock:number,periodStartTs:number-1,periodEndTs:number,
 startingAccrual:{},newShares:{},payouts:{},endingAccrual:{},
 state:{lastProcessedBlock:number,balances:{},accrued:{},plans:{}}});
const rowFile=(dir,index)=>path.join(dir,'periods',`${String(index).padStart(8,'0')}.json`);
function fixture(t,count=3) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'journal-streaming-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const journal=new Journal(dir);journal.lock();
 try {for(let i=1;i<=count;i++)journal.append(record(i));} finally {journal.unlock();}
 return {dir,journal};
}
function rewrite(dir,mutate) {
 const rows=new Journal(dir).entries();mutate(rows);let previous=null;
 for(const [index,row]of rows.entries()) {
  row.previous=previous;row.hash=hash({previous,record:row.record});previous=row.hash;
  fs.writeFileSync(rowFile(dir,index+1),stringify(row));
 }
}

test('iterate equals entries for legacy and pruning journals without changing serialized bytes',async t=>{
 for(const pruneSettledPlans of [undefined,true]) {
  const f=await historyFixture(t,{pruneSettledPlans});
  for(let i=0;i<4;i++)await f.advance();
  const journal=new Journal(f.dir),before=journal.entries();
  assert.deepEqual([...journal.iterate()],before);
  assert.deepEqual(journal.rebuild(),before.at(-1).record.state);
  for(const [index,row]of before.entries())assert.equal(fs.readFileSync(rowFile(f.dir,index+1),'utf8'),stringify(row));
 }
});

test('iterator reads and validates only one requested period at a time',t=>{
 const {dir,journal}=fixture(t),read=fs.readFileSync,reads=[];
 fs.readFileSync=function(file,...args) {
  if(typeof file==='string'&&file.startsWith(journal.periods+path.sep))reads.push(path.basename(file));
  return read.call(this,file,...args);
 };
 try {
  const iterator=journal.iterate();assert.deepEqual(reads,[]);
  assert.equal(iterator.next().value.record.state.lastProcessedBlock,1);
  assert.deepEqual(reads,['00000001.json']);
  assert.equal(iterator.next().value.record.state.lastProcessedBlock,2);
  assert.deepEqual(reads,['00000001.json','00000002.json']);
  iterator.return();assert.equal(reads.length,2);
 } finally {fs.readFileSync=read;}
 assert.equal(fs.existsSync(rowFile(dir,3)),true);
});

test('entries is the compatibility collector while rebuild and append do not materialize entries',t=>{
 const {dir,journal}=fixture(t),rows=journal.entries();
 let visited=0;const iterate=journal.iterate.bind(journal);
 journal.iterate=function*(){for(const row of iterate()){visited++;yield row;}};
 assert.deepEqual(journal.entries(),rows);assert.equal(visited,3);
 journal.entries=()=>{throw Error('full-array materialization forbidden');};
 visited=0;assert.deepEqual(journal.rebuild(),rows.at(-1).record.state);assert.equal(visited,3);
 journal.lock();
 try {
  visited=0;const next=record(4),expected={previous:rows.at(-1).hash,record:next};expected.hash=hash(expected);
  assert.deepEqual(journal.append(next),expected);assert.equal(visited,3);
  assert.equal(fs.readFileSync(rowFile(dir,4),'utf8'),stringify(expected));
 } finally {journal.unlock();}
});

test('empty history, disposable cache and ignored incomplete files preserve compatibility',t=>{
 const {dir,journal}=fixture(t,0);
 fs.writeFileSync(path.join(journal.periods,'00000001.json.incomplete.tmp'),'broken');
 fs.writeFileSync(path.join(journal.periods,'notes.txt'),'ignored');
 fs.writeFileSync(path.join(dir,'state.json'),'corrupt disposable cache');
 assert.deepEqual([...journal.iterate()],[]);assert.deepEqual(journal.entries(),[]);assert.equal(journal.rebuild(),null);
 journal.lock();
 try {journal.append(record(1));} finally {journal.unlock();}
 assert.equal(journal.rebuild().lastProcessedBlock,1);
 assert.equal(fs.readFileSync(path.join(journal.periods,'00000001.json.incomplete.tmp'),'utf8'),'broken');
});

test('stream consumers reject malformed, gapped, hash, predecessor and continuity failures before append',t=>{
 for(const fault of ['json','gap','hash','predecessor','continuity']) {
  const {dir,journal}=fixture(t),cache=fs.readFileSync(path.join(dir,'state.json'));
  if(fault==='json')fs.writeFileSync(rowFile(dir,3),'{broken');
  if(fault==='gap')fs.unlinkSync(rowFile(dir,2));
  if(fault==='hash'){const row=JSON.parse(fs.readFileSync(rowFile(dir,3)));row.hash='forged';fs.writeFileSync(rowFile(dir,3),stringify(row));}
  if(fault==='predecessor'){const row=JSON.parse(fs.readFileSync(rowFile(dir,3)));row.previous='forged';row.hash=hash({previous:row.previous,record:row.record});fs.writeFileSync(rowFile(dir,3),stringify(row));}
  if(fault==='continuity')rewrite(dir,rows=>{rows[2].record.fromBlock=99;});
  const before=fs.readdirSync(journal.periods).sort();
  assert.throws(()=>[...journal.iterate()],undefined,fault);
  assert.throws(()=>journal.entries(),undefined,fault);
  assert.throws(()=>journal.rebuild(),undefined,fault);
  journal.lock();
  try {assert.throws(()=>journal.append(record(4)),undefined,fault);} finally {journal.unlock();}
  assert.deepEqual(fs.readdirSync(journal.periods).sort(),before,fault);
  assert.deepEqual(fs.readFileSync(path.join(dir,'state.json')),cache,fault);
 }
});

test('a corrupted late period is never yielded and still rejects complete-state recovery',t=>{
 const {dir,journal}=fixture(t);
 const row=JSON.parse(fs.readFileSync(rowFile(dir,3)));row.record.state.lastProcessedBlock=100;
 fs.writeFileSync(rowFile(dir,3),stringify(row));
 const iterator=journal.iterate();
 assert.equal(iterator.next().value.record.state.lastProcessedBlock,1);
 assert.equal(iterator.next().value.record.state.lastProcessedBlock,2);
 assert.throws(()=>iterator.next(),/journal hash mismatch/);
 assert.throws(()=>journal.rebuild(),/journal hash mismatch/);
});

test('consumer mutation cannot bypass continuity validation of the following row',t=>{
 const {dir,journal}=fixture(t,2);
 rewrite(dir,rows=>{rows[1].record.fromBlock=3;});
 const iterator=journal.iterate(),first=iterator.next().value;
 first.record.state.lastProcessedBlock=2;
 assert.throws(()=>iterator.next(),/period continuity mismatch/);
 assert.equal(JSON.parse(fs.readFileSync(rowFile(dir,1))).record.state.lastProcessedBlock,1);
});

test('consumer mutation cannot bypass pruning transitions or invalidate valid successors',async t=>{
 const valid=await historyFixture(t,{pruneSettledPlans:true});await valid.advance();await valid.advance();
 const iterator=new Journal(valid.dir).iterate();iterator.next();
 const second=iterator.next().value;
 second.record.config.pruneSettledPlans=false;second.record.state.plans={};second.record.state.highestPrunedRoundId='999';second.record.periodEndTs=-1;
 assert.equal(iterator.next().value.record.state.lastProcessedBlock,30);
 assert.equal(iterator.next().done,true);
 const forged=await historyFixture(t,{pruneSettledPlans:true});await forged.advance();await forged.advance();
 rewrite(forged.dir,rows=>{rows[2].record.prunedRounds=[];rows[2].record.state.highestPrunedRoundId='0';});
 const hostile=new Journal(forged.dir).iterate();hostile.next();
 hostile.next().value.record.state.plans={};
 assert.throws(()=>hostile.next(),/retained plans differ/);
});

test('streaming preserves pruning-cursor and removal validation before any append',async t=>{
 for(const fault of ['cursor','summary']) {
  const f=await historyFixture(t,{pruneSettledPlans:true});await f.advance();await f.advance();
  rewrite(f.dir,rows=>{
   if(fault==='cursor')rows[2].record.state.highestPrunedRoundId='01';
   else rows[2].record.prunedRounds[0].settledAt--;
  });
  const journal=new Journal(f.dir),cache=fs.readFileSync(path.join(f.dir,'state.json'));
  assert.throws(()=>[...journal.iterate()],/uint256|settlement identity/);
  assert.throws(()=>journal.rebuild(),/uint256|settlement identity/);
  journal.lock();
  try {assert.throws(()=>journal.append(record(4)),/uint256|settlement identity/);} finally {journal.unlock();}
  assert.equal(fs.existsSync(rowFile(f.dir,4)),false);
  assert.deepEqual(fs.readFileSync(path.join(f.dir,'state.json')),cache);
 }
});

test('streamed append keeps durable commit ordering if disposable-cache writing fails',t=>{
 const {dir,journal}=fixture(t),before=[1,2,3].map(index=>fs.readFileSync(rowFile(dir,index)));
 journal.lock();journal.cache=()=>{throw Error('simulated cache failure');};
 try {assert.throws(()=>journal.append(record(4)),/simulated cache failure/);} finally {journal.unlock();}
 for(let i=0;i<before.length;i++)assert.deepEqual(fs.readFileSync(rowFile(dir,i+1)),before[i]);
 const recovered=new Journal(dir);
 assert.equal([...recovered.iterate()].length,4);assert.equal(recovered.rebuild().lastProcessedBlock,4);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'state.json'))).lastProcessedBlock,3);
 recovered.lock();try {recovered.cache(recovered.rebuild());} finally {recovered.unlock();}
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'state.json'))).lastProcessedBlock,4);
});

test('append preserves its existing lock and committed-history validation semantics',t=>{
 const {dir,journal}=fixture(t,1);
 assert.throws(()=>journal.append(record(2)),/writer lock required/);
 // Historically append validates committed predecessors and atomically writes the
 // supplied candidate. Candidate accounting is checked when that row is next read.
 // Streaming must not silently change that API or existing rejection ordering.
 const candidate=record(2);candidate.fromBlock=99;
 journal.lock();try {journal.append(candidate);} finally {journal.unlock();}
 assert.equal(fs.existsSync(rowFile(dir,2)),true);
 assert.throws(()=>journal.rebuild(),/period continuity mismatch/);
});
