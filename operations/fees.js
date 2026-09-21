/** One finite fee cycle. Caller owns signer serialization; receipts are awaited and failed transactions are not blindly retried. */
export async function runFeeCycle({provider,signerAddress,locker,aero,legacy,feeRouter,executor,weth,quote,execute=false,slippageBps=100,onEvent=()=>{}}) {
  const chainId=(await provider.getNetwork()).chainId;
  if(execute&&![31337n,84532n].includes(chainId)) throw Error('production fee execution is disabled');
  if(!Number.isInteger(slippageBps)||slippageBps<0||slippageBps>1000) throw Error('slippage must be 0..1000 basis points');
  const result={mode:execute?'execute':'dry-run',actions:[],awaitingHandoff:[],attention:[],legacyStatus:'absent',swapStatus:'not-evaluated'};
  let confirmedBlock;
  const now=async()=>BigInt((await provider.getBlock('latest')).timestamp);
  async function send(action,call,{optional=false,cooldownRace}={}) {
    const entry={action,status:execute?'submitted':'planned'}; result.actions.push(entry);
    if(!execute) return true;
    let tx;
    try { tx=await call(); }
    catch(error) {
      // Only a gas-estimation revert proves nothing was broadcast. Transport failures and
      // ambiguous send errors must stop the cycle for receipt/nonce reconciliation.
      if(error.code!=='CALL_EXCEPTION'||error.action!=='estimateGas')throw error;
      if(cooldownRace&&await cooldownRace()) {
        entry.status='cooldown-race';entry.reason='another caller already harvested; no transaction was broadcast';
        onEvent({...entry});return false;
      }
      if(!optional)throw error;
      entry.status='skipped';entry.error=error.shortMessage??error.message;
      result.attention.push({action,reason:entry.error});onEvent({...entry});return false;
    }
    entry.hash=tx.hash;onEvent({...entry});
    let receipt;
    try { receipt=await tx.wait(1); }
    catch(error) {
      if(typeof provider.getTransactionReceipt!=='function'||!cooldownRace||!error.receipt||Number(error.receipt.status)!==0)throw error;
      // Re-query the exact transaction: a timeout/replacement/ambiguous broadcast is never skipped.
      const mined=await provider.getTransactionReceipt(tx.hash);
      if(!mined||Number(mined.status)!==0||(mined.hash??mined.transactionHash)?.toLowerCase()!==tx.hash.toLowerCase()
        ||!Number.isSafeInteger(mined.blockNumber))throw error;
      receipt=mined;
    }
    if(receipt&&Number(receipt.status)===0&&cooldownRace&&typeof provider.getTransactionReceipt==='function') {
      const mined=await provider.getTransactionReceipt(tx.hash);
      if(mined&&Number(mined.status)===0&&(mined.hash??mined.transactionHash)?.toLowerCase()===tx.hash.toLowerCase()
        &&Number.isSafeInteger(mined.blockNumber)&&await cooldownRace()) {
        entry.status='reverted';entry.reason='confirmed cooldown race; source already harvested';
        result.attention.push({action,reason:entry.reason});onEvent({...entry});return false;
      }
    }
    if(!receipt||Number(receipt.status)!==1) throw Error(`${action}: failed transaction receipt ${tx.hash}`);
    if(Number.isSafeInteger(receipt.blockNumber))confirmedBlock=Math.max(confirmedBlock??0,receipt.blockNumber);
    entry.status='confirmed';onEvent({...entry});
    return true;
  }
  // Each source needs its own custody handoff before it can collect. Until then it is skipped and
  // reported, so the rest of the cycle still routes and swaps whatever has already arrived. Failing
  // the whole cycle here would force every handoff, including the permanent one, before any fee moves.
  const skip=(name,reason)=>{result.actions.push({action:name,status:'awaiting-handoff',reason});result.awaitingHandoff.push(name);};
  for(const [name,contract,ready,reason] of [['locker',locker,c=>c.ownsLocker(),'LockerHarvester does not own the locker'],['aero',aero,c=>c.holdsPosition(),'Aerodrome harvester has no LP position or claimable fees']]) {
    if(!contract) continue;
    if(!await ready(contract)) {skip(name,reason);continue;}
    const last=BigInt(await contract.lastHarvestAt()),interval=BigInt(await contract.minInterval());
    if(last===0n||await now()>=last+interval) await send(name,()=>contract.harvest(),{cooldownRace:async()=>{
      const block=await provider.getBlock('latest');
      const tag=Number.isSafeInteger(block?.number)?{blockTag:block.number}:{};
      const advanced=BigInt(await contract.lastHarvestAt(tag)),currentInterval=BigInt(await contract.minInterval(tag));
      const timestamp=BigInt(block.timestamp);
      return advanced>last&&advanced<=timestamp&&timestamp<advanced+currentInterval;
    }});
    else result.actions.push({action:name,status:'cooldown'});
  }
  if(legacy) {
    if(!await legacy.isTokenCreator()) {skip('legacy','LegacyFeeHarvester is not the legacy tokenCreator');result.legacyStatus='awaiting-handoff';}
    else {
      const count=Number(await legacy.safeCount());
      if(!Number.isInteger(count)||count<1||count>8) throw Error('invalid legacy safe count');
      let harvested=0;
      for(let i=0;i<count;i++)if(await send(`legacy${i}`,()=>legacy.harvestFrom(i),{optional:true}))harvested++;
      result.legacyStatus=!execute?'planned':harvested===count?'harvested':harvested?'partial':'failed';
    }
  }
  await send('split-dickbutt',()=>feeRouter.splitDickbutt());
  await send('split-weth',()=>feeRouter.splitWeth());
  if(!execute) { result.swapStatus='quote-after-splits'; return result; }
  // A load-balanced RPC can answer "latest" from a node behind the split receipt.
  // Anchor dependent reads to the confirmed split block; a missing block must fail,
  // rather than silently reporting an empty executor and skipping its funded swap.
  const snapshot=confirmedBlock===undefined?{}:{blockTag:confirmedBlock};
  const balance=BigInt(await weth.balanceOf(await executor.getAddress(),snapshot));
  if(balance===0n) {result.swapStatus='empty';return result;}
  if(!await executor.isKeeper(signerAddress,snapshot)) throw Error('swap signer is not an approved keeper');
  const expires=BigInt(await executor.priceFloorExpiresAt(snapshot));
  if(BigInt(await executor.minSpcxcPerWeth(snapshot))===0n||await now()>expires) {result.swapStatus='price-floor-refresh-required';return result;}
  const last=BigInt(await executor.lastSwapAt(snapshot)),interval=BigInt(await executor.minSwapInterval(snapshot));
  if(last!==0n&&await now()<last+interval){result.swapStatus='cooldown';return result;}
  const cap=BigInt(await executor.maxSwapPerCall(snapshot));
  const amount=balance<cap?balance:cap;
  const quoted=BigInt(await quote(amount,snapshot));
  if(quoted<=0n) throw Error('zero quote');
  const minOut=quoted*BigInt(10000-slippageBps)/10000n;
  if(minOut===0n) throw Error('quote rounds to zero minimum');
  const deadline=await now()+120n;
  await send('swap',()=>executor.processWeth(minOut,deadline));
  result.swapStatus='processed';return result;
}
