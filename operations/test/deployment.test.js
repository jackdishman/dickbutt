import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRoles, buildManifest, buildCalculatorConfig, DEPLOYABLE_CHAINS } from '../deployment.js';

const addr = n => '0x' + String(n).padStart(40, '0');
const roles = {
  owner: addr(1), keeper: addr(2), proposer: addr(3), guardian: addr(1),
  kcGreen: addr(4), cdbVault: addr(5), burnAddress: addr('dead'),
};
const contracts = {
  weth: addr(10), usdc: addr(11), dickbutt: addr(12), spcxc: addr(13), distributor: addr(14),
  executor: addr(15), feeRouter: addr(16), clanker: addr(17), aero: addr(18), legacy: addr(19),
  dickSplit: addr(20), wethSplit: addr(21),
};

test('base mainnet is not a deployable chain', () => {
  assert.equal(DEPLOYABLE_CHAINS[8453], undefined);
  assert.equal(DEPLOYABLE_CHAINS[84532], 'base-sepolia');
  assert.throws(() => buildManifest({ chainId: 8453, quoter: addr(9), contracts, roles }), /not a deployable chain/);
});

test('roles accept the intended layout and guardian may share the owner multisig', () => {
  assert.deepEqual(validateRoles(roles), []);
  assert.deepEqual(validateRoles({ ...roles, guardian: addr(6) }), []);
});

test('roles reject a keeper that doubles as an administrator or deployer', () => {
  assert.ok(validateRoles({ ...roles, keeper: roles.owner }).some(e => e.includes('must not be the owner')));
  assert.ok(validateRoles({ ...roles, keeper: roles.proposer }).some(e => e.includes('separate keys')));
  assert.ok(validateRoles({ ...roles, keeper: roles.guardian }).some(e => e.includes('not be the guardian')));
  assert.ok(validateRoles(roles, { deployer: roles.keeper }).some(e => e.includes('deploying key')));
});

test('roles reject missing, zero, duplicate and bot-key payees', () => {
  assert.ok(validateRoles({}).length >= 7);
  assert.ok(validateRoles({ ...roles, owner: '0x' + '0'.repeat(40) }).some(e => e.includes('roles.owner')));
  assert.ok(validateRoles({ ...roles, cdbVault: roles.kcGreen }).some(e => e.includes('distinct')));
  assert.ok(validateRoles({ ...roles, kcGreen: roles.keeper }).some(e => e.includes('operational bot key')));
  // Address checks run first so the output is not buried under downstream noise.
  assert.ok(validateRoles({ ...roles, keeper: 'nonsense' }).every(e => e.includes('must be an explicit nonzero address')));
});

test('manifest carries every address the operating CLIs read', () => {
  const m = buildManifest({ chainId: 84532, quoter: addr(9), contracts, roles, deployedAtBlock: 7 });
  assert.equal(m.network, 'base-sepolia');
  assert.equal(m.deployedAtBlock, 7);
  for (const key of ['weth', 'usdc', 'dickbutt', 'spcxc', 'distributor', 'executor', 'feeRouter', 'clanker', 'aero', 'legacy']) {
    assert.ok(m.contracts[key], `manifest must carry ${key}`);
  }
  assert.equal(m.splits.dickSplit, contracts.dickSplit);
  // Fee-source addresses are needed to debug a harvest; they are not in `contracts`.
  const withSources = buildManifest({ chainId: 84532, quoter: addr(9), roles, deployedAtBlock: 7,
    contracts: { ...contracts, locker: addr(40), manager: addr(41), legacySafes: [addr(42), addr(43)] } });
  assert.equal(withSources.sources.locker, addr(40));
  assert.equal(withSources.sources.positionManager, addr(41));
  assert.deepEqual(withSources.sources.legacySafes, [addr(42), addr(43)]);
  assert.deepEqual(m.sources.legacySafes, []);
  assert.throws(() => buildManifest({ chainId: 84532, quoter: addr(9), contracts: { ...contracts, legacy: undefined }, roles }), /missing contract addresses: legacy/);
  assert.throws(() => buildManifest({ chainId: 84532, contracts, roles }), /quoter/);
});

test('calculator config excludes every pipeline contract and operational key', () => {
  const c = buildCalculatorConfig({
    chainId: 84532, contracts: { ...contracts, legacySafes: [addr(30), addr(31)] }, roles,
    deployBlock: 100, holderThresholdRaw: '6900000000000000000000000',
  });
  assert.equal(c.chainId, '84532');
  assert.equal(c.curve, 'linear');
  for (const a of [roles.burnAddress, roles.kcGreen, roles.cdbVault, roles.keeper, roles.proposer,
    contracts.feeRouter, contracts.dickSplit, contracts.wethSplit, contracts.distributor, addr(30), addr(31)]) {
    assert.ok(c.excluded.includes(a.toLowerCase()), `${a} must be excluded`);
  }
  // Deterministic and duplicate-free, because the calculator hashes this object.
  assert.deepEqual(c.excluded, [...new Set(c.excluded)].sort());
  assert.equal(JSON.stringify(Object.keys(c)), JSON.stringify(['chainId', 'token', 'distributor', 'deployBlock',
    'holderThresholdRaw', 'payoutThresholdRaw', 'curve', 'excluded', 'batchSize', 'chunkSize', 'finalityTag']));
  assert.throws(() => buildCalculatorConfig({ chainId: 84532, contracts, roles, deployBlock: 1, curve: 'quadratic' }), /linear or sqrt/);
  assert.throws(() => buildCalculatorConfig({ chainId: 84532, contracts, roles, deployBlock: -1 }), /deployBlock/);
});

test('deploy CLI rejects malformed invocations', async () => {
  const { parseDeployArgs } = await import('../../script/deploy-sepolia.mjs');
  assert.equal(parseDeployArgs(['--roles', 'r.json']).out, 'deployment-sepolia.json');
  assert.equal(parseDeployArgs(['--roles', 'r.json', '--force']).force, true);
  assert.equal(parseDeployArgs(['--roles', 'r.json', '--out', 'x.json']).out, 'x.json');
  assert.throws(() => parseDeployArgs([]), /--roles is required/);
  assert.throws(() => parseDeployArgs(['--roles']), /missing value/);
  assert.throws(() => parseDeployArgs(['--roles', '--force']), /missing value/);
  assert.throws(() => parseDeployArgs(['--roles', 'r.json', '--mainnet']), /unknown deploy option/);
  assert.throws(() => parseDeployArgs(['deploy']), /positional argument/);
});
