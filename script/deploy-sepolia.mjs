#!/usr/bin/env node
// Deploy the whole architecture to Base Sepolia (84532) and emit the manifests the fee, floor and
// keeper CLIs consume. Base mainnet is rejected; this is a rehearsal deployment, not a launch.
//
// Splits V2.2 is deployed on Base Sepolia at the same addresses as mainnet, so the fee fan-out uses
// the GENUINE protocol here. Aerodrome Slipstream is not, so the router and quoter are stand-ins
// from script/SepoliaSupport.sol. Tokens are open-faucet mocks. See docs/SEPOLIA.md.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { validateRoles, buildManifest, buildCalculatorConfig } from '../operations/deployment.js';
import { closeProvider } from '../operations/provider.js';

const SPLITS_FACTORY = '0x8E8eB0cC6AE34A38B67D5Cf91ACa38f60bc3Ecf4';
const BURN = '0x000000000000000000000000000000000000dEaD';
const SEPOLIA = 84532n;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: npm run deploy:sepolia -- --roles roles.json [--out deployment-sepolia.json] [--force]

Deploys to Base Sepolia only. Requires RPC_URL and DEPLOYER_PRIVATE_KEY.

  --roles   JSON with owner, keeper, proposer, guardian, ops, kcGreen, cdbVault, burnAddress.
            The keeper must be a separate key from every administrative role. ops is the
            executor's floor setter and must not be the keeper.
  --out     Manifest path. Refuses to overwrite an existing file without --force, because
            a second deploy would orphan the first deployment's contracts and funds.
  --force   Allow overwriting the manifest. Read the old one first.`;

export function parseDeployArgs(args) {
  const o = { out: 'deployment-sepolia.json', force: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--force') o.force = true;
    else if (arg === '--help') o.help = true;
    else if (arg === '--roles' || arg === '--out') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Error(`missing value for ${arg}`);
      o[arg === '--roles' ? 'rolesPath' : 'out'] = value;
    } else throw Error(`unknown deploy option: ${arg.startsWith('--') ? arg : 'positional argument'}`);
  }
  if (o.help) return o;
  if (!o.rolesPath) throw Error('--roles is required');
  return o;
}

const artifact = name => {
  for (const dir of [`${name}.sol`, 'SepoliaSupport.sol', 'LegacyFees.t.sol']) {
    const file = path.join(ROOT, 'out', dir, `${name}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  throw Error(`artifact not found for ${name}; run forge build`);
};

export async function main(args = process.argv.slice(2), env = process.env) {
  const o = parseDeployArgs(args);
  if (o.help) { console.log(USAGE); return; }
  if (!env.RPC_URL) throw Error('RPC_URL is required');
  if (!env.DEPLOYER_PRIVATE_KEY) throw Error('DEPLOYER_PRIVATE_KEY is required');

  const outPath = path.resolve(o.out);
  if (fs.existsSync(outPath) && !o.force) {
    throw Error(`${o.out} already exists; a new deployment would orphan the contracts it names. Review it, then pass --force`);
  }
  const roles = JSON.parse(fs.readFileSync(o.rolesPath, 'utf8'));
  if (!roles.burnAddress) roles.burnAddress = BURN;

  const provider = new ethers.JsonRpcProvider(env.RPC_URL, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  try {
    const { chainId } = await provider.getNetwork();
    if (chainId !== SEPOLIA) throw Error(`deployment is restricted to Base Sepolia (84532); RPC reports ${chainId}`);
    const deployer = new ethers.Wallet(env.DEPLOYER_PRIVATE_KEY, provider);

    const roleErrors = validateRoles(roles, { deployer: deployer.address });
    if (roleErrors.length) throw Error(`role configuration rejected:\n  - ${roleErrors.join('\n  - ')}`);

    const balance = await provider.getBalance(deployer.address);
    if (balance < ethers.parseEther('0.02')) {
      throw Error(`deployer ${deployer.address} holds ${ethers.formatEther(balance)} ETH; fund it before deploying`);
    }
    console.log(JSON.stringify({ type: 'deploy-start', deployer: deployer.address, chainId: String(chainId), balance: ethers.formatEther(balance) }));

    // Written after every deployment so a mid-run failure leaves a record of what already exists
    // instead of orphaning contracts nobody can find.
    const contracts = {};
    const partial = `${outPath}.partial`;
    const record = () => fs.writeFileSync(partial, JSON.stringify({ incomplete: true, deployer: deployer.address, contracts }, null, 2));
    const deploy = async (name, args_ = []) => {
      const a = artifact(name);
      const c = await new ethers.ContractFactory(a.abi, a.bytecode.object, deployer).deploy(...args_);
      await c.waitForDeployment();
      const address = await c.getAddress();
      console.log(JSON.stringify({ type: 'deployed', name, address }));
      return c;
    };
    const send = async (label, promise) => {
      const receipt = await (await promise).wait();
      if (Number(receipt.status) !== 1) throw Error(`${label} failed: ${receipt.hash}`);
      console.log(JSON.stringify({ type: 'configured', action: label, hash: receipt.hash }));
    };

    const weth = await deploy('SepoliaToken', ['Test WETH', 'tWETH', 18]);
    const usdc = await deploy('SepoliaToken', ['Test USDC', 'tUSDC', 6]);
    const dick = await deploy('SepoliaToken', ['Test DICKBUTT', 'tDICK', 18]);
    // The calculator rebuilds balances by scanning Transfer events from this block. It must be the
    // token's own deployment, not the end of the run: anything minted in between would otherwise
    // look like a transfer out of an account the scan believes is empty.
    const tokenDeployBlock = (await dick.deploymentTransaction().wait()).blockNumber;
    const spcxc = await deploy('SepoliaToken', ['Test SPCXc', 'tSPCXc', 8]);
    contracts.weth = weth.target; contracts.usdc = usdc.target;
    contracts.dickbutt = dick.target; contracts.spcxc = spcxc.target; record();

    const distributor = await deploy('DickbuttRewardsDistributor', [spcxc.target, 1, deployer.address]);
    contracts.distributor = distributor.target; record();

    // 1 WETH -> 2 SPCXc, in SPCXc's 8 decimals.
    const router = await deploy('SepoliaSwapRouter', [weth.target, spcxc.target, 2n * 10n ** 8n]);
    const quoter = await deploy('SepoliaQuoter', [router.target]);
    const executor = await deploy('SpcxcSwapExecutor', [weth.target, spcxc.target, router.target,
      distributor.target, usdc.target, 1, 10, ethers.parseEther('1'), 0, deployer.address]);
    contracts.executor = executor.target; record();

    // Genuine Splits factory: this creates two real immutable PushSplit clones on Sepolia.
    const feeRouter = await deploy('SplitsFeeRouter', [SPLITS_FACTORY, weth.target, dick.target,
      roles.kcGreen, roles.burnAddress, roles.cdbVault, executor.target]);
    contracts.feeRouter = feeRouter.target;
    contracts.dickSplit = await feeRouter.dickSplit();
    contracts.wethSplit = await feeRouter.wethSplit();
    console.log(JSON.stringify({ type: 'splits-created', dickSplit: contracts.dickSplit, wethSplit: contracts.wethSplit }));
    record();

    const manager = await deploy('SepoliaPositionManager');
    const locker = await deploy('SepoliaLocker', [manager.target, weth.target, dick.target, deployer.address, 7]);
    await send('locker-position', manager.mint(locker.target, 7));
    const clanker = await deploy('LockerHarvester', [locker.target, manager.target, 7, feeRouter.target, 0, deployer.address]);
    await send('locker-handoff', locker.transferOwnership(clanker.target));
    contracts.clanker = clanker.target; contracts.locker = locker.target; contracts.manager = manager.target; record();

    const unlock = (await provider.getBlock('latest')).timestamp + 365 * 86400;
    const aero = await deploy('AerodromeFeeHarvester', [manager.target, 8, dick.target, spcxc.target,
      roles.burnAddress, distributor.target, unlock, 0, deployer.address]);
    await send('aero-position', manager.mint(deployer.address, 8));
    await send('aero-handoff', manager['safeTransferFrom(address,address,uint256)'](deployer.address, aero.target, 8));
    // Realistic magnitudes: a 1000-wei fee rounds a per-1e18 swap rate to zero, so the price
    // floor and slippage paths would never actually be exercised on the testnet.
    await send('aero-fees', manager.configureFees(dick.target, spcxc.target, ethers.parseEther('5'), 10n ** 8n));
    contracts.aero = aero.target; record();

    // Seed the legacy Safes so the first fee cycle has all three sources to harvest.
    const module = await deploy('LegacyModuleMock');
    const safes = [await deploy('LegacySafeMock', [module.target]), await deploy('LegacySafeMock', [module.target])];
    const legacy = await deploy('LegacyFeeHarvester', [module.target, safes.map(s => s.target), dick.target, feeRouter.target]);
    await send('legacy-handoff', module.updateTokenCreator(dick.target, legacy.target));
    await send('legacy-seed-current', dick.mint(safes[0].target, ethers.parseEther('600')));
    await send('legacy-seed-historic', dick.mint(safes[1].target, ethers.parseEther('500')));
    contracts.legacy = legacy.target; contracts.legacySafes = safes.map(s => s.target); record();

    // Roles. The deployer keeps ownership only long enough to wire them, then hands to the owner.
    await send('set-keeper', distributor.setKeeper(roles.keeper, true));
    await send('set-proposer', distributor.setProposer(roles.proposer, true));
    await send('set-guardian', distributor.setGuardian(roles.guardian));
    await send('set-swap-keeper', executor.setKeeper(roles.keeper, true));
    // The floor bot signs with a narrow role, never the owner key. The bound is set first so no
    // floor setter is ever approved unbounded; half the stand-in rate leaves the 5% discount room.
    await send('set-floor-lower-bound', executor.setFloorLowerBound(10n ** 8n));
    await send('set-floor-setter', executor.setFloorSetter(roles.ops, true));

    const deployedAtBlock = await provider.getBlockNumber();
    const manifest = buildManifest({
      chainId: Number(chainId), quoter: quoter.target, contracts, roles, deployedAtBlock,
      tokenDeployBlock,
      notes: [
        'Base Sepolia rehearsal deployment. Not a launch.',
        'Splits factory, implementation and Warehouse are the GENUINE protocol contracts.',
        'Swap router, quoter, tokens, Clanker locker, Aerodrome manager and legacy module are stand-ins.',
        'Tokens are open faucets: anyone can mint, so balances prove nothing about the pipeline economics.',
        'Ownership transfer to the owner multisig is a separate, deliberate step; see docs/SEPOLIA.md.',
      ],
    });
    fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');

    const calculatorConfig = buildCalculatorConfig({
      chainId: Number(chainId), contracts, roles, deployBlock: tokenDeployBlock,
      holderThresholdRaw: ethers.parseEther('6900000').toString(), batchSize: 50,
    });
    const configPath = outPath.replace(/\.json$/, '') + '-calculator.json';
    fs.writeFileSync(configPath, JSON.stringify(calculatorConfig, null, 2) + '\n');
    fs.rmSync(partial, { force: true });

    console.log(JSON.stringify({ type: 'deploy-complete', manifest: path.relative(ROOT, outPath),
      calculatorConfig: path.relative(ROOT, configPath), deployedAtBlock,
      ownershipStillHeldBy: deployer.address }, null, 2));
    return manifest;
  } finally { closeProvider(provider); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    let message = error.code ? 'deployment RPC/signing failure; inspect the .partial manifest and the chain' : error.message;
    for (const secret of [process.env.RPC_URL, process.env.DEPLOYER_PRIVATE_KEY].filter(Boolean)) {
      message = message.split(secret).join('[redacted]');
    }
    console.error(JSON.stringify({ type: 'deploy-error', message }));
    process.exitCode = 1;
  });
}
