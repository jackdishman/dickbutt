import {isAddress, ZeroAddress} from 'ethers';
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
export function validateDeployment(config) {
  const errors=[];
  for(const name of ['kcGreen','cdbVault','burnAddress','owner','keeper']) {
    if(!isAddress(config[name]??'')||same(config[name],ZeroAddress)) errors.push(`deployment.${name} must be an explicit nonzero address`);
  }
  // Compare only well-formed addresses; absent ones already reported above and must not read as duplicates.
  const recipients=['kcGreen','cdbVault','burnAddress'].map(k=>config[k]).filter(v=>isAddress(v??'')).map(v=>v.toLowerCase());
  if(new Set(recipients).size!==recipients.length) errors.push('KC Green, CDB and burn recipients must be distinct');
  return errors;
}
/// Pin the two-hop WETH -> USDC -> SPCXc swap path. The executor encodes tick spacings, not pool
/// addresses, so a wrong spacing silently routes through a different (possibly shallow) pool.
export function validateSwapRoute(facts,expected) {
  if(!facts) return ['Swap route pools were not inspected'];
  const errors=[];
  for(const hop of ['wethUsdc','usdcSpcxc']) {
    const discovered=facts[hop],configured=expected[`${hop}Pool`];
    if(!isAddress(configured??'')) {errors.push(`aerodrome.${hop}Pool must be an explicit address`);continue;}
    if(same(discovered,ZeroAddress)) errors.push(`No ${hop} pool exists at the configured tick spacing`);
    else if(!same(discovered,configured)) errors.push(`Configured ${hop}Pool differs from factory discovery at the configured tick spacing`);
    if(BigInt(facts[`${hop}Liquidity`]??0)<=0n) errors.push(`Swap route hop ${hop} has no active liquidity`);
  }
  return errors;
}
export function validatePoolFacts(facts,expected) {
  if(!facts) return ['Rewards pool and funded NFT position have not been configured'];
  const errors=[];
  const pair=[facts.token0,facts.token1];
  if(!expected.tokens.every(t=>pair.some(a=>same(a,t)))) errors.push('Rewards pool token pair mismatch');
  if(!same(facts.factory,expected.factory)||!same(facts.managerFactory,expected.factory)) errors.push('Rewards pool/manager factory mismatch');
  if(Number(facts.fee)!==expected.swapFee) errors.push(`Current swap fee must be ${expected.swapFee} (0.3%), observed ${facts.fee}`);
  if(Number(facts.tickSpacing)!==expected.tickSpacing) errors.push('Rewards pool tick spacing mismatch');
  if(BigInt(facts.liquidity??0)<=0n) errors.push('Rewards pool has no active liquidity');
  if(BigInt(facts.positionLiquidity??0)<=0n) errors.push('Configured NFT has no liquidity');
  if(!same(facts.positionToken0,facts.token0)||!same(facts.positionToken1,facts.token1)||Number(facts.positionTickSpacing)!==Number(facts.tickSpacing)) errors.push('NFT does not belong to the configured pool');
  const bound=Math.floor(887272/expected.tickSpacing)*expected.tickSpacing;
  if(Number(facts.tickLower)!==-bound||Number(facts.tickUpper)!==bound) errors.push('NFT is not full range');
  if(Number(facts.unstakedFee)!==0) errors.push(`Unstaked fee is ${facts.unstakedFee}; confirm economics before accepting this position`);
  return errors;
}
