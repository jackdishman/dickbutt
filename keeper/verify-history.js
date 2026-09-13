import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Contract } from 'ethers';
import { runCalculator } from '../calculator/engine.js';
import { ERC20_ABI, DISTRIBUTOR_ABI, selectBoundary } from '../calculator/chain.js';
import { hash } from '../calculator/journal.js';

/** Rebuild each period from chain data and a separately reviewed configuration.
 * Journal hashes establish consistency, not whether its proposed recipients held DICK.
 * No journal-supplied balance, share, reserve or payout is used as calculation input.
 * Full replay is deliberately conservative; a future incremental cache must remain under
 * the keeper host's control and must not be replaced by the proposer-host journal sync.
 */
export async function verifyPayoutHistory({rows,config,provider,
  token=new Contract(config.token,ERC20_ABI,provider),
  distributor=new Contract(config.distributor,DISTRIBUTOR_ABI,provider),
  rewardTokenFactory=address=>new Contract(address,ERC20_ABI,provider)}) {
  const finality=await selectBoundary(provider,config.finalityTag);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dickbutt-verified-periods-'));
  try {
    for(const {record} of rows) {
      if(record.block.number>finality.number)throw Error('journal period is beyond the selected finality boundary');
      const boundary=await provider.getBlock(record.block.number);
      if(!boundary||boundary.hash!==record.block.hash)throw Error('journal snapshot hash changed');
      // Every contract read and event scan inside runCalculator is pinned to this exact block.
      const snapshotProvider={getBlock:tag=>tag===config.finalityTag?Promise.resolve(boundary):provider.getBlock(tag)};
      const rebuilt=await runCalculator({dir,provider:snapshotProvider,token,distributor,config,
        bootstrap:record.bootstrap===true,rewardTokenFactory});
      if(hash(rebuilt)!==hash(record)){
        const changed=[...new Set([...Object.keys(rebuilt),...Object.keys(record)])].filter(key=>hash({value:rebuilt[key]})!==hash({value:record[key]}));
        throw Error(`independent payout calculation mismatch at block ${record.block.number} (${changed.join(', ')}); no transaction authorized`);
      }
    }
    return {periods:rows.length,finalizedThrough:finality.number};
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
