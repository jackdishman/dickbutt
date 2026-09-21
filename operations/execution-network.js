import { isAddress, ZeroAddress } from 'ethers';
import { validateRoles } from './deployment.js';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const address = (value, name) => {
  if (!isAddress(value ?? '') || same(value, ZeroAddress)) throw Error(`mainnet ${name} must be a nonzero address`);
};
const positive = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1) throw Error(`invalid mainnet ${name}`);
};

/** An explicit execution switch, independent from deployment permission. Never reads environment flags. */
export function assertExecutionNetwork({ chainId, execute = false, allowMainnet = false, config, configKind = 'manifest' }) {
  if (typeof execute !== 'boolean' || typeof allowMainnet !== 'boolean') throw Error('execution switches must be booleans');
  const chain = String(chainId);
  if (!['31337', '84532', '8453'].includes(chain)) throw Error('transaction execution is disabled on unsupported chain');
  if (allowMainnet && chain !== '8453') throw Error('allowMainnet is valid only on Base mainnet (8453)');
  if (execute && chain === '8453' && !allowMainnet) throw Error('production transaction execution is disabled; Base mainnet requires explicit allowMainnet');
  if (config && String(config.chainId) !== chain) throw Error('RPC/config chain mismatch');
  if (!allowMainnet) return;
  if (!config || String(config.chainId) !== '8453') throw Error('mainnet execution requires a matching reviewed configuration');
  if (configKind === 'calculator') {
    address(config.token, 'holder token'); address(config.distributor, 'distributor');
    if (same(config.token, config.distributor)) throw Error('mainnet token and distributor must differ');
    positive(config.deployBlock, 'deployBlock'); positive(config.batchSize, 'batchSize'); positive(config.chunkSize, 'chunkSize');
    if (config.batchSize > 200) throw Error('mainnet batchSize exceeds the tested 200-recipient limit');
    if (config.finalityTag !== 'finalized') throw Error('mainnet calculator requires finalized history');
    if (!['linear', 'sqrt'].includes(config.curve)) throw Error('invalid mainnet reward curve');
    for (const key of ['holderThresholdRaw', 'payoutThresholdRaw']) {
      if (typeof config[key] !== 'string' || !/^[0-9]+$/.test(config[key]) || BigInt(config[key]) <= 0n) throw Error(`invalid mainnet ${key}`);
    }
    if (!Array.isArray(config.excluded) || !config.excluded.length) throw Error('mainnet calculator requires reviewed exclusions');
    for (const value of config.excluded) if (!isAddress(value)) throw Error('invalid mainnet exclusion address');
    if (!config.excluded.some(value => same(value, config.distributor))) throw Error('mainnet distributor must be excluded from rewards');
  } else if (configKind === 'manifest') {
    if (config.network !== 'base-mainnet') throw Error('mainnet manifest network must be base-mainnet');
    const required = ['weth', 'usdc', 'dickbutt', 'spcxc', 'distributor', 'executor', 'feeRouter', 'clanker', 'aero', 'legacy'];
    for (const key of required) address(config.contracts?.[key], `contracts.${key}`);
    if (new Set(required.map(key => config.contracts[key].toLowerCase())).size !== required.length) throw Error('mainnet pipeline contract addresses must be distinct');
    address(config.quoter, 'quoter');
    const errors = validateRoles(config.roles);
    if (errors.length) throw Error(`mainnet roles rejected: ${errors.join('; ')}`);
    if (same(config.roles.ops, config.roles.proposer)) throw Error('mainnet floor setter and proposer must be separate keys');
    if (!['vamm', 'slipstream'].includes(config.sources?.aerodromeKind)) throw Error('mainnet manifest must record the Aerodrome kind');
    address(config.sources?.rewardsPool, 'rewards pool'); address(config.sources?.rewardsFactory, 'rewards factory');
  } else throw Error('unknown mainnet configuration kind');
}

/** Direct library callers must bind each supplied contract object to the reviewed manifest too. */
export async function verifyMainnetContractBindings({ provider, config, contracts }) {
  for (const [name, contract] of Object.entries(contracts)) {
    const expected = config.contracts[name];
    if (!contract || typeof contract.getAddress !== 'function' || !same(await contract.getAddress(), expected)) throw Error(`mainnet ${name} contract differs from manifest`);
    if (typeof provider.getCode !== 'function' || !/^0x[0-9a-f]+$/i.test(await provider.getCode(expected))) throw Error(`mainnet ${name} has no deployed code`);
  }
}

export async function verifyMainnetExecutor({ provider, config, executor }) {
  await verifyMainnetContractBindings({ provider, config, contracts: { executor } });
  for (const [getter, expected] of [['weth', config.contracts.weth], ['spcxc', config.contracts.spcxc], ['distributor', config.contracts.distributor], ['owner', config.roles.owner]]) {
    if (!same(await executor[getter](), expected)) throw Error(`mainnet executor ${getter} differs from manifest`);
  }
}

export function assertMainnetSigner(signerAddress, expected, role) {
  if (!same(signerAddress, expected)) throw Error(`mainnet ${role} signer differs from manifest`);
}
