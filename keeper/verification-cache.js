import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hash, stringify } from '../calculator/journal.js';

// These files define reconstruction and its persisted trust boundary. Any revision
// invalidates old checkpoints, including dependency revisions in the lockfile.
const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
const codeHash=hash(['calculator/engine.js','calculator/core.js','calculator/chain.js',
 'calculator/config.js','calculator/journal.js','keeper/verify-history.js',
 'keeper/verification-cache.js','package.json','package-lock.json']
 .map(file=>[file,fs.readFileSync(path.join(sourceRoot,file),'utf8')]));
const fail=message=>Error(`verification checkpoint: ${message}; stop and perform a reviewed keyless rebuild`);
const within=(a,b)=>{const relative=path.relative(b,a);return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));};
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
 &&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const uid=()=>{if(!process.getuid)throw fail('POSIX file ownership is required');return process.getuid();};

function checkFile(stat) {
 if(!stat.isFile()||stat.uid!==uid()||(stat.mode&0o777)!==0o600||stat.nlink!==1)
  throw fail('file must be a private, singly linked regular file owned by this service account');
}
function checkPath(dir) {
 let current=path.parse(dir).root;
 for(const part of dir.slice(current.length).split(path.sep).filter(Boolean)) {
  current=path.join(current,part);
  const stat=fs.lstatSync(current);
  if(stat.isSymbolicLink()||!stat.isDirectory())throw fail('directory paths must not contain symlinks');
  // A root-owned sticky temporary directory protects its owner-created entries.
  const stickyRoot=stat.uid===0&&(stat.mode&0o1000)!==0;
  if(![0,uid()].includes(stat.uid)||((stat.mode&0o022)!==0&&!stickyRoot))
   throw fail('directory ancestor permits untrusted writes');
 }
 const stat=fs.lstatSync(dir);
 if(stat.uid!==uid()||(stat.mode&0o777)!==0o700)throw fail('directory must be owned by this service account with mode 0700');
 return stat;
}
function syncDir(dir) {const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function readPrivateFile(file) {
 checkFile(fs.lstatSync(file));
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try {
  const stat=fs.fstatSync(fd);checkFile(stat);
  const raw=fs.readFileSync(fd,'utf8');
  return {raw,fingerprint:{dev:stat.dev,ino:stat.ino,hash:hash(raw)}};
 } finally {fs.closeSync(fd);}
}

/** Private service-owned state, never a destination of proposer journal replication.
 * Mode/owner checks do not prove cloud IAM or ACL separation; operators must establish
 * that trust boundary. A checksum is corruption detection, not source authentication.
 */
export function openVerificationCache({dir,journalDir,config}) {
 if(!dir||!journalDir)throw fail('explicit cache and incoming journal paths are required');
 if(config.finalityTag!=='finalized')throw fail('only finalized history may be checkpointed');
 const location=path.resolve(dir),incoming=fs.realpathSync(journalDir);
 if(within(location,incoming)||within(incoming,location))throw fail('cache and incoming journal must be separate, non-overlapping directories');
 // Validate existing ancestors before creating the single final directory.
 if(!fs.existsSync(location)) {
  const parent=path.dirname(location);
  // Parent can be less restrictive than the private cache itself, but must have
  // an established private service directory before automatic cache creation.
  checkPath(parent);
  fs.mkdirSync(location,{mode:0o700});syncDir(parent);
 }
 const identity=checkPath(location),canonical=fs.realpathSync(location);
 if(canonical!==location||within(canonical,incoming)||within(incoming,canonical))throw fail('cache aliases the incoming journal');
 const lock=path.join(location,'.verification-lock'),file=path.join(location,'checkpoint.json');
 try {fs.mkdirSync(lock,{mode:0o700});}catch{throw fail('another verifier or a stale verification lock exists');}
 const lockIdentity=fs.lstatSync(lock);
 let held=true,initialFile;
 const release=()=>{
  if(held) {
   held=false;
   const current=fs.lstatSync(lock);
   if(current.dev!==lockIdentity.dev||current.ino!==lockIdentity.ino)throw fail('verification lock identity changed; inspect it manually');
   fs.rmdirSync(lock);
  }
 };
 const assertUnchanged=()=>{
  const current=checkPath(location);
  if(current.dev!==identity.dev||current.ino!==identity.ino)throw fail('directory changed during verification');
  const entries=fs.readdirSync(location);
  if(entries.some(name=>!['checkpoint.json','.verification-lock'].includes(name)))throw fail('unexpected files or an interrupted write require inspection');
  if(initialFile!==undefined) {
   const currentFile=entries.includes('checkpoint.json')?readPrivateFile(file).fingerprint:null;
   if(hash(currentFile)!==hash(initialFile))throw fail('checkpoint file changed during verification');
  }
 };
 try {
  const binding={schema:1,codeHash,configHash:hash(config),chainId:String(config.chainId),
   token:config.token.toLowerCase(),distributor:config.distributor.toLowerCase()};
  assertUnchanged();
  let saved=null;
  if(fs.readdirSync(location).includes('checkpoint.json')) {
   const stored=readPrivateFile(file);initialFile=stored.fingerprint;
   try {saved=JSON.parse(stored.raw);}
   catch {throw fail('stored checkpoint is unreadable or malformed');}
   if(!exactKeys(saved,['binding','anchor','state','rewardToken','checksum']))throw fail('invalid document schema');
   const {checksum,...payload}=saved;
   if(checksum!==hash(payload)||hash(payload.binding)!==hash(binding))throw fail('checksum, code version, or configuration does not match');
   const {anchor,state,rewardToken}=payload;
   if(!exactKeys(anchor,['sequence','rowHash','block','periodEndTs','stateHash'])
      ||!Number.isSafeInteger(anchor.sequence)||anchor.sequence<1||!/^([0-9a-f]{64})$/.test(anchor.rowHash)
      ||!exactKeys(anchor.block,['number','hash','finality'])||anchor.block.finality!=='finalized'
      ||!Number.isSafeInteger(anchor.block.number)||anchor.block.number<0||!/^0x[0-9a-f]{64}$/i.test(anchor.block.hash)
      ||!Number.isSafeInteger(anchor.periodEndTs)||anchor.periodEndTs<0||!/^0x[0-9a-f]{40}$/i.test(rewardToken)
      ||!exactKeys(state,['lastProcessedBlock','balances','accrued','plans','blockHash','configHash',...(config.pruneSettledPlans?['highestPrunedRoundId']:[])])
      ||state.lastProcessedBlock!==anchor.block.number||state.blockHash!==anchor.block.hash
      ||state.configHash!==binding.configHash||hash(state)!==anchor.stateHash)
    throw fail('stored state and anchor disagree');
   saved=payload;
  } else initialFile=null;
  return {saved,release,assertUnchanged,save({anchor,state,rewardToken}) {
   assertUnchanged();
   const payload={binding,anchor,state,rewardToken};
   const document={...payload,checksum:hash(payload)};
   const temporary=path.join(location,`.checkpoint-${randomUUID()}.tmp`);
   let fd;
   try {
    fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,stringify(document));fs.fsyncSync(fd);
    fs.closeSync(fd);fd=undefined;
    fs.renameSync(temporary,file);syncDir(location);
    initialFile=readPrivateFile(file).fingerprint;
   } finally {
    if(fd!==undefined)fs.closeSync(fd);
    if(fs.existsSync(temporary))fs.unlinkSync(temporary);
   }
  }};
 } catch(error) {release();throw error;}
}
