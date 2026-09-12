/** One finite fee cycle. Caller owns signer serialization; receipts are awaited and failed transactions are not blindly retried. */
export async function runFeeCycle({provider,signerAddress,locker,aero,legacy,feeRouter,executor,weth,quote,execute=false,slippageBps=100,onEvent=()=>{}}) {
  const chainId=(await provider.getNetwork()).chainId;
  if(execute&&![31337n,84532n].includes(chainId)) throw Error('production fee execution is disabled');
  if(!Number.isInteger(slippageBps)||slippageBps<0||slippageBps>1000) throw Error('slippage must be 0..1000 basis points');
  const result={mode:execute?'execute':'dry-run',actions:[],swapStatus:'not-evaluated'};
  const now=async()=>BigInt((await provider.getBlock('latest')).timestamp);
  async function send(action,call) {
    const entry={action,status:execute?'submitted':'planned'}; result.actions.push(entry);
    if(!execute) return;
    const tx=await call();entry.hash=tx.hash;onEvent({...entry});
    const receipt=await tx.wait(1);
    if(!receipt||Number(receipt.status)!==1) throw Error(`${action}: failed transaction receipt ${tx.hash}`);
    entry.status='confirmed';onEvent({...entry});
  }
  for(const [name,contract] of [['locker',locker],['aero',aero]]) {
    if(!contract) continue;
    const last=BigInt(await contract.lastHarvestAt()),interval=BigInt(await contract.minInterval());
    if(last===0n||await now()>=last+interval) await send(name,()=>contract.harvest());
    else result.actions.push({action:name,status:'cooldown'});
  }
  if(legacy) {
    const count=Number(await legacy.safeCount());
    if(!Number.isInteger(count)||count<1||count>8) throw Error('invalid legacy safe count');
    for(let i=0;i<count;i++) await send(`legacy${i}`,()=>legacy.harvestFrom(i));
  }
  await send('split-dickbutt',()=>feeRouter.splitDickbutt());
  await send('split-weth',()=>feeRouter.splitWeth());
  if(!execute) { result.swapStatus='quote-after-splits'; return result; }
  const balance=BigInt(await weth.balanceOf(await executor.getAddress()));
  if(balance===0n) {result.swapStatus='empty';return result;}
  if(!await executor.isKeeper(signerAddress)) throw Error('swap signer is not an approved keeper');
  const expires=BigInt(await executor.priceFloorExpiresAt());
  if(BigInt(await executor.minSpcxcPerWeth())===0n||await now()>expires) {result.swapStatus='price-floor-refresh-required';return result;}
  const last=BigInt(await executor.lastSwapAt()),interval=BigInt(await executor.minSwapInterval());
  if(last!==0n&&await now()<last+interval){result.swapStatus='cooldown';return result;}
  const cap=BigInt(await executor.maxSwapPerCall());
  const amount=balance<cap?balance:cap;
  const quoted=BigInt(await quote(amount));
  if(quoted<=0n) throw Error('zero quote');
  const minOut=quoted*BigInt(10000-slippageBps)/10000n;
  if(minOut===0n) throw Error('quote rounds to zero minimum');
  const deadline=await now()+120n;
  await send('swap',()=>executor.processWeth(minOut,deadline));
  result.swapStatus='processed';return result;
}
