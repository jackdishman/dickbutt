#!/usr/bin/env node
// Deploy the application contracts to Base mainnet (8453) and emit the manifests the fee, floor and
// keeper CLIs consume.
//
// This deploys OUR contracts only. DICKBUTT, SPCXc, WETH, USDC, the Splits factory, the Aerodrome
// router, the Clanker locker and the legacy module all already exist and are verified, never
// deployed, here. It performs NO custody handoff: claiming legacy fees, assigning creator authority,
// moving locker ownership and transferring the LP NFT are permanent multisig steps and are printed
// as instructions instead. See docs/MAINNET-DEPLOY.md.
//
// Dry run is the default. Nothing is signed without --execute.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { buildManifest, buildCalculatorConfig } from '../operations/deployment.js';
import { validateDeployment, validateExclusions, validatePoolFacts } from '../operations/preflight.js';
import {
  MAINNET, MANUAL_STEPS, parseMainnetArgs, validateParams, resolveQuoter,
  validateDeployerIsolation, buildDeploymentPlan,
} from '../operations/mainnet-deploy.js';
import { closeProvider, createRpcProvider } from '../operations/provider.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));

const USAGE = `Usage: npm run deploy:mainnet -- --params <params.json> [--out <manifest.json>] [--execute] [--resume] [--force]

Base mainnet only. Requires BASE_RPC_URL (archive) and, with --execute, DEPLOYER_PRIVATE_KEY.

  --params   Production magnitudes. Every field is required; see config/params-mainnet.example.json.
  --config   Address config. Defaults to config/base-mainnet.json.
  --out      Manifest path. Refuses to overwrite without --force.
  --execute  Actually sign. Without it this validates everything and prints the plan.
  --resume   Continue an interrupted deployment from its .partial file. Implies a real run.
  --force    Allow overwriting an existing manifest. Read the old one first.

Run npm run preflight -- --strict first. This script re-checks the same rules, but preflight is the
one that also re-quotes the swap route against live liquidity.`;

const CODE_REQUIRED = [
  ['dickbutt', c => c.dickbutt], ['spcxc', c => c.spcxc], ['weth', c => c.weth], ['usdc', c => c.usdc],
  ['clankerLocker', c => c.clankerLocker], ['clankerPositionManager', c => c.clankerPositionManager],
  ['aerodrome.router', c => c.aerodrome.router], ['rewardsPool.manager', c => c.rewardsPool.manager],
  ['rewardsPool.pool', c => c.rewardsPool.pool],
];

export async function main(args = process.argv.slice(2), env = process.env) {
  const o = parseMainnetArgs(args);
  if (o.help) { console.log(USAGE); return; }

  const config = read(o.config ?? 'config/base-mainnet.json');
  const params = JSON.parse(fs.readFileSync(path.resolve(o.params), 'utf8'));
  const legacy = read('config/legacy-fees.json');
  const splits = read('config/splits.json');
  const candidates = read('config/route-candidates.json');
  if (config.chainId !== MAINNET) throw Error(`--config must describe Base mainnet; it declares chain ${config.chainId}`);

  // Everything answerable from files is answered before the RPC is even contacted, so a missing
  // decision costs a second rather than a half-finished deployment.
  const fileErrors = [
    ...validateDeployment(config.deployment ?? {}),
    ...validateExclusions(config),
    ...validateParams(params),
  ];
  if (fileErrors.length) throw Error(`configuration rejected:\n  - ${fileErrors.join('\n  - ')}`);
  const { quoter, generation } = resolveQuoter(config, candidates);
  if (!splits.factory) throw Error('config/splits.json must record the Splits factory');
  const plan = buildDeploymentPlan({ config, params, legacy, splits, quoter });

  if (!env.BASE_RPC_URL) throw Error('BASE_RPC_URL is required (archive node: the token deploy block is verified)');
  const provider = createRpcProvider(env.BASE_RPC_URL, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  provider.pollingInterval = 4000;
  try {
    const { chainId } = await provider.getNetwork();
    if (chainId !== BigInt(MAINNET)) throw Error(`deployment is restricted to Base mainnet (8453); RPC reports ${chainId}`);
    const block = await provider.getBlock('finalized');
    if (!block?.hash) throw Error('finalized block unavailable');
    const tag = { blockTag: block.number };

    // External dependencies. A typo in any of these is a contract pointed at nothing, discovered
    // after the immutable Splits already exist.
    const chainErrors = [];
    for (const [label, pick] of CODE_REQUIRED) {
      if ((await provider.getCode(pick(config), tag)) === '0x') chainErrors.push(`${label} has no code at the finalized block`);
    }
    if ((await provider.getCode(splits.factory, tag)) === '0x') chainErrors.push('the Splits factory has no code');
    if ((await provider.getCode(quoter, tag)) === '0x') chainErrors.push(`resolved quoter ${quoter} has no code`);
    if ((await provider.getCode(legacy.feeModule, tag)) === '0x') chainErrors.push('the legacy fee module has no code');
    for (const safe of legacy.safes) {
      if ((await provider.getCode(safe.address, tag)) === '0x') chainErrors.push(`legacy safe ${safe.address} has no code`);
    }
    const erc20 = ['function decimals() view returns(uint8)', 'function symbol() view returns(string)'];
    const dick = new ethers.Contract(config.dickbutt, erc20, provider);
    const spcxc = new ethers.Contract(config.spcxc, erc20, provider);
    if (Number(await dick.decimals(tag)) !== 18) chainErrors.push('DICKBUTT is not an 18 decimal token at this address');
    if (Number(await spcxc.decimals(tag)) !== 8) chainErrors.push('SPCXc is not an 8 decimal token at this address');

    // The calculator trusts deployBlock absolutely: it scans Transfer events from there and treats
    // whatever it finds as the complete history. Prove it is the creation block rather than a
    // plausible number somebody pasted.
    const created = params.dickbuttDeployBlock;
    if (created > block.number) chainErrors.push('params.dickbuttDeployBlock is after the finalized head');
    else {
      const [before, at] = await Promise.all([
        provider.getCode(config.dickbutt, { blockTag: created - 1 }),
        provider.getCode(config.dickbutt, { blockTag: created }),
      ]);
      if (at === '0x') chainErrors.push(`DICKBUTT has no code at block ${created}: this is not its deployment block`);
      else if (before !== '0x') chainErrors.push(`DICKBUTT already existed before block ${created}: history before it would be lost`);
    }

    // Same pool rules preflight enforces. Duplicated deliberately rather than refactoring a working
    // production tool on the way to a launch; preflight remains the authority on live liquidity.
    const poolAbi = ['function token0() view returns(address)', 'function token1() view returns(address)',
      'function factory() view returns(address)', 'function fee() view returns(uint24)',
      'function tickSpacing() view returns(int24)', 'function liquidity() view returns(uint128)'];
    const managerAbi = ['function factory() view returns(address)', 'function ownerOf(uint256) view returns(address)',
      'function positions(uint256) view returns(uint96,address,address,address,int24,int24,int24,uint128,uint256,uint256,uint128,uint128)'];
    const desired = config.rewardsPool;
    const pool = new ethers.Contract(desired.pool, poolAbi, provider);
    const manager = new ethers.Contract(desired.manager, managerAbi, provider);
    const factory = new ethers.Contract(desired.factory, ['function getUnstakedFee(address) view returns(uint24)'], provider);
    const position = await manager.positions(desired.tokenId, tag);
    const facts = {
      token0: await pool.token0(tag), token1: await pool.token1(tag), factory: await pool.factory(tag),
      managerFactory: await manager.factory(tag), fee: await pool.fee(tag), tickSpacing: await pool.tickSpacing(tag),
      liquidity: await pool.liquidity(tag), positionOwner: await manager.ownerOf(desired.tokenId, tag),
      positionToken0: position[2], positionToken1: position[3], positionTickSpacing: position[4],
      tickLower: position[5], tickUpper: position[6], positionLiquidity: position[7],
      unstakedFee: await factory.getUnstakedFee(desired.pool, tag),
    };
    chainErrors.push(...validatePoolFacts(facts, { tokens: [config.dickbutt, config.spcxc], ...desired }));
    if (params.aerodromeUnlockTime <= block.timestamp) chainErrors.push('params.aerodromeUnlockTime is already in the past');
    if (chainErrors.length) throw Error(`on-chain verification rejected:\n  - ${chainErrors.join('\n  - ')}`);

    const outPath = path.resolve(o.out);
    const partial = `${outPath}.partial`;
    if (!o.execute) {
      console.log(JSON.stringify({
        type: 'deploy-plan', dryRun: true, chainId: MAINNET, finalizedBlock: block.number,
        aerodromeGeneration: generation, quoter,
        deployments: plan.deployments, actions: plan.actions, handoffs: plan.handoffs,
        manualStepsAfterwards: MANUAL_STEPS,
        note: 'Nothing was signed. Re-run with --execute to deploy.',
      }, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
      return plan;
    }

    if (!env.DEPLOYER_PRIVATE_KEY) throw Error('DEPLOYER_PRIVATE_KEY is required with --execute');
    if (fs.existsSync(partial) && !o.resume) throw Error(`${partial} exists; inspect it and use --resume to continue the same deployment`);
    if (o.resume && !fs.existsSync(partial)) throw Error('--resume requires an existing partial deployment');
    if (fs.existsSync(outPath) && !o.force) {
      throw Error(`${o.out} already exists; a new deployment would orphan the contracts it names. Review it, then pass --force`);
    }
    const deployer = new ethers.Wallet(env.DEPLOYER_PRIVATE_KEY, provider);
    const isolation = validateDeployerIsolation(deployer.address, { ...config.deployment, ops: config.deployment.floorSetter });
    if (isolation.length) throw Error(`deployer key rejected:\n  - ${isolation.join('\n  - ')}`);
    const balance = await provider.getBalance(deployer.address);
    if (balance < ethers.parseEther(o.resume ? '0.005' : '0.05')) {
      throw Error(`deployer ${deployer.address} holds ${ethers.formatEther(balance)} ETH; fund it before deploying`);
    }
    console.log(JSON.stringify({ type: 'deploy-start', chainId: MAINNET, deployer: deployer.address, balance: ethers.formatEther(balance) }));

    const progress = o.resume ? JSON.parse(fs.readFileSync(partial, 'utf8'))
      : { incomplete: true, chainId: MAINNET, deployer: deployer.address, contracts: {}, deployments: {}, actions: {} };
    if (progress.deployer.toLowerCase() !== deployer.address.toLowerCase() || progress.chainId !== MAINNET
      || !progress.deployments || !progress.actions) throw Error('partial deployment identity or recovery metadata missing');
    const json = value => JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
    const record = () => { fs.writeFileSync(`${partial}.tmp`, JSON.stringify(progress, null, 2)); fs.renameSync(`${partial}.tmp`, partial); };
    record();
    // Binding the plan to the partial file means a resume cannot quietly continue with different
    // constructor arguments than the run it is resuming.
    const planHash = ethers.keccak256(ethers.toUtf8Bytes(json(plan)));
    if (progress.planHash && progress.planHash !== planHash) throw Error('deployment plan changed during recovery; start a fresh deployment');
    progress.planHash = planHash; record();

    const artifact = name => {
      const file = path.join(ROOT, 'out', `${name}.sol`, `${name}.json`);
      if (!fs.existsSync(file)) throw Error(`artifact not found for ${name}; run forge build`);
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    };
    const live = { deployer: deployer.address };
    const resolve = value => (value && typeof value === 'object' && value.ref)
      ? (live[value.ref] ?? (() => { throw Error(`unresolved reference ${value.ref}`); })())
      : value;

    let index = 0;
    for (const step of plan.deployments) {
      const a = artifact(step.name);
      const args_ = step.args.map(resolve);
      const key = ethers.keccak256(ethers.toUtf8Bytes(json([index++, step.name, args_])));
      const saved = progress.deployments[key];
      if (saved) {
        if (saved.hash) {
          const receipt = await provider.waitForTransaction(saved.hash, 1, 300000);
          if (!receipt || Number(receipt.status) !== 1) throw Error(`unresolved or failed deployment ${step.name}: ${saved.hash}`);
        }
        if ((await provider.getCode(saved.address)) === '0x') throw Error(`resume contract missing: ${step.name}`);
        live[step.name] = saved.address;
        console.log(JSON.stringify({ type: 'resumed', name: step.name, address: saved.address }));
        continue;
      }
      const contract = await new ethers.ContractFactory(a.abi, a.bytecode.object, deployer).deploy(...args_);
      progress.deployments[key] = { name: step.name, address: contract.target, hash: contract.deploymentTransaction().hash };
      record();
      await contract.deploymentTransaction().wait(3);
      let visible = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        if ((await provider.getCode(contract.target)) !== '0x') { visible = true; break; }
        await new Promise(r => setTimeout(r, 3000));
      }
      if (!visible) throw Error(`confirmed deployment not yet readable: ${step.name}; resume once the RPC catches up`);
      live[step.name] = await contract.getAddress();
      console.log(JSON.stringify({ type: 'deployed', name: step.name, address: live[step.name] }));
    }

    const contracts = progress.contracts;
    Object.assign(contracts, {
      weth: config.weth, usdc: config.usdc, dickbutt: config.dickbutt, spcxc: config.spcxc,
      distributor: live.DickbuttRewardsDistributor, executor: live.SpcxcSwapExecutor,
      feeRouter: live.SplitsFeeRouter, clanker: live.LockerHarvester, aero: live.AerodromeFeeHarvester,
      legacy: live.LegacyFeeHarvester, locker: config.clankerLocker, manager: config.clankerPositionManager,
      legacySafes: legacy.safes.map(s => s.address),
    });
    const router = new ethers.Contract(live.SplitsFeeRouter,
      ['function dickSplit() view returns(address)', 'function wethSplit() view returns(address)'], provider);
    contracts.dickSplit = await router.dickSplit();
    contracts.wethSplit = await router.wethSplit();
    console.log(JSON.stringify({ type: 'splits-created', dickSplit: contracts.dickSplit, wethSplit: contracts.wethSplit }));
    record();

    const abiOf = name => artifact(name).abi;
    const send = async ({ label, contract, method, args: callArgs }) => {
      if (!progress.actions[label]) {
        const instance = new ethers.Contract(live[contract], abiOf(contract), deployer);
        const tx = await instance[method](...callArgs.map(resolve));
        progress.actions[label] = tx.hash; record();
      }
      const receipt = await provider.waitForTransaction(progress.actions[label], 2, 300000);
      if (!receipt) throw Error(`unresolved configuration ${label}: ${progress.actions[label]}`);
      if (Number(receipt.status) !== 1) throw Error(`${label} failed: ${receipt.hash}`);
      console.log(JSON.stringify({ type: 'configured', action: label, hash: receipt.hash }));
    };
    for (const action of plan.actions) await send(action);
    // Last, and only after every role is wired: once ownership is pending the deployer can still
    // fix a mistake, but the multisig accepting is the point of no return.
    for (const handoff of plan.handoffs) await send(handoff);

    const roles = { ...config.deployment, ops: config.deployment.floorSetter };
    const manifest = buildManifest({
      chainId: MAINNET, quoter, contracts, roles,
      deployedAtBlock: await provider.getBlockNumber(),
      tokenDeployBlock: params.dickbuttDeployBlock,
      notes: [
        'Base mainnet production deployment of this repository\'s contracts only.',
        'Tokens, Splits factory, Aerodrome router, Clanker locker and legacy module are pre-existing external contracts.',
        `Aerodrome Slipstream generation: ${generation}.`,
        'Ownership is TRANSFERRED BUT NOT ACCEPTED: each contract is Ownable2Step and the multisig must call acceptOwnership.',
        'No custody handoff was performed. Legacy claim, creator authority, locker ownership and the LP NFT remain outstanding.',
      ],
    });
    fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');

    const calculatorConfig = buildCalculatorConfig({
      chainId: MAINNET, contracts, roles, deployBlock: params.dickbuttDeployBlock,
      holderThresholdRaw: params.holderThresholdRaw, payoutThresholdRaw: params.payoutThresholdRaw,
      curve: params.curve, batchSize: params.batchSize, chunkSize: params.chunkSize,
    });
    const configPath = outPath.replace(/\.json$/, '') + '-calculator.json';
    fs.writeFileSync(configPath, JSON.stringify(calculatorConfig, null, 2) + '\n');
    fs.writeFileSync(`${outPath}.receipts.json`, JSON.stringify(progress, null, 2) + '\n');
    fs.rmSync(partial, { force: true });

    console.log(JSON.stringify({
      type: 'deploy-complete', manifest: path.relative(ROOT, outPath),
      calculatorConfig: path.relative(ROOT, configPath),
      ownershipPendingAcceptanceBy: config.deployment.owner,
      stillHeldByDeployerUntilAccepted: deployer.address,
      remaining: MANUAL_STEPS,
    }, null, 2));
    return manifest;
  } finally { closeProvider(provider); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    let message = error.shortMessage ?? error.message;
    for (const secret of [process.env.BASE_RPC_URL, process.env.DEPLOYER_PRIVATE_KEY].filter(Boolean)) {
      message = message.split(secret).join('[redacted]');
    }
    console.error(JSON.stringify({ type: 'deploy-error', code: error.code ?? null, action: error.action ?? null, message }));
    process.exitCode = 1;
  });
}
