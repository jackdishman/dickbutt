import { isAddress, ZeroAddress } from 'ethers';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * Chains this repository is allowed to deploy to. Base mainnet is present so script/deploy-mainnet.mjs
 * can emit a manifest, and that is the ONLY gate it opens: the operating CLIs (operations/fees.js,
 * operations/floor.js, script/run-keeper.mjs) still refuse to execute on 8453. Deploying contracts
 * and running fee cycles against them are separate decisions with separate reviews.
 */
export const DEPLOYABLE_CHAINS = { 8453: 'base-mainnet', 84532: 'base-sepolia', 31337: 'local' };

/**
 * Validate the role assignment before a single transaction is sent. Key isolation is cheap to get
 * right here and expensive to fix once contracts hold funds, so the same separation the runtime
 * bots enforce is enforced at deployment time too.
 */
export function validateRoles(roles = {}, { deployer } = {}) {
  const errors = [];
  const required = ['owner', 'keeper', 'proposer', 'guardian', 'ops', 'kcGreen', 'cdbVault', 'burnAddress'];
  for (const name of required) {
    if (!isAddress(roles[name] ?? '') || same(roles[name], ZeroAddress)) {
      errors.push(`roles.${name} must be an explicit nonzero address`);
    }
  }
  if (errors.length) return errors;

  // The keeper moves funds. Nothing that administers the system may also hold that key.
  if (same(roles.keeper, roles.owner)) errors.push('keeper must not be the owner: the floor bot refuses an owner key that is also a keeper');
  if (same(roles.keeper, roles.proposer)) errors.push('keeper and proposer must be separate keys on separate hosts');
  if (same(roles.keeper, roles.guardian)) errors.push('keeper must not be the guardian');
  if (deployer && same(roles.keeper, deployer)) errors.push('keeper must not be the deploying key');
  // The ops key is the executor's floor setter. The contract refuses a keeper as floor setter, so
  // catch it here before a deployment transaction reverts halfway through role wiring.
  if (same(roles.ops, roles.keeper)) errors.push('ops (floor setter) must not be the keeper: one host must never both set the price and swap at it');

  // Guardian may equal owner: one multisig that both administers and stops things is the
  // intended default. Proposer sharing the owner key is allowed but pointless, so warn-by-error
  // is too strong; it is left to the operator.
  const payees = ['kcGreen', 'cdbVault', 'burnAddress'].map(k => roles[k].toLowerCase());
  if (new Set(payees).size !== payees.length) errors.push('kcGreen, cdbVault and burnAddress must be distinct');
  for (const name of ['kcGreen', 'cdbVault']) {
    if (same(roles[name], roles.keeper) || same(roles[name], roles.proposer) || same(roles[name], roles.ops)) {
      errors.push(`roles.${name} must not be an operational bot key`);
    }
  }
  return errors;
}

/**
 * Assemble the manifest the fee, floor and keeper CLIs consume. Kept pure so the shape is tested
 * without a chain: a manifest that omits one address sends an operator chasing an RPC error.
 */
export function buildManifest({ chainId, quoter, contracts, roles, deployedAtBlock, tokenDeployBlock, notes = [] }) {
  const required = ['weth', 'usdc', 'dickbutt', 'spcxc', 'distributor', 'executor', 'feeRouter', 'clanker', 'aero', 'legacy'];
  const missing = required.filter(key => !isAddress(contracts?.[key] ?? ''));
  if (missing.length) throw Error(`manifest missing contract addresses: ${missing.join(', ')}`);
  if (!isAddress(quoter ?? '')) throw Error('manifest requires a quoter address');
  if (!DEPLOYABLE_CHAINS[Number(chainId)]) throw Error(`chain ${chainId} is not a deployable chain`);
  return {
    chainId: Number(chainId),
    network: DEPLOYABLE_CHAINS[Number(chainId)],
    deployedAtBlock,
    tokenDeployBlock,
    quoter,
    contracts: Object.fromEntries(required.map(key => [key, contracts[key]])),
    splits: { dickSplit: contracts.dickSplit ?? null, wethSplit: contracts.wethSplit ?? null },
    // The CLIs read safe count on-chain, but an operator debugging a legacy harvest should not
    // have to reconstruct these from transaction history.
    sources: {
      locker: contracts.locker ?? null,
      positionManager: contracts.manager ?? null,
      legacySafes: contracts.legacySafes ?? [],
    },
    roles,
    notes,
  };
}

/**
 * The exact object the calculator hashes. Key order is part of that hash, so it is fixed here
 * rather than assembled ad hoc by whoever runs the keeper.
 */
export function buildCalculatorConfig({ chainId, contracts, roles, deployBlock, holderThresholdRaw, payoutThresholdRaw = '1', curve = 'linear', batchSize = 50, chunkSize = 2000, finalityTag = 'finalized' }) {
  if (!['linear', 'sqrt'].includes(curve)) throw Error('curve must be linear or sqrt');
  if (!Number.isSafeInteger(deployBlock) || deployBlock < 0) throw Error('invalid deployBlock');
  // Everything that receives DICKBUTT from the pipeline, plus every operational key. A missing
  // entry here silently pays rewards to the machinery instead of to holders.
  const excluded = [
    roles.burnAddress, roles.kcGreen, roles.cdbVault, roles.owner, roles.keeper, roles.proposer, roles.guardian, roles.ops,
    contracts.feeRouter, contracts.dickSplit, contracts.wethSplit, contracts.executor, contracts.distributor,
    contracts.clanker, contracts.aero, contracts.legacy, contracts.locker, contracts.manager,
    ...(contracts.legacySafes ?? []),
  ].filter(Boolean).map(a => a.toLowerCase());
  return {
    chainId: String(chainId),
    token: contracts.dickbutt.toLowerCase(),
    distributor: contracts.distributor.toLowerCase(),
    deployBlock,
    holderThresholdRaw,
    payoutThresholdRaw,
    curve,
    excluded: [...new Set(excluded)].sort(),
    batchSize,
    chunkSize,
    finalityTag,
  };
}
