import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ZeroHash} from 'ethers';
import {Journal,hash,stringify} from '../../calculator/journal.js';
import {historyFixture,holderA,holderB} from '../../calculator/test/helpers/history-fixture.js';
import {verifyPayoutHistory} from '../verify-history.js';
import {openVerificationCache} from '../verification-cache.js';

async function fixture(t,pruneSettledPlans=true) {
 const f=await historyFixture(t,{pruneSettledPlans});
 await f.advance();await f.advance();
 f.provider.getNetwork=async()=>({chainId:31337n});
 const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'private-verification-test-')));
 t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 f.verificationCacheDir=path.join(parent,'verified');f.journalDir=f.dir;
 f.cacheFile=path.join(f.verificationCacheDir,'checkpoint.json');
 f.transferReads=[];f.paidReads=[];
 const query=f.token.queryFilter,paid=f.distributor.queryFilter;
 f.token.queryFilter=async(...args)=>{f.transferReads.push(args.slice(1));return query(...args);};
 f.distributor.queryFilter=async(...args)=>{f.paidReads.push(args);return paid(...args);};
 f.resetReads=()=>{f.transferReads.length=0;f.paidReads.length=0;};
 f.rows=()=>new Journal(f.dir).entries();
 f.verify=(overrides={})=>verifyPayoutHistory({...f,rows:f.rows(),...overrides});
 f.bytes=()=>fs.readFileSync(f.cacheFile,'utf8');
 return f;
}
function rechain(rows) {
 let previous=null;
 for(const row of rows){row.previous=previous;row.hash=hash({previous,record:row.record});previous=row.hash;}
 return rows;
}
function editCache(f,change,{checksum=true}={}) {
 const document=JSON.parse(f.bytes());change(document);
 if(checksum){const {checksum:_old,...payload}=document;document.checksum=hash(payload);}
 fs.writeFileSync(f.cacheFile,stringify(document));
}

test('cold, unchanged and suffix verification preserve records for legacy and pruning histories',async t=>{
 for(const pruning of [undefined,false,true]) {
  const f=await fixture(t,pruning);
  const full=await f.verify({verificationCacheDir:undefined});
  f.resetReads();
  const cold=await f.verify();
  assert.equal(cold.periods,full.periods);assert.equal(cold.finalizedThrough,full.finalizedThrough);
  assert.deepEqual(cold.checkpoint,{status:'initialized',replayedPeriods:3,verifiedSequence:3});
  assert.deepEqual(f.transferReads,[[1,10],[11,20],[21,30]]);
  const document=JSON.parse(f.bytes());assert.equal(hash(document.state),hash(f.records.at(-1).state));
  assert.equal(fs.statSync(f.cacheFile).mode&0o777,0o600);
  assert.equal(fs.statSync(f.verificationCacheDir).mode&0o777,0o700);
  const before=f.bytes();f.resetReads();
  const warm=await f.verify();
  assert.equal(warm.checkpoint.replayedPeriods,0);assert.deepEqual(f.transferReads,[]);assert.deepEqual(f.paidReads,[]);assert.equal(f.bytes(),before);
  await f.advance();f.resetReads();
  const suffix=await f.verify();
  assert.equal(suffix.checkpoint.replayedPeriods,1);assert.deepEqual(f.transferReads,[[31,40]]);
  assert.ok(f.paidReads.length>0,'retained plans must still reconcile payment history');
  assert.equal(hash(JSON.parse(f.bytes()).state),hash(f.records.at(-1).state));
 }
});

test('partially paid closure is recredited exactly once across checkpoint boundaries',async t=>{
 const f=await historyFixture(t,{pruneSettledPlans:true});
 const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'private-recredits-')));
 t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const verificationCacheDir=path.join(parent,'verified');
 f.provider.getNetwork=async()=>({chainId:31337n});
 const verify=()=>verifyPayoutHistory({...f,journalDir:f.dir,verificationCacheDir,rows:new Journal(f.dir).iterate()});
 const first=await f.advance();await verify();
 const roundInfo=f.distributor.roundInfo,query=f.distributor.queryFilter;
 f.distributor.roundInfo=async(id,options)=>{const result=await roundInfo(id,options);if(String(id)===first.roundId&&result[4])result[2]=BigInt(first.payouts[holderA]);return result;};
 f.distributor.queryFilter=async(id,...args)=>{const result=await query(id,...args);return String(id)===first.roundId?result.filter(e=>e.args.account===holderA):result;};
 const partial=await f.advance();assert.deepEqual(partial.recredits,{[holderB]:25n});await verify();
 const later=await f.advance();assert.deepEqual(later.recredits,{});await verify();
 const checkpoint=JSON.parse(fs.readFileSync(path.join(verificationCacheDir,'checkpoint.json')));
 assert.equal(hash(checkpoint.state),hash(later.state));
});

test('rehashed balances, payouts and pruning changes in a suffix never advance the private anchor',async t=>{
 for(const field of ['balances','payouts','pruning']) {
  const f=await fixture(t);await f.verify();const before=f.bytes();await f.advance();
  const rows=f.rows(),record=rows.at(-1).record;
  if(field==='balances')record.state.balances[holderA]='999999';
  if(field==='payouts')record.payouts[holderA]='999999';
  if(field==='pruning')record.state.highestPrunedRoundId='999999';
  rechain(rows);
  await assert.rejects(f.verify({rows}),/independent payout calculation mismatch/);
  assert.equal(f.bytes(),before);assert.equal(fs.existsSync(path.join(f.verificationCacheDir,'.verification-lock')),false);
 }
});

test('a changed prefix, missing anchor, broken hash chain or empty stream is rejected',async t=>{
 for(const kind of ['prefix','truncated','empty','hash','anchor-position']) {
  const f=await fixture(t);await f.verify();const before=f.bytes();let rows=f.rows();
  if(kind==='prefix'){rows[0].record.state.balances[holderA]='888';rechain(rows);}
  if(kind==='truncated')rows=rows.slice(0,1);
  if(kind==='empty')rows=[];
  if(kind==='hash')rows[1].hash='0'.repeat(64);
  if(kind==='anchor-position'){rows=rows.slice(1);rechain(rows);}
  await assert.rejects(f.verify({rows}),/checkpoint/);assert.equal(f.bytes(),before);
 }
});

test('an EOF exception after a valid suffix cannot persist partial verification',async t=>{
 const f=await fixture(t);await f.verify();const before=f.bytes();await f.advance();
 const failure=Error('incoming snapshot changed at EOF');
 const rows=(function*(){yield* f.rows();throw failure;})();
 await assert.rejects(f.verify({rows}),error=>error===failure);assert.equal(f.bytes(),before);
});

test('checkpoint identity changes require explicit rebuild instead of automatic repair',async t=>{
 for(const kind of ['config','code','schema','extra','negative-block','negative-time','state','checksum','malformed']) {
  const f=await fixture(t);await f.verify();
  let overrides={};
  if(kind==='config')overrides={config:{...f.config,chunkSize:10}};
  else if(kind==='malformed')fs.writeFileSync(f.cacheFile,'{');
  else editCache(f,d=>{
   if(kind==='code')d.binding.codeHash='0'.repeat(64);
   if(kind==='schema')d.binding.schema=900;
   if(kind==='extra')d.anchor.unreviewed=true;
   if(kind==='negative-block')d.anchor.block.number=-1;
   if(kind==='negative-time')d.anchor.periodEndTs=-1;
   if(kind==='state')d.state.lastProcessedBlock++;
   if(kind==='checksum')d.checksum='0'.repeat(64);
  },{checksum:kind!=='checksum'});
  const invalid=f.bytes();f.resetReads();
  await assert.rejects(f.verify(overrides),/checkpoint/);assert.equal(f.bytes(),invalid);assert.deepEqual(f.transferReads,[]);
 }
});

test('wrong chain, reward token, changed anchor time and finality regression reject reuse',async t=>{
 for(const kind of ['chain','reward','timestamp','hash','finality']) {
  const f=await fixture(t);await f.verify();const before=f.bytes(),getBlock=f.provider.getBlock;
  if(kind==='chain')f.provider.getNetwork=async()=>({chainId:8453n});
  if(kind==='reward')f.distributor.rewardToken=async()=>holderA;
  if(kind==='timestamp'||kind==='hash')f.provider.getBlock=async n=>{const block=await getBlock(n);return n===30?{...block,...(kind==='hash'?{hash:ZeroHash}:{timestamp:301})}:block;};
  if(kind==='finality')f.provider.getBlock=async n=>getBlock(n==='finalized'?20:n);
  await assert.rejects(f.verify(),/checkpoint/);assert.equal(f.bytes(),before);
 }
});

test('a reorg during suffix reconstruction is detected before the private checkpoint is saved',async t=>{
 const f=await fixture(t);await f.verify();const before=f.bytes();await f.advance();
 let changed=false;const getBlock=f.provider.getBlock,query=f.token.queryFilter;
 f.provider.getBlock=async n=>{const block=await getBlock(n);return changed&&n===30?{...block,hash:ZeroHash}:block;};
 f.token.queryFilter=async(...args)=>{const logs=await query(...args);changed=true;return logs;};
 await assert.rejects(f.verify(),/checkpoint anchor block identity changed/);assert.equal(f.bytes(),before);
});

test('warm reuse rechecks directory permissions and the loaded checkpoint after awaited reads',async t=>{
 for(const kind of ['permissions','changed-file']) {
  const f=await fixture(t);await f.verify();const read=f.distributor.rewardToken;
  f.distributor.rewardToken=async(...args)=>{
   if(kind==='permissions')fs.chmodSync(f.verificationCacheDir,0o755);
   else fs.writeFileSync(f.cacheFile,f.bytes()+' ');
   return read(...args);
  };
  await assert.rejects(f.verify(),/verification checkpoint/);
  fs.chmodSync(f.verificationCacheDir,0o700);
 }
});

test('unsafe paths, symlinks, file modes and hardlinks are rejected',async t=>{
 for(const kind of ['inside-journal','journal-inside-cache','root-journal','symlink-parent','symlink-file','dangling-file','mode','hardlink','unexpected-file','safe-finality']) {
  const f=await fixture(t);await f.verify();let overrides={};
  if(kind==='inside-journal')overrides={verificationCacheDir:path.join(f.dir,'verified')};
  if(kind==='root-journal')overrides={journalDir:path.parse(f.dir).root};
  if(kind==='journal-inside-cache'){const nested=path.join(f.verificationCacheDir,'incoming');fs.mkdirSync(nested);overrides={journalDir:nested};}
  if(kind==='symlink-parent'){const alias=path.join(path.dirname(f.verificationCacheDir),'alias');fs.symlinkSync(f.verificationCacheDir,alias);overrides={verificationCacheDir:alias};}
  if(kind==='symlink-file'||kind==='dangling-file'){const moved=f.cacheFile+'.saved';fs.renameSync(f.cacheFile,moved);fs.symlinkSync(kind==='symlink-file'?moved:moved+'.missing',f.cacheFile);}
  if(kind==='mode')fs.chmodSync(f.cacheFile,0o644);
  if(kind==='hardlink')fs.linkSync(f.cacheFile,path.join(path.dirname(f.verificationCacheDir),'copy.json'));
  if(kind==='unexpected-file')fs.writeFileSync(path.join(f.verificationCacheDir,'untrusted.json'),'{}');
  if(kind==='safe-finality')overrides={config:{...f.config,finalityTag:'safe'}};
  await assert.rejects(f.verify(overrides),/verification checkpoint/);
 }
});

test('caller mutation of a record or row hash during an awaited read cannot advance the anchor',async t=>{
 for(const target of ['record','row-hash','replace-forgery']) {
  const f=await fixture(t);await f.verify();const before=f.bytes();await f.advance();
  const rows=f.rows(),last=rows.at(-1),original=structuredClone(last.record),getBlock=f.provider.getBlock;
  if(target==='replace-forgery'){last.record.state.balances[holderA]='999';rechain(rows);}
  let changed=false;
  f.provider.getBlock=async n=>{
   if(n===40&&!changed) {
    changed=true;
    if(target==='record')last.record.state.balances[holderA]='1234';
    if(target==='row-hash')last.hash='f'.repeat(64);
    if(target==='replace-forgery'){Object.assign(last.record,original);rechain(rows);}
   }
   return getBlock(n);
  };
  await assert.rejects(f.verify({rows}),/mutated during independent verification/);
  assert.equal(f.bytes(),before);
 }
});

test('overlapping verifiers fail closed and stale locks are never auto-removed',async t=>{
 const f=await fixture(t),handle=openVerificationCache({dir:f.verificationCacheDir,journalDir:f.dir,config:f.config});
 try {await assert.rejects(f.verify(),/verification lock/);assert.equal(fs.existsSync(path.join(f.verificationCacheDir,'.verification-lock')),true);}
 finally {handle.release();}
 fs.mkdirSync(path.join(f.verificationCacheDir,'.verification-lock'));
 await assert.rejects(f.verify(),/verification lock/);
 assert.equal(fs.existsSync(path.join(f.verificationCacheDir,'.verification-lock')),true);
});

test('binding failures release locks and atomic rename failure preserves the old checkpoint',async t=>{
 const f=await fixture(t);
 assert.throws(()=>openVerificationCache({dir:f.verificationCacheDir,journalDir:f.dir,config:{...f.config,token:null}}));
 assert.equal(fs.existsSync(path.join(f.verificationCacheDir,'.verification-lock')),false);
 await f.verify();const before=f.bytes();await f.advance();
 t.mock.method(fs,'renameSync',()=>{throw Error('simulated durable rename failure');});
 await assert.rejects(f.verify(),/simulated durable rename failure/);
 assert.equal(f.bytes(),before);assert.deepEqual(fs.readdirSync(f.verificationCacheDir),['checkpoint.json']);
});

test('interrupted durability steps leave the old or fully verified new checkpoint, never partial JSON',async t=>{
 for(const failureAt of [1,2]) {
  const f=await fixture(t);await f.verify();const before=f.bytes();await f.advance();
  let syncs=0;const sync=fs.fsyncSync;
  t.mock.method(fs,'fsyncSync',fd=>{if(++syncs===failureAt)throw Error('simulated fsync interruption');return sync(fd);});
  await assert.rejects(f.verify(),/simulated fsync interruption/);
  t.mock.restoreAll();
  const saved=JSON.parse(f.bytes());
  assert.equal(saved.anchor.sequence,failureAt===1?3:4);
  if(failureAt===1)assert.equal(f.bytes(),before);
  else assert.equal(hash(saved.state),hash(f.records.at(-1).state));
  assert.deepEqual(fs.readdirSync(f.verificationCacheDir),['checkpoint.json']);
  await f.verify();
 }
});
