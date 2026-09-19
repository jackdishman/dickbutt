import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PARAMETERS, MANUAL_STEPS, parseMainnetArgs, validateParams, resolveQuoter,
  validateDeployerIsolation, buildDeploymentPlan, buildProductionCalculatorConfig, resolveRoundLimits,
} from '../mainnet-deploy.js';

const addr = n => '0x' + String(n).padStart(40, '0');
const params = {
  dickbuttDeployBlock: 12345678, holderThresholdRaw: '6900000000000000000000000', payoutThresholdRaw: '1',
  minPayoutRaw: '1', batchSize: 50, chunkSize: 2000, curve: 'linear',
  maxSwapPerCallWei: '1000000000000000000', minSwapIntervalSeconds: 3600,
  floorLowerBoundRaw: '100000000', lockerMinIntervalSeconds: 3600,
  aerodromeMinIntervalSeconds: 3600, aerodromeUnlockTime: 4132317178,
};
const config = {
  chainId: 8453, dickbutt: addr(1), spcxc: addr(2), weth: addr(3), usdc: addr(4),
  clankerLocker: addr(5), clankerPositionManager: addr(6), clankerTokenId: '1391176',
  aerodrome: { factory: addr(7), router: addr(8), wethUsdcTickSpacing: 1, usdcSpcxcTickSpacing: 10 },
  rewardsPool: { factory: addr(7), manager: addr(9), pool: addr(10), tokenId: '42' },
  clankerPool: addr(22),
  roundLimits: { roundDelay: '24 hours', minRoundInterval: '6 hours', maxRoundBps: 5000 },
  deployment: {
    owner: addr(11), keeper: addr(12), proposer: addr(13), guardian: addr(11),
    floorSetter: addr(14), kcGreen: addr(15), cdbVault: addr(16), burnAddress: addr('dead'),
  },
};
const legacy = { feeModule: addr(17), safes: [{ address: addr(18) }, { address: addr(19) }] };
const splits = { factory: addr(20) };
const candidates = { deployments: [
  { generation: 'initial', factory: addr(70), router: addr(80), quoter: addr(90), tickSpacings: [1, 10] },
  { generation: 'gauges-v3', factory: addr(7), router: addr(8), quoter: addr(21), tickSpacings: [1, 10, 200] },
] };
const plan = () => buildDeploymentPlan({ config, params, legacy, splits, quoter: addr(21) });

test('a dry run is the default and --params is mandatory', () => {
  assert.equal(parseMainnetArgs(['--params', 'p.json']).execute, false);
  assert.throws(() => parseMainnetArgs([]), /--params is required/);
  assert.throws(() => parseMainnetArgs(['--params', 'p.json', '--resume']), /requires --execute/);
  assert.throws(() => parseMainnetArgs(['--params', 'p.json', '--wat']), /unknown deploy option/);
});

test('every production magnitude is required and none is defaulted', () => {
  assert.deepEqual(validateParams(params), []);
  for (const { key } of PARAMETERS) {
    const errors = validateParams({ ...params, [key]: undefined });
    assert.ok(errors.some(e => e.includes(`params.${key}`)), `${key} may not be omitted`);
  }
});

test('raw amounts must be decimal strings, because wei exceeds a safe integer', () => {
  assert.ok(validateParams({ ...params, maxSwapPerCallWei: 1e18 }).some(e => /decimal string/.test(e)));
});

test('parameters that would revert their own constructor are rejected before signing', () => {
  assert.ok(validateParams({ ...params, floorLowerBoundRaw: '0' }).some(e => /refuses a floor setter/.test(e)));
  assert.ok(validateParams({ ...params, maxSwapPerCallWei: '0' }).some(e => /nonzero/.test(e)));
  assert.ok(validateParams({ ...params, lockerMinIntervalSeconds: 31 * 86400 }).some(e => /30 day/.test(e)));
  assert.ok(validateParams({ ...params, curve: 'quadratic' }).some(e => /linear or sqrt/.test(e)));
  assert.ok(validateParams({ ...params, minPayoutRaw: (1n << 256n).toString() }).some(e => /uint256/.test(e)));
  assert.ok(validateParams({ ...params, dickbuttDeployBlock: 0 }).some(e => /at least 1/.test(e)));
});

test('the quoter is resolved from the configured Slipstream generation, never pasted', () => {
  assert.deepEqual(resolveQuoter(config, candidates), { quoter: addr(21), generation: 'gauges-v3' });
  const moved = { ...config, aerodrome: { ...config.aerodrome, router: addr(99) } };
  assert.throws(() => resolveQuoter(moved, candidates), /matches no recorded Slipstream generation/);
  const unsupported = { ...config, aerodrome: { ...config.aerodrome, usdcSpcxcTickSpacing: 7 } };
  assert.throws(() => resolveQuoter(unsupported, candidates), /tick spacing 7 is not supported/);
});

// The repository ships the real files; a generation rename upstream should fail here, not on a launch.
test('the shipped mainnet config resolves against the shipped route candidates', () => {
  const real = JSON.parse(fs.readFileSync('config/base-mainnet.json', 'utf8'));
  const recorded = JSON.parse(fs.readFileSync('config/route-candidates.json', 'utf8'));
  const { quoter, generation } = resolveQuoter(real, recorded);
  assert.equal(generation, 'gauges-v3');
  assert.match(quoter, /^0x[0-9a-fA-F]{40}$/);
});

test('the deploying key may hold no lasting role', () => {
  assert.deepEqual(validateDeployerIsolation(addr(99), config.deployment), []);
  assert.ok(validateDeployerIsolation(addr(11), config.deployment).some(e => /roles.owner/.test(e)));
  assert.ok(validateDeployerIsolation(addr(12), config.deployment).some(e => /roles.keeper/.test(e)));
});

test('the plan refuses to build while a decision is still missing', () => {
  assert.throws(() => buildDeploymentPlan({ config: { ...config, deployment: { ...config.deployment, owner: null } }, params, legacy, splits, quoter: addr(21) }), /roles are incomplete/);
  assert.throws(() => buildDeploymentPlan({ config: { ...config, rewardsPool: { ...config.rewardsPool, pool: null } }, params, legacy, splits, quoter: addr(21) }), /rewardsPool.pool/);
});

test('the fee router points at the swap executor and the harvesters at the router', () => {
  const { deployments } = plan();
  assert.deepEqual(deployments.map(d => d.name), ['DickbuttRewardsDistributor', 'SpcxcSwapExecutor',
    'SplitsFeeRouter', 'LockerHarvester', 'AerodromeFeeHarvester', 'LegacyFeeHarvester']);
  const router = deployments.find(d => d.name === 'SplitsFeeRouter');
  assert.deepEqual(router.args.at(-1), { ref: 'SpcxcSwapExecutor' });
  for (const name of ['LockerHarvester', 'LegacyFeeHarvester']) {
    assert.ok(deployments.find(d => d.name === name).args.some(a => a?.ref === 'SplitsFeeRouter'), `${name} must harvest into the fee router`);
  }
  // SPCXc from the Aerodrome position goes straight to holders, not back through the fee split.
  assert.ok(deployments.find(d => d.name === 'AerodromeFeeHarvester').args.some(a => a?.ref === 'DickbuttRewardsDistributor'));
});

test('the floor bound is set before the floor setter is approved', () => {
  const labels = plan().actions.map(a => a.label);
  assert.ok(labels.indexOf('set-floor-lower-bound') < labels.indexOf('set-floor-setter'));
});

test('ownership is handed only to the multisig, and only on contracts that have an owner', () => {
  const { handoffs } = plan();
  assert.deepEqual(handoffs.map(h => h.contract),
    ['DickbuttRewardsDistributor', 'SpcxcSwapExecutor', 'LockerHarvester', 'AerodromeFeeHarvester']);
  for (const handoff of handoffs) {
    assert.equal(handoff.method, 'transferOwnership');
    assert.deepEqual(handoff.args, [config.deployment.owner]);
  }
  // SplitsFeeRouter and LegacyFeeHarvester are ownerless by design; transferOwnership would revert.
  assert.ok(!handoffs.some(h => ['SplitsFeeRouter', 'LegacyFeeHarvester'].includes(h.contract)));
});

test('the permanent custody steps stay out of the script and are reported instead', () => {
  const text = MANUAL_STEPS.join(' ');
  for (const expected of [/acceptOwnership/, /tokenCreator/, /locker ownership/, /ERC-20 LP/, /NFT/, /exclusions/]) {
    assert.match(text, expected);
  }
});

test('vAMM deployment uses the registered pool address, records no NFT and hands off the right adapter', () => {
  const selected = { ...config, rewardsPool: {kind:'vamm',pool:addr(10),factory:addr(30),lpOwner:addr(31),stable:false,staking:'unstaked',swapFeeBps:30} };
  const p = buildDeploymentPlan({config:selected,params,legacy,splits,quoter:addr(21)});
  assert.equal(p.deployments[4].name,'AerodromeVammHarvester');
  assert.deepEqual(p.deployments[4].args,[addr(30),addr(10),config.dickbutt,config.spcxc,config.deployment.burnAddress,
    {ref:'DickbuttRewardsDistributor'},params.aerodromeUnlockTime,params.aerodromeMinIntervalSeconds,{ref:'deployer'}]);
  assert.equal(p.handoffs.at(-1).contract,'AerodromeVammHarvester');
  assert.equal(p.deployments[1].name,'SpcxcSwapExecutor','the existing two-hop swap adapter is unchanged');
  for(const patch of [{lpOwner:null},{pool:null},{factory:null},{stable:true},{staking:'staked'},{swapFeeBps:3000},{kind:'unknown'}]) {
    assert.throws(()=>buildDeploymentPlan({config:{...selected,rewardsPool:{...selected.rewardsPool,...patch}},params,legacy,splits,quoter:addr(21)}));
  }
});

test('the production generator preserves both pool exclusions and every preflight-listed address', () => {
  const configured = { ...config, calculatorExclusions: { required: [
    { address: addr(23) }, { address: [addr(24), addr(25)] },
  ] } };
  const runtime = buildProductionCalculatorConfig({ config: configured, params,
    contracts: { dickbutt: config.dickbutt, distributor: addr(26), feeRouter: addr(27), legacySafes: [addr(18), addr(19)] } });
  for (const address of [config.clankerPool, config.rewardsPool.pool, addr(23), addr(24), addr(25), addr(27), addr(18), addr(19)]) {
    assert.ok(runtime.excluded.includes(address), `runtime dropped ${address}`);
  }
  assert.throws(() => buildProductionCalculatorConfig({ config: { ...configured, clankerPool: null }, params, contracts: {} }), /both production liquidity pools/);
});

test('deployment explicitly applies the configured delay, cadence and round cap', () => {
  const { actions } = plan();
  assert.deepEqual(actions.find(a => a.method === 'setRoundDelay').args, [86400]);
  assert.deepEqual(actions.find(a => a.method === 'setRoundLimits').args, [5000, 21600]);
  assert.deepEqual(resolveRoundLimits({ roundDelay: 3600, minRoundInterval: 0, maxRoundBps: 10000 }),
    { roundDelay: 3600, minRoundInterval: 0, maxRoundBps: 10000 });
  for (const bad of [{}, { ...config.roundLimits, roundDelay: -1 },
    { ...config.roundLimits, minRoundInterval: '8 days' }, { ...config.roundLimits, maxRoundBps: 0 }]) {
    assert.throws(() => resolveRoundLimits(bad));
  }
});

test('zero extra review delay is explicit in the production plan without shortening the six-hour interval', () => {
  const configured = { ...config, roundLimits: { ...config.roundLimits, roundDelay: '0 hours' } };
  const result = buildDeploymentPlan({ config: configured, params, legacy, splits, quoter: addr(21) });
  assert.deepEqual(result.actions.find(a => a.method === 'setRoundDelay').args, [0]);
  assert.deepEqual(result.actions.find(a => a.method === 'setRoundLimits').args, [5000, 21600]);
});
