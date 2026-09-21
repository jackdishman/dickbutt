#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { assertExecutionNetwork } from '../operations/execution-network.js';
import { runKeeper, KEEPER_ABI } from '../keeper/engine.js';
import { closeProvider, createRpcProvider } from '../operations/provider.js';
import { stringify } from '../calculator/journal.js';

export function parseKeeperArgs(args) {
 const options={execute:false,allowMainnet:false,propose:false,proposeOnly:false,confirmations:1,lockWaitSeconds:300};
 for(let i=0;i<args.length;i++) {
  const arg=args[i];
  if(arg==='--execute') options.execute=true;
  else if(arg==='--allow-mainnet') options.allowMainnet=true;
  else if(arg==='--propose') options.propose=true;
  else if(arg==='--propose-only') {options.propose=true;options.proposeOnly=true;}
  else if(arg==='--help') options.help=true;
  else if(['--config','--journal','--confirmations','--lock-wait'].includes(arg)) {
   const value=args[++i];
   if(!value||value.startsWith('--'))throw Error(`missing value for ${arg}`);
   if(arg==='--config')options.configPath=value;
   if(arg==='--journal')options.dir=value;
   if(arg==='--confirmations')options.confirmations=Number(value);
   if(arg==='--lock-wait')options.lockWaitSeconds=Number(value);
  } else throw Error(`unknown keeper option: ${arg.startsWith('--')?arg:'positional argument'}`);
 }
 if(options.help)return options;
 if(!options.configPath)throw Error('--config is required (reviewed calculator configuration JSON)');
 if(!options.dir)throw Error('--journal is required (calculator data directory)');
 if(options.propose&&!options.execute)throw Error('--propose requires --execute');
 if(!Number.isSafeInteger(options.confirmations)||options.confirmations<1)throw Error('invalid confirmations');
 if(!Number.isSafeInteger(options.lockWaitSeconds)||options.lockWaitSeconds<0)throw Error('invalid lock wait');
 return options;
}

export async function main(args=process.argv.slice(2),env=process.env) {
 const options=parseKeeperArgs(args);
 if(options.help) {
  console.log('Usage: node script/run-keeper.mjs --config calculator-config.json --journal ./data [--execute] [--allow-mainnet] [--propose|--propose-only] [--confirmations 1] [--lock-wait 300]\nDefault: dry run. Base mainnet execution additionally requires --allow-mainnet and a matching reviewed calculator config.\nEnvironment: RPC_URL; execution requires KEEPER_PRIVATE_KEY. Proposals use PROPOSER_PRIVATE_KEY (or OWNER_PRIVATE_KEY).\n--propose-only commits roots and stops; it refuses to run where KEEPER_PRIVATE_KEY is set.\n--lock-wait waits this many seconds for another run on the same signer to finish before failing.\nExit 2: recipients unpaid, a proposal rate limited, or a foreign root at a planned round id.');
  return;
 }
 if(!env.RPC_URL)throw Error('RPC_URL is required');
 const config=JSON.parse(fs.readFileSync(options.configPath,'utf8'));
 const provider=createRpcProvider(env.RPC_URL,undefined,{cacheTimeout:-1});
 try {
  const chainId=(await provider.getNetwork()).chainId.toString();
  assertExecutionNetwork({chainId,execute:options.execute,allowMainnet:options.allowMainnet,config,configKind:'calculator'});
  let signer,ownerSigner;
  if(options.execute) {
   // PROPOSER_PRIVATE_KEY is the bot role; OWNER_PRIVATE_KEY stays supported for a multisig
   // EOA or an older deployment. Either way it must not be the keeper key.
   const proposerKey=env.PROPOSER_PRIVATE_KEY||env.OWNER_PRIVATE_KEY;
   if(options.proposeOnly) {
    // The whole point: this host commits roots and never needs the key that moves funds.
    if(!proposerKey)throw Error('PROPOSER_PRIVATE_KEY is required for --propose-only');
    if(env.KEEPER_PRIVATE_KEY)throw Error('--propose-only must run on a host without KEEPER_PRIVATE_KEY');
    ownerSigner=new ethers.Wallet(proposerKey,provider);
    signer=ownerSigner;
   } else {
    if(!env.KEEPER_PRIVATE_KEY)throw Error('KEEPER_PRIVATE_KEY is required for execution');
    signer=new ethers.Wallet(env.KEEPER_PRIVATE_KEY,provider);
    if(options.propose&&proposerKey===env.KEEPER_PRIVATE_KEY&&env.PROPOSER_PRIVATE_KEY) throw Error('PROPOSER_PRIVATE_KEY equals KEEPER_PRIVATE_KEY; the proposer must hold a separate key');
    ownerSigner=options.propose&&proposerKey?new ethers.Wallet(proposerKey,provider):signer;
   }
   // The engine checks fresh nonces after acquiring every involved signer lock. Checking
   // here would become stale while waiting behind a fee or payout job using the same key.
  }
  const result=await runKeeper({...options,config,provider,
   distributor:new ethers.Contract(config.distributor,KEEPER_ABI,signer??provider),
   signerAddress:signer?.address,ownerAddress:ownerSigner?.address,
   ownerDistributor:new ethers.Contract(config.distributor,KEEPER_ABI,ownerSigner??provider),
   onEvent:event=>console.log(stringify(event)),
  });
  console.log(stringify(result));
  if(result.rounds.some(round=>['partial','closed-unpaid','proposal-rate-limited','foreign-commitment'].includes(round.status)))process.exitCode=2;
  return result;
 } finally { closeProvider(provider); }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 main().catch(error=>{
  // Provider errors can embed URLs, request bodies or signing material. Report only a sanitized summary.
  let message=error.code?'RPC/signing operation failed; inspect transaction events and provider status':error.message;
  for(const value of [process.env.RPC_URL,process.env.KEEPER_PRIVATE_KEY,process.env.OWNER_PRIVATE_KEY,process.env.PROPOSER_PRIVATE_KEY].filter(Boolean))message=message.split(value).join('[redacted]');
  console.error(stringify({type:'keeper-error',message}));
  process.exitCode=1;
 });
}
