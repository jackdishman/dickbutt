import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbstractProvider, Interface, Network, ZeroAddress, Wallet } from 'ethers';
import { main } from '../../script/deploy-mainnet.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const addr = n => '0x' + n.toString(16).padStart(40, '0');
const block = { number: 2000, hash: '0x' + 'ab'.repeat(32), timestamp: 1_800_000_000 };
const abi = new Interface([
  'function decimals() view returns(uint8)', 'function token0() view returns(address)',
  'function token1() view returns(address)', 'function factory() view returns(address)',
  'function fee() view returns(uint24)', 'function tickSpacing() view returns(int24)',
  'function liquidity() view returns(uint128)', 'function ownerOf(uint256) view returns(address)',
  'function getUnstakedFee(address) view returns(uint24)',
  'function getPool(address,address,bool) view returns(address)', 'function isPool(address) view returns(bool)',
  'function getFee(address,bool) view returns(uint256)', 'function isPaused() view returns(bool)',
  'function stable() view returns(bool)', 'function getReserves() view returns(uint256,uint256,uint256)',
  'function balanceOf(address) view returns(uint256)', 'function totalSupply() view returns(uint256)',
  'function positions(uint256) view returns(uint96,address,address,address,int24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
]);

// No sockets, RPC URL transport or signing support. The real ethers provider formatting and
// Contract ABI path still execute, so this catches SDK argument errors hidden by loose mocks.
class OfflineProvider extends AbstractProvider {
  constructor(config) { super(8453, { cacheTimeout: -1 }); this.config = config; this.reads = []; }
  get pollingInterval() { return 4000; }
  set pollingInterval(value) { assert.equal(value, 4000); }
  async _detectNetwork() { return Network.from(8453); }
  async getBlock() { return block; }
  async getBalance() { return 10n ** 18n; }
  async _perform(request) {
    this.reads.push(request);
    assert.ok(['getCode', 'call'].includes(request.method), `unexpected RPC operation ${request.method}`);
    const c = this.config;
    if (request.method === 'getCode') {
      assert.equal(typeof request.blockTag, 'string');
      return request.address.toLowerCase() === c.dickbutt.toLowerCase() && request.blockTag === '0x3e7' ? '0x' : '0x6000';
    }
    assert.equal(request.blockTag, '0x7d0', 'contract reads stay pinned to the finalized block');
    const call = abi.parseTransaction(request.transaction);
    const values = {
      decimals: [request.transaction.to.toLowerCase() === c.spcxc.toLowerCase() ? 8 : 18],
      token0: [c.dickbutt], token1: [c.spcxc], factory: [c.rewardsPool.factory],
      fee: [3000], tickSpacing: [200], liquidity: [100], ownerOf: [addr(9004)], getUnstakedFee: [0],
      positions: [0, ZeroAddress, c.dickbutt, c.spcxc, 200, -887200, 887200, 100, 0, 0, 0, 0],
      getPool: [c.rewardsPool.pool], isPool: [true], getFee: [30], isPaused: [false], stable: [false],
      getReserves: [100,100,block.timestamp], balanceOf: [100], totalSupply: [100],
    };
    assert.ok(values[call.name], `unexpected call ${call.name}`);
    return abi.encodeFunctionResult(call.name, values[call.name]);
  }
}

async function rehearsal(t, changes = {}, resume = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dickbutt-dry-deploy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/base-mainnet.json')));
  config.deployment.proposer = addr(9001); config.deployment.floorSetter = addr(9002);
  config.rewardsPool.pool = addr(9003); config.rewardsPool.lpOwner = addr(9004);
  config.calculatorExclusions.required.push(...[addr(9001), addr(9002), addr(9003)].map(address => ({ address })));
  const params = {
    dickbuttDeployBlock: 1000, holderThresholdRaw: '6900000000000000000000000', payoutThresholdRaw: '1',
    minPayoutRaw: '1', batchSize: 200, chunkSize: 2000, curve: 'linear', maxSwapPerCallWei: '100000000000000',
    minSwapIntervalSeconds: 21600, floorLowerBoundRaw: '1', lockerMinIntervalSeconds: 3600,
    aerodromeMinIntervalSeconds: 3600, aerodromeUnlockTime: block.timestamp + 86400, ...changes,
  };
  const configFile = path.join(dir, 'config.json'), paramsFile = path.join(dir, 'params.json');
  fs.writeFileSync(configFile, JSON.stringify(config)); fs.writeFileSync(paramsFile, JSON.stringify(params));
  const provider = new OfflineProvider(config);
  t.after(() => provider.destroy());
  const args = ['--config', configFile, '--params', paramsFile];
  const env = { BASE_RPC_URL: 'http://offline.invalid' };
  let partial, saved;
  if (resume) {
    // Ephemeral, unfunded test identity; this provider cannot broadcast anything.
    const wallet = Wallet.createRandom(), output = path.join(dir, 'manifest.json');
    partial = `${output}.partial`;
    saved = JSON.stringify({ deployer: wallet.address, chainId: 8453, contracts: {}, deployments: {}, actions: {},
      buildHash: '0x' + 'cd'.repeat(32), inputHash: '0x' + 'ef'.repeat(32) });
    fs.writeFileSync(partial, saved);
    args.push('--out', output, '--execute', '--resume');
    env.DEPLOYER_PRIVATE_KEY = wallet.privateKey;
  }
  let plan;
  try { plan = await main(args, env, { providerFactory: () => provider,
      // Artifact/source validation has its own filesystem tests. The unsigned driver test must
      // also work in a fresh checkout before forge build has produced an out/ directory.
      buildLoader: (_root, names) => {
        assert.equal(names.length, 6);
        return { artifacts: {}, buildHash: '0x' + 'cd'.repeat(32) };
      } });
  } finally {
    if (resume) assert.equal(fs.readFileSync(partial, 'utf8'), saved, 'rejected recovery must preserve its original progress file');
  }
  return { plan, provider, config };
}

test('complete production dry run uses valid ethers block tags and never signs', async t => {
  const { plan, provider } = await rehearsal(t);
  assert.equal(plan.deployments.length, 6);
  assert.equal(plan.deployments[4].name, 'AerodromeVammHarvester');
  const tags = provider.reads.filter(r => r.method === 'getCode').map(r => r.blockTag);
  assert.ok(tags.includes('0x7d0') && tags.includes('0x3e7') && tags.includes('0x3e8'));
});

test('a lock beyond the constructor maximum is refused during the unsigned dry run', async t => {
  await assert.rejects(rehearsal(t, { aerodromeUnlockTime: block.timestamp + 100 * 365 * 86400 + 1 }), /100 year maximum/);
});

test('the deployment driver rejects changed recovery inputs before any signing and preserves progress', async t => {
  await assert.rejects(rehearsal(t, {}, true), /deployment inputs changed/);
});
