/**
 * Production deployment inputs, validated before a single Base mainnet transaction is signed.
 *
 * Kept apart from script/deploy-mainnet.mjs so every rule here is exercised without a chain. The
 * split matters more here than it did on Sepolia: a wrong constructor argument on mainnet is not a
 * redeploy, it is an immutable Split paying a wrong recipient forever.
 *
 * Nothing in this file has a default. Sepolia could afford invented test magnitudes; a production
 * floor bound, swap cap or permanent unlock time is somebody's decision, and a script that guesses
 * one is worse than a script that refuses to run.
 */
import { isAddress, ZeroAddress, MaxUint256 } from 'ethers';
import { buildCalculatorConfig } from './deployment.js';
import { aerodromeHarvesterName, rewardsPoolKind, validateRewardPoolConfig } from './aerodrome.js';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export const MAINNET = 8453;

/**
 * Every production magnitude the contracts need, with the reason it cannot be defaulted. `kind`
 * drives validation: `uint` is a decimal string because these exceed Number.MAX_SAFE_INTEGER.
 */
export const PARAMETERS = [
  { key: 'dickbuttDeployBlock', kind: 'block',
    why: 'The calculator scans Transfer events from here. Too late silently drops holder history; too early wastes an archive scan.' },
  { key: 'holderThresholdRaw', kind: 'uint',
    why: 'Minimum DICKBUTT to qualify, in wei. Documented as 6.9M, but it sets who gets paid, so it is stated not assumed.' },
  { key: 'payoutThresholdRaw', kind: 'uint',
    why: 'Minimum SPCXc a recipient must earn to be included, in SPCXc raw units (8 decimals).' },
  { key: 'minPayoutRaw', kind: 'uint',
    why: 'Calculator payout guidance stored in the distributor. Committed payouts are not filtered on-chain.' },
  { key: 'batchSize', kind: 'count',
    why: 'Recipients per distributeBatch call. The 3,000-holder fork supports estimating 200 per batch; the conservative 256-recipient envelope exceeds Base’s 16,777,216 gas cap. Estimate exact production calldata.' },
  { key: 'chunkSize', kind: 'count',
    why: 'Event scan window. A production RPC will reject a range it considers too wide.' },
  { key: 'curve', kind: 'curve',
    why: 'linear or sqrt. Square-root allocation is Sybilable; this is an economics decision, never a default.' },
  { key: 'maxSwapPerCallWei', kind: 'uint',
    why: 'Executor cap per swap, in WETH wei. Bounds the damage a compromised keeper can do to the swap price.' },
  { key: 'minSwapIntervalSeconds', kind: 'count',
    why: 'Executor rate limit between swaps.' },
  { key: 'floorLowerBoundRaw', kind: 'uint',
    why: 'SPCXc per WETH below which the owner would rather swaps halt than execute. The floor setter can never go under it.' },
  { key: 'lockerMinIntervalSeconds', kind: 'count',
    why: 'Anti-spam gap between permissionless locker harvests. Contract rejects more than 30 days.' },
  { key: 'aerodromeMinIntervalSeconds', kind: 'count',
    why: 'Anti-spam gap between permissionless Aerodrome harvests. Contract rejects more than 30 days.' },
  { key: 'aerodromeUnlockTime', kind: 'timestamp',
    why: 'Unix time before which the harvester will not release its LP position. Constructor requires it in the future and within 100 years.' },
];

/**
 * Argument parsing. `--execute` is the only thing that turns this from a report into transactions,
 * and it is separate from `--force` on purpose: overwriting a manifest and signing on mainnet are
 * different mistakes and should not share a flag.
 */
export function parseMainnetArgs(args) {
  const o = { out: 'config/deployment-base-mainnet.json', force: false, resume: false, execute: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--force') o.force = true;
    else if (arg === '--resume') o.resume = true;
    else if (arg === '--execute') o.execute = true;
    else if (arg === '--help') o.help = true;
    else if (arg === '--params' || arg === '--out' || arg === '--config') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Error(`missing value for ${arg}`);
      o[arg.slice(2)] = value;
    } else throw Error(`unknown deploy option: ${arg.startsWith('--') ? arg : 'positional argument'}`);
  }
  if (o.help) return o;
  if (!o.params) throw Error('--params is required: production magnitudes are never defaulted');
  if (o.resume && !o.execute) throw Error('--resume continues a real deployment and requires --execute');
  return o;
}

const THIRTY_DAYS = 30 * 86400;

/** Reject a parameter file before it reaches a constructor that would accept it permanently. */
export function validateParams(params = {}) {
  const errors = [];
  for (const { key, kind } of PARAMETERS) {
    const value = params[key];
    if (value === undefined || value === null || value === '') { errors.push(`params.${key} is required and has no default`); continue; }
    if (kind === 'uint') {
      if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) errors.push(`params.${key} must be a decimal string in raw units, not a number literal`);
      else if (BigInt(value) > MaxUint256) errors.push(`params.${key} exceeds uint256`);
    } else if (kind === 'count' || kind === 'block' || kind === 'timestamp') {
      if (!Number.isSafeInteger(value) || value < 0) errors.push(`params.${key} must be a non-negative integer`);
    } else if (kind === 'curve') {
      if (!['linear', 'sqrt'].includes(value)) errors.push('params.curve must be linear or sqrt');
    }
  }
  if (errors.length) return errors;

  if (params.batchSize < 1) errors.push('params.batchSize must be at least 1');
  if (params.dickbuttDeployBlock < 1) errors.push('params.dickbuttDeployBlock must be at least 1');
  if (params.chunkSize < 1) errors.push('params.chunkSize must be at least 1');
  // Mirrors the constructors' own requires, so an invalid interval fails here rather than halfway
  // through a deployment that has already created immutable Splits.
  for (const key of ['lockerMinIntervalSeconds', 'aerodromeMinIntervalSeconds']) {
    if (params[key] > THIRTY_DAYS) errors.push(`params.${key} exceeds the contract's 30 day maximum`);
  }
  if (BigInt(params.maxSwapPerCallWei) === 0n) errors.push('params.maxSwapPerCallWei must be nonzero or no swap can ever execute');
  // A zero bound is how the executor recognises "no bound set", and it refuses a floor setter while
  // the bound is zero. Approving the ops key would revert, so catch the intent here.
  if (BigInt(params.floorLowerBoundRaw) === 0n) errors.push('params.floorLowerBoundRaw must be nonzero: the executor refuses a floor setter while the bound is zero');
  return errors;
}

/** Preserve the exclusions approved in preflight when producing the actual runtime config. */
export function buildProductionCalculatorConfig({ config, params, contracts }) {
  if (![config.clankerPool, config.rewardsPool?.pool].every(a => isAddress(a ?? '') && !same(a, ZeroAddress))) {
    throw Error('both production liquidity pools must be recorded for calculator exclusions');
  }
  const additionalExcluded = (config.calculatorExclusions?.required ?? [])
    .flatMap(entry => Array.isArray(entry.address) ? entry.address : [entry.address]);
  return buildCalculatorConfig({
    chainId: MAINNET, contracts: { ...contracts, clankerPool: config.clankerPool, rewardsPool: config.rewardsPool.pool },
    roles: { ...config.deployment, ops: config.deployment.floorSetter },
    deployBlock: params.dickbuttDeployBlock, holderThresholdRaw: params.holderThresholdRaw,
    payoutThresholdRaw: params.payoutThresholdRaw, curve: params.curve,
    batchSize: params.batchSize, chunkSize: params.chunkSize, additionalExcluded,
  });
}

/** Human-readable config durations are made explicit in the signed configuration calls. */
export function resolveRoundLimits(limits = {}) {
  const seconds = (value, name) => {
    const match = typeof value === 'string' && /^(\d+) (seconds?|minutes?|hours?|days?)$/.exec(value);
    const scale = match && { second: 1, minute: 60, hour: 3600, day: 86400 }[match[2].replace(/s$/, '')];
    const result = match ? Number(match[1]) * scale : value;
    if (!Number.isSafeInteger(result) || result < 0) throw Error(`invalid roundLimits.${name}`);
    return result;
  };
  const roundDelay = seconds(limits.roundDelay, 'roundDelay');
  const minRoundInterval = seconds(limits.minRoundInterval, 'minRoundInterval');
  const maxRoundBps = limits.maxRoundBps;
  if (roundDelay > 3 * 86400) throw Error('roundDelay must be 0 seconds..3 days');
  if (minRoundInterval > 7 * 86400) throw Error('minRoundInterval must be at most 7 days');
  if (!Number.isSafeInteger(maxRoundBps) || maxRoundBps < 1 || maxRoundBps > 10000) throw Error('maxRoundBps must be 1..10000');
  return { roundDelay, minRoundInterval, maxRoundBps };
}

/**
 * Aerodrome has shipped three Slipstream generations on Base and they are not interchangeable: the
 * executor stores tick spacings, so a quoter from the wrong generation quotes a pool the swap will
 * never touch. Resolve it from the recorded inspection rather than pasting an address.
 */
export function resolveQuoter(config, candidates) {
  const wanted = config?.aerodrome ?? {};
  const generations = candidates?.deployments ?? [];
  const match = generations.filter(g => same(g.factory, wanted.factory) && same(g.router, wanted.router));
  if (!match.length) {
    throw Error('aerodrome factory/router pair matches no recorded Slipstream generation; re-run npm run inspect:base');
  }
  if (match.length > 1) throw Error('aerodrome factory/router pair matches more than one recorded generation');
  const [generation] = match;
  if (!isAddress(generation.quoter ?? '')) throw Error(`recorded generation ${generation.generation} has no quoter address`);
  for (const spacing of [wanted.wethUsdcTickSpacing, wanted.usdcSpcxcTickSpacing]) {
    if (!generation.tickSpacings?.includes(spacing)) {
      throw Error(`tick spacing ${spacing} is not supported by generation ${generation.generation}`);
    }
  }
  return { quoter: generation.quoter, generation: generation.generation };
}

/** The deploying key signs everything and is then discarded; it must hold no lasting role. */
export function validateDeployerIsolation(deployer, roles = {}) {
  const errors = [];
  if (!isAddress(deployer ?? '')) return ['deployer address is not valid'];
  for (const [name, value] of Object.entries(roles)) {
    if (isAddress(value ?? '') && same(value, deployer)) errors.push(`the deploying key must not also be roles.${name}`);
  }
  return errors;
}

/**
 * The exact ordered sequence the driver will execute, built without touching a chain so a dry run
 * prints precisely what an execute run would send, and a test can assert constructor argument
 * order. Ownership handoff is deliberately last and deliberately two-step.
 */
export function buildDeploymentPlan({ config, params, legacy, splits, quoter }) {
  const d = config.deployment ?? {};
  const aero = config.aerodrome ?? {};
  const pool = config.rewardsPool ?? {};
  const missing = ['owner', 'keeper', 'proposer', 'guardian', 'floorSetter', 'kcGreen', 'cdbVault', 'burnAddress']
    .filter(name => !isAddress(d[name] ?? '') || same(d[name], ZeroAddress));
  if (missing.length) throw Error(`deployment roles are incomplete: ${missing.join(', ')}`);
  const poolErrors = validateRewardPoolConfig(pool);
  if (poolErrors.length) throw Error(poolErrors.join('; '));
  const harvesterName = aerodromeHarvesterName(pool);
  if (!isAddress(quoter ?? '')) throw Error('a resolved quoter address is required');
  const limits = resolveRoundLimits(config.roundLimits);

  // Addresses of contracts deployed earlier in the sequence are referenced by step name; the driver
  // substitutes them once each deployment confirms. Keeping them symbolic is what lets this whole
  // plan be built, printed and tested before anything is signed.
  const ref = name => ({ ref: name });
  const deployments = [
    { name: 'DickbuttRewardsDistributor', args: [config.spcxc, params.minPayoutRaw, ref('deployer')] },
    { name: 'SpcxcSwapExecutor',
      args: [config.weth, config.spcxc, aero.router, ref('DickbuttRewardsDistributor'), config.usdc,
        aero.wethUsdcTickSpacing, aero.usdcSpcxcTickSpacing, params.maxSwapPerCallWei,
        params.minSwapIntervalSeconds, ref('deployer')] },
    // Creates the two immutable PushSplit clones. Recipients cannot be changed afterwards.
    { name: 'SplitsFeeRouter',
      args: [splits.factory, config.weth, config.dickbutt, d.kcGreen, d.burnAddress, d.cdbVault, ref('SpcxcSwapExecutor')] },
    { name: 'LockerHarvester',
      args: [config.clankerLocker, config.clankerPositionManager, config.clankerTokenId,
        ref('SplitsFeeRouter'), params.lockerMinIntervalSeconds, ref('deployer')] },
    { name: harvesterName,
      args: [...(rewardsPoolKind(pool) === 'vamm' ? [pool.factory, pool.pool] : [pool.manager, pool.tokenId]), config.dickbutt, config.spcxc, d.burnAddress,
        ref('DickbuttRewardsDistributor'), params.aerodromeUnlockTime, params.aerodromeMinIntervalSeconds, ref('deployer')] },
    { name: 'LegacyFeeHarvester',
      args: [legacy.feeModule, legacy.safes.map(s => s.address ?? s), config.dickbutt, ref('SplitsFeeRouter')] },
  ];

  const actions = [
    { label: 'set-round-delay', contract: 'DickbuttRewardsDistributor', method: 'setRoundDelay', args: [limits.roundDelay] },
    { label: 'set-round-limits', contract: 'DickbuttRewardsDistributor', method: 'setRoundLimits', args: [limits.maxRoundBps, limits.minRoundInterval] },
    { label: 'set-keeper', contract: 'DickbuttRewardsDistributor', method: 'setKeeper', args: [d.keeper, true] },
    { label: 'set-proposer', contract: 'DickbuttRewardsDistributor', method: 'setProposer', args: [d.proposer, true] },
    { label: 'set-guardian', contract: 'DickbuttRewardsDistributor', method: 'setGuardian', args: [d.guardian] },
    { label: 'set-swap-keeper', contract: 'SpcxcSwapExecutor', method: 'setKeeper', args: [d.keeper, true] },
    // Bound first, always. The executor refuses a floor setter while the bound is zero, so the
    // reverse order would revert and leave the ops key unapproved on a half-configured executor.
    { label: 'set-floor-lower-bound', contract: 'SpcxcSwapExecutor', method: 'setFloorLowerBound', args: [params.floorLowerBoundRaw] },
    { label: 'set-floor-setter', contract: 'SpcxcSwapExecutor', method: 'setFloorSetter', args: [d.floorSetter, true] },
  ];

  // Ownable2Step: this only nominates. Each contract stays with the deployer until the multisig
  // sends acceptOwnership, which is the point -- a fat-fingered owner address is recoverable here.
  const handoffs = ['DickbuttRewardsDistributor', 'SpcxcSwapExecutor', 'LockerHarvester', harvesterName]
    .map(contract => ({ label: `transfer-ownership-${contract}`, contract, method: 'transferOwnership', args: [d.owner] }));

  return { deployments, actions, handoffs, quoter };
}

/**
 * Custody moves this script will never make. Each one is permanent or multisig-held, and doing them
 * from a hot deploying key is exactly the mistake the role separation exists to prevent.
 */
export const MANUAL_STEPS = [
  'Verify deployed bytecode, immutable recipients, pool identity and configuration, then accept ownership from the owner multisig on each Ownable2Step contract (acceptOwnership).',
  'Add every deployed pipeline and bot address to the production calculator exclusions before the first journal or round; verify funded operating wallets, independent history checks, monitoring and recovery before custody handoffs.',
  'Review outstanding legacy fees: the current creator may claim first, or the verified adapter can claim its configured safes after authority is assigned.',
  'After a successful fork rehearsal, transfer locker ownership to the verified LockerHarvester and verify ownsLocker() and an actual harvest. This is separate from legacy tokenCreator authority and does not transfer the DICKBUTT ERC-20 token contract.',
  'Transfer the verified rewards pool position to the deployed adapter for its recorded kind: unstaked ERC-20 LP tokens to AerodromeVammHarvester, or an NFT to AerodromeFeeHarvester. Verify the intended remaining LP lock, destination and fee routing first, then verify custody and an actual harvest.',
  'LAST: after the deployed fee pipeline and operating setup are verified, separately review and assign legacy tokenCreator authority to LegacyFeeHarvester. PERMANENT: the adapter has no relay to update it; the owner Safe cannot reverse this assignment.',
];
