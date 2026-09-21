import { Contract } from 'ethers';
import { runCalculatorFromState } from '../calculator/engine.js';
import { ERC20_ABI, DISTRIBUTOR_ABI, selectBoundary } from '../calculator/chain.js';
import { hash } from '../calculator/journal.js';
import { openVerificationCache } from './verification-cache.js';

/** Rebuild each period from chain data and a separately reviewed configuration.
 * Journal hashes establish consistency, not whether its proposed recipients held DICK.
 * No journal-supplied balance, share, reserve or payout is used as calculation input.
 * Rows may be a one-use synchronous iterator; consume each only after verifying its predecessor.
 * Full replay remains the default. An explicitly enabled private checkpoint is owned by
 * this verifier's service account and must never be writable by proposer journal sync.
 */
export async function verifyPayoutHistory({rows,config,provider,verificationCacheDir,journalDir,
  token=new Contract(config.token,ERC20_ABI,provider),
  distributor=new Contract(config.distributor,DISTRIBUTOR_ABI,provider),
  rewardTokenFactory=address=>new Contract(address,ERC20_ABI,provider)}) {
  let cache;
  try {
    if(verificationCacheDir) {
      if(String((await provider.getNetwork()).chainId)!==String(config.chainId))throw Error('checkpoint RPC chain does not match calculator config');
      cache=openVerificationCache({dir:verificationCacheDir,journalDir,config});
    }
    const finality=await selectBoundary(provider,config.finalityTag),saved=cache?.saved;
    async function checkAnchor(anchor) {
      if(anchor.block.number>finality.number)throw Error('checkpoint anchor is beyond the selected finality boundary');
      const block=await provider.getBlock(anchor.block.number);
      if(!block||block.number!==anchor.block.number||block.hash!==anchor.block.hash||block.timestamp!==anchor.periodEndTs)
        throw Error('checkpoint anchor block identity changed');
    }
    if(saved)await checkAnchor(saved.anchor);
    let periods=0,replayed=0,state=saved?.state,previous=null,lastAnchor=null,rewardToken=saved?.rewardToken,foundAnchor=!saved;
    for(const row of rows) {
      const {record}=row;
      // Caller-owned iterables may retain these objects. Pin identity and scalar
      // inputs before any await; later mutations must not select a different record.
      const recordHash=hash(record),rowHash=row.hash,rowPrevious=row.previous;
      const blockNumber=record.block.number,blockHash=record.block.hash,bootstrap=record.bootstrap===true;
      periods++;
      if(cache) {
        if(row.previous!==previous||row.hash!==hash({previous:row.previous,record}))throw Error('checkpoint input journal hash chain mismatch');
        previous=row.hash;
        if(record.version!==1||hash(record.config)!==hash(config)||record.configHash!==hash(config))throw Error('checkpoint input configuration mismatch');
      }
      if(saved&&periods<=saved.anchor.sequence) {
        if(periods===saved.anchor.sequence) {
          if(row.hash!==saved.anchor.rowHash||hash(record.state)!==saved.anchor.stateHash
             ||hash(record.block)!==hash(saved.anchor.block)||record.periodEndTs!==saved.anchor.periodEndTs
             ||record.rewardToken.toLowerCase()!==saved.rewardToken)
            throw Error('checkpoint incoming prefix differs from the independently verified anchor');
          foundAnchor=true;lastAnchor=saved.anchor;
        }
        continue;
      }
      if(blockNumber>finality.number)throw Error('journal period is beyond the selected finality boundary');
      const boundary=await provider.getBlock(blockNumber);
      if(!boundary||boundary.hash!==blockHash)throw Error('journal snapshot hash changed');
      // Every contract read and event scan inside runCalculator is pinned to this exact block.
      const snapshotProvider={getBlock:tag=>tag===config.finalityTag?Promise.resolve(boundary):provider.getBlock(tag)};
      const rebuilt=await runCalculatorFromState({startingState:state,provider:snapshotProvider,token,distributor,config,
        bootstrap,rewardTokenFactory});
      if(hash(record)!==recordHash||row.hash!==rowHash||row.previous!==rowPrevious)throw Error('journal row mutated during independent verification');
      if(hash(rebuilt)!==recordHash){
        const changed=[...new Set([...Object.keys(rebuilt),...Object.keys(record)])].filter(key=>hash({value:rebuilt[key]})!==hash({value:record[key]}));
        throw Error(`independent payout calculation mismatch at block ${record.block.number} (${changed.join(', ')}); no transaction authorized`);
      }
      // Only our independently reconstructed state is carried forward or persisted.
      state=rebuilt.state;replayed++;
      if(cache) {
        const address=rebuilt.rewardToken.toLowerCase();
        if(rewardToken&&address!==rewardToken)throw Error('checkpoint reward token changed');
        rewardToken=address;
        lastAnchor={sequence:periods,rowHash,block:rebuilt.block,periodEndTs:rebuilt.periodEndTs,stateHash:hash(state)};
      }
    }
    if(cache) {
      if(!foundAnchor||!lastAnchor)throw Error('checkpoint input journal is empty or truncated before its anchor');
      // Exhausting the iterator is essential: its final step can reject an appended
      // or truncated journal. No private anchor is advanced on a partial replay.
      const after=await selectBoundary(provider,config.finalityTag);
      if(after.number<finality.number)throw Error('checkpoint finality regressed during verification');
      const original=await provider.getBlock(finality.number);
      if(!original||original.hash!==finality.hash||original.timestamp!==finality.timestamp)throw Error('checkpoint finalized boundary changed during verification');
      if(saved)await checkAnchor(saved.anchor);
      await checkAnchor(lastAnchor);
      if(String((await provider.getNetwork()).chainId)!==String(config.chainId))throw Error('checkpoint RPC chain changed during verification');
      if((await distributor.rewardToken({blockTag:after.number})).toLowerCase()!==rewardToken)throw Error('checkpoint current reward token mismatch');
      if(replayed)cache.save({anchor:lastAnchor,state,rewardToken});
      else cache.assertUnchanged();
      return {periods,finalizedThrough:finality.number,checkpoint:{status:saved?'reused':'initialized',replayedPeriods:replayed,verifiedSequence:periods}};
    }
    return {periods,finalizedThrough:finality.number};
  } finally {cache?.release();}
}
