import { Contract, isAddress, ZeroAddress } from 'ethers';

// Old rehearsal manifests omitted the kind and always deployed the NFT adapter.
// New production manifests must record it; an unknown value never guesses an ABI.
export function rewardsPoolKind(pool = {}) {
  const kind = pool.kind ?? 'slipstream';
  if (!['vamm', 'slipstream'].includes(kind)) throw Error(`unsupported rewards pool kind: ${kind}`);
  return kind;
}

export function aerodromeHarvesterName(pool) {
  return rewardsPoolKind(pool) === 'vamm' ? 'AerodromeVammHarvester' : 'AerodromeFeeHarvester';
}

/** Fail before any fee-cycle write if the recorded vAMM custody or recipients differ. */
export async function verifyAerodromeRuntime(aero, manifest) {
  if (!aero || rewardsPoolKind({kind:manifest.sources?.aerodromeKind}) !== 'vamm') return;
  const fields = [
    ['pool',manifest.sources?.rewardsPool], ['factory',manifest.sources?.rewardsFactory],
    ['dickbutt',manifest.contracts?.dickbutt], ['spcxc',manifest.contracts?.spcxc],
    ['spcxcDestination',manifest.contracts?.distributor], ['burnAddress',manifest.roles?.burnAddress],
  ];
  for (const [getter, expected] of fields) {
    if (!isAddress(expected ?? '') || expected.toLowerCase() === ZeroAddress) throw Error(`vAMM manifest must record ${getter}`);
    if ((await aero[getter]()).toLowerCase() !== expected.toLowerCase()) throw Error(`deployed vAMM ${getter} differs from config`);
  }
}

export function validateRewardPoolConfig(pool = {}) {
  const kind = rewardsPoolKind(pool), errors = [];
  for (const key of kind === 'vamm' ? ['pool', 'factory', 'lpOwner'] : ['pool', 'factory', 'manager']) {
    if (!isAddress(pool[key] ?? '') || pool[key].toLowerCase() === ZeroAddress) errors.push(`rewardsPool.${key} must be an explicit nonzero address`);
  }
  if (kind === 'vamm') {
    if (pool.stable !== false) errors.push('rewardsPool.stable must be false for basic volatile vAMM');
    if (pool.staking !== 'unstaked') errors.push('vAMM LP tokens must remain unstaked in the harvester');
    if (!Number.isInteger(pool.swapFeeBps) || pool.swapFeeBps < 0 || pool.swapFeeBps > 300) errors.push('rewardsPool.swapFeeBps must record the expected fee in basis points (0..300)');
  } else if (!/^[0-9]+$/.test(String(pool.tokenId ?? ''))) errors.push('rewardsPool.tokenId must record the position NFT');
  return errors;
}

/** Both deployment and preflight inspect the same facts at one explicit finalized block. */
export async function inspectRewardPool(provider, config, blockTag) {
  const desired = config.rewardsPool ?? {}, kind = rewardsPoolKind(desired), tag = { blockTag };
  const errors = validateRewardPoolConfig(desired);
  if (errors.length) return { kind, facts: null, errors };
  const pool = new Contract(desired.pool, [
    'function token0() view returns(address)', 'function token1() view returns(address)',
    'function factory() view returns(address)', 'function stable() view returns(bool)',
    'function totalSupply() view returns(uint256)', 'function balanceOf(address) view returns(uint256)',
    'function getReserves() view returns(uint256,uint256,uint256)',
    'function fee() view returns(uint24)', 'function tickSpacing() view returns(int24)',
    'function liquidity() view returns(uint128)',
  ], provider);
  const facts = { token0: await pool.token0(tag), token1: await pool.token1(tag), factory: await pool.factory(tag) };
  if (kind === 'vamm') {
    const factory = new Contract(desired.factory, [
      'function getPool(address,address,bool) view returns(address)', 'function isPool(address) view returns(bool)',
      'function getFee(address,bool) view returns(uint256)', 'function isPaused() view returns(bool)',
    ], provider);
    const reserves = await pool.getReserves(tag);
    Object.assign(facts, {
      discoveredPool: await factory.getPool(config.dickbutt, config.spcxc, false, tag),
      registered: await factory.isPool(desired.pool, tag), paused: await factory.isPaused(tag),
      stable: await pool.stable(tag), feeBps: await factory.getFee(desired.pool, false, tag),
      reserve0: reserves[0], reserve1: reserves[1], totalSupply: await pool.totalSupply(tag),
      lpOwner: desired.lpOwner, lpBalance: await pool.balanceOf(desired.lpOwner, tag),
    });
  } else {
    const factory = new Contract(desired.factory, [
      'function getPool(address,address,int24) view returns(address)', 'function getUnstakedFee(address) view returns(uint24)',
    ], provider);
    const manager = new Contract(desired.manager, [
      'function factory() view returns(address)', 'function ownerOf(uint256) view returns(address)',
      'function positions(uint256) view returns(uint96,address,address,address,int24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
    ], provider);
    const pos = await manager.positions(desired.tokenId, tag);
    Object.assign(facts, {
      discoveredPool: await factory.getPool(config.dickbutt, config.spcxc, desired.tickSpacing, tag),
      managerFactory: await manager.factory(tag), fee: await pool.fee(tag), tickSpacing: await pool.tickSpacing(tag),
      liquidity: await pool.liquidity(tag), positionOwner: await manager.ownerOf(desired.tokenId, tag),
      positionToken0: pos[2], positionToken1: pos[3], positionTickSpacing: pos[4],
      tickLower: pos[5], tickUpper: pos[6], positionLiquidity: pos[7], unstakedFee: await factory.getUnstakedFee(desired.pool, tag),
    });
  }
  return { kind, facts, errors };
}
