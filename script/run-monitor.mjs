#!/usr/bin/env node
// Keyless watchdog. Reads no private key and sends nothing. Run it on a host that shares nothing
// with the bots: a monitor that dies with the keeper it watches is decoration.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { runMonitor } from '../operations/monitor.js';
import { closeProvider, createRpcProvider } from '../operations/provider.js';
import { KEEPER_ABI } from '../keeper/engine.js';
import { Journal } from '../calculator/journal.js';

const USAGE = `Usage: npm run monitor -- --config deployment.json [--calculator calculator-config.json]
                      [--journal ./data] [--min-gas-eth 0.002] [--quiet]

Read-only. Needs RPC_URL. No signing key is ever loaded.
Exit: 0 healthy, 2 needs a human, 1 the check itself failed.`;

export function parseMonitorArgs(args) {
  const o = { minGasEth: '0.002', quiet: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--quiet') o.quiet = true;
    else if (arg === '--help') o.help = true;
    else if (['--config', '--calculator', '--journal', '--min-gas-eth'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Error(`missing value for ${arg}`);
      o[{ '--config': 'configPath', '--calculator': 'calculatorPath', '--journal': 'journalDir', '--min-gas-eth': 'minGasEth' }[arg]] = value;
    } else throw Error(`unknown monitor option: ${arg.startsWith('--') ? arg : 'positional argument'}`);
  }
  if (o.help) return o;
  if (!o.configPath) throw Error('--config is required (deployment manifest)');
  if (Number.isNaN(Number(o.minGasEth)) || Number(o.minGasEth) < 0) throw Error('invalid --min-gas-eth');
  return o;
}

/** Roots the local journal has committed. Without them every on-chain round looks unknown. */
export function journalRoots(dir) {
  if (!dir || !fs.existsSync(path.join(dir, 'periods'))) return null;
  return new Journal(dir).entries().map(({ record }) => record.root).filter(Boolean);
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const o = parseMonitorArgs(args);
  if (o.help) { console.log(USAGE); return; }
  if (!env.RPC_URL) throw Error('RPC_URL is required');
  const manifest = JSON.parse(fs.readFileSync(o.configPath, 'utf8'));
  const provider = createRpcProvider(env.RPC_URL, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  try {
    const chainId = (await provider.getNetwork()).chainId;
    if (String(chainId) !== String(manifest.chainId)) throw Error('RPC/config chain mismatch');

    const abi = name => JSON.parse(fs.readFileSync(new URL(`../out/${name}.sol/${name}.json`, import.meta.url))).abi;
    const executor = new ethers.Contract(manifest.contracts.executor, abi('SpcxcSwapExecutor'), provider);
    const distributor = new ethers.Contract(manifest.contracts.distributor, KEEPER_ABI, provider);

    const roots = journalRoots(o.journalDir);
    if (roots === null && o.journalDir) throw Error(`no calculator journal at ${o.journalDir}`);
    const identity=`${chainId}-${manifest.contracts.distributor.toLowerCase()}`;
    const progressFile=path.join(path.dirname(path.resolve(o.configPath)),`monitor-progress-${identity}.json`);
    const previousProgress=fs.existsSync(progressFile)?JSON.parse(fs.readFileSync(progressFile,'utf8')):null;

    const result = await runMonitor({
      provider, distributor, executor,
      journalRoots: roots,
      gasAccounts: manifest.roles ? {
        keeper: manifest.roles.keeper, proposer: manifest.roles.proposer, ops: manifest.roles.ops, owner: manifest.roles.owner,
      } : {},
      minGasWei: ethers.parseEther(String(o.minGasEth)),
      previousProgress,
    });
    const temporary=`${progressFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(result.progress,null,2)+'\n',{mode:0o600});
    fs.renameSync(temporary,progressFile);

    const output = o.quiet ? { severity: result.severity, attention: result.attention, journal: result.journal } : result;
    console.log(JSON.stringify(output, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    process.exitCode = result.exitCode;
    return result;
  } finally { closeProvider(provider); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const message = error.code ? 'monitor RPC failure; inspect provider status' : error.message;
    console.error(JSON.stringify({ type: 'monitor-error', severity: 'failed', message }));
    process.exitCode = 1;
  });
}
