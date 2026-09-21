#!/usr/bin/env node
// Price-floor refresher and monitor. Runs on separate infrastructure from the keeper: it reads
// OPS_PRIVATE_KEY (never KEEPER_PRIVATE_KEY), takes its own lock namespace, and refuses a signer
// that is an approved keeper. --monitor needs no key at all and is the alerting role.
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { assertExecutionNetwork } from '../operations/execution-network.js';
import { runFloorRefresh } from '../operations/floor.js';
import { closeProvider, createRpcProvider } from '../operations/provider.js';

const USAGE = `Usage: npm run floor -- --config deployment.json [--execute] [--allow-mainnet] [--monitor] [--force]
                    [--lifetime-hours 20] [--refresh-before-hours 8] [--warn-before-hours 4]
                    [--slippage-bps 500] [--max-deviation-bps 5000]

Default is a dry run that reports the active floor and time remaining.
  --monitor   Read-only. Never loads a key. Exit 2 when the floor is inside the warning window
              or already expired. Run this on a third host, or in an uptime checker.
  --execute   Refresh the floor. Requires OPS_PRIVATE_KEY.
  --allow-mainnet  Explicit Base 8453 opt-in, with a matching reviewed deployment manifest.

Environment: RPC_URL; OPS_PRIVATE_KEY for --execute. KEEPER_PRIVATE_KEY is never read.
Exit codes: 0 fresh or refreshed, 2 needs attention, 1 failure.`;

export function parseFloorArgs(args) {
  const o = { execute: false, allowMainnet: false, monitor: false, force: false,
    lifetimeSeconds: 20 * 3600, refreshBeforeSeconds: 8 * 3600, warnBeforeSeconds: 4 * 3600,
    slippageBps: 500, maxDeviationBps: 5000 };
  const hours = { '--lifetime-hours': 'lifetimeSeconds', '--refresh-before-hours': 'refreshBeforeSeconds', '--warn-before-hours': 'warnBeforeSeconds' };
  const ints = { '--slippage-bps': 'slippageBps', '--max-deviation-bps': 'maxDeviationBps' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute') o.execute = true;
    else if (arg === '--allow-mainnet') o.allowMainnet = true;
    else if (arg === '--monitor') o.monitor = true;
    else if (arg === '--force') o.force = true;
    else if (arg === '--help') o.help = true;
    else if (arg === '--config') { o.configPath = args[++i]; if (!o.configPath || o.configPath.startsWith('--')) throw Error('missing value for --config'); }
    else if (hours[arg] || ints[arg]) {
      const raw = Number(args[++i]);
      if (!Number.isFinite(raw)) throw Error(`missing or invalid value for ${arg}`);
      if (hours[arg]) { const s = Math.round(raw * 3600); if (!Number.isSafeInteger(s) || s <= 0) throw Error(`invalid value for ${arg}`); o[hours[arg]] = s; }
      else { if (!Number.isInteger(raw)) throw Error(`${arg} must be an integer`); o[ints[arg]] = raw; }
    } else throw Error(`unknown floor option: ${arg.startsWith('--') ? arg : 'positional argument'}`);
  }
  if (o.help) return o;
  if (!o.configPath) throw Error('--config is required (reviewed deployment manifest)');
  if (o.monitor && o.execute) throw Error('--monitor is read-only; it cannot be combined with --execute');
  if (o.force && !o.execute) throw Error('--force only applies to --execute');
  return o;
}

// Distinct from the keeper's lock name on purpose: the two roles must never serialise against each
// other, and a shared name would imply they belong on the same host.
function acquireFloorLock(chainId, address) {
  const location = path.join(os.tmpdir(), `dickbutt-floor-${chainId}-${address.toLowerCase()}.lock`);
  try { fs.mkdirSync(location, { mode: 0o700 }); }
  catch { throw Error(`floor lock exists: ${location}; verify its owner and pending transactions before manual recovery`); }
  fs.writeFileSync(path.join(location, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString() }), { mode: 0o600 });
  return () => fs.rmSync(location, { recursive: true });
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const o = parseFloorArgs(args);
  if (o.help) { console.log(USAGE); return; }
  if (!env.RPC_URL) throw Error('RPC_URL is required');
  const config = JSON.parse(fs.readFileSync(o.configPath, 'utf8'));
  const provider = createRpcProvider(env.RPC_URL, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  let release;
  try {
    const chainId = (await provider.getNetwork()).chainId;
    if (String(chainId) !== String(config.chainId)) throw Error('RPC/config chain mismatch');
    assertExecutionNetwork({chainId,execute:o.execute,allowMainnet:o.allowMainnet,config});

    let signer, signerAddress;
    if (o.execute) {
      if (!env.OPS_PRIVATE_KEY) throw Error('OPS_PRIVATE_KEY is required for --execute');
      if (env.KEEPER_PRIVATE_KEY && env.KEEPER_PRIVATE_KEY === env.OPS_PRIVATE_KEY) {
        throw Error('OPS_PRIVATE_KEY equals KEEPER_PRIVATE_KEY; the floor bot must hold a separate key on separate infrastructure');
      }
      signer = new ethers.Wallet(env.OPS_PRIVATE_KEY, provider);
      signerAddress = signer.address;
      release = acquireFloorLock(String(chainId), signerAddress);
      const [latest, pending] = await Promise.all([
        provider.getTransactionCount(signerAddress, 'latest'),
        provider.getTransactionCount(signerAddress, 'pending'),
      ]);
      if (latest !== pending) throw Error('ops signer has pending transactions; resolve them before refreshing');
    }

    const c = config.contracts;
    const abi = name => JSON.parse(fs.readFileSync(new URL(`../out/${name}.sol/${name}.json`, import.meta.url))).abi;
    const executor = new ethers.Contract(c.executor, abi('SpcxcSwapExecutor'), signer ?? provider);
    const quoter = new ethers.Contract(config.quoter, ['function quoteExactInput(bytes,uint256) returns(uint256,uint160[],uint32[],uint256)'], provider);
    const swapPath = await executor.swapPath();

    const result = await runFloorRefresh({
      provider, executor, signerAddress, execute: o.execute, allowMainnet:o.allowMainnet, config, force: o.force,
      lifetimeSeconds: o.lifetimeSeconds, refreshBeforeSeconds: o.refreshBeforeSeconds,
      warnBeforeSeconds: o.warnBeforeSeconds, slippageBps: o.slippageBps, maxDeviationBps: o.maxDeviationBps,
      quote: async amount => (await quoter.quoteExactInput.staticCall(swapPath, amount))[0],
      onEvent: event => console.log(JSON.stringify(event)),
    });
    console.log(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    if (result.alert) process.exitCode = 2;
    return result;
  } finally { release?.(); closeProvider(provider); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    let message = error.code ? 'RPC/signing operation failed; inspect provider status and the executor floor' : error.message;
    for (const secret of [process.env.RPC_URL, process.env.OPS_PRIVATE_KEY, process.env.KEEPER_PRIVATE_KEY].filter(Boolean)) {
      message = message.split(secret).join('[redacted]');
    }
    console.error(JSON.stringify({ type: 'floor-error', message }));
    process.exitCode = 1;
  });
}
