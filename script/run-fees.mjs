#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {Contract,Wallet} from 'ethers';
import {fileURLToPath} from 'node:url';
import {aerodromeHarvesterName, verifyAerodromeRuntime} from '../operations/aerodrome.js';
import { assertExecutionNetwork } from '../operations/execution-network.js';
import {runFeeCycle} from '../operations/fees.js';
import { closeProvider, createRpcProvider } from '../operations/provider.js';
import {acquireExecutionLock} from '../keeper/engine.js';
export function parseFeeArgs(args) {
  const options={execute:false,allowMainnet:false};
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--execute')options.execute=true;
    else if(args[i]==='--allow-mainnet')options.allowMainnet=true;
    else if(args[i]==='--help')options.help=true;
    else if(args[i]==='--config') {
      options.configPath=args[++i];
      if(!options.configPath||options.configPath.startsWith('--'))throw Error('missing value for --config');
    } else throw Error('unknown fee option');
  }
  if(!options.help&&!options.configPath)throw Error('--config is required');
  return options;
}
export async function main(args=process.argv.slice(2),env=process.env) {
const {execute,allowMainnet,configPath,help}=parseFeeArgs(args);
if(help) {
  console.log('Usage: npm run fees -- --config deployment.json [--execute] [--allow-mainnet]\nRead-only by default. RPC_URL and (for execution) KEEPER_PRIVATE_KEY. Base mainnet execution additionally requires --allow-mainnet and a matching reviewed manifest.');return;
}
if(!env.RPC_URL)throw Error('RPC_URL required');
const config=JSON.parse(fs.readFileSync(configPath));
const provider=createRpcProvider(env.RPC_URL,undefined,{batchMaxCount:1,cacheTimeout:-1});
let release;
try {
  const chainId=(await provider.getNetwork()).chainId;
  if(String(chainId)!==String(config.chainId))throw Error('RPC/config chain mismatch');
  assertExecutionNetwork({chainId,execute,allowMainnet,config});
  const signer=execute?new Wallet(env.KEEPER_PRIVATE_KEY,provider):provider;
  const address=execute?await signer.getAddress():undefined;
  const marker=path.join(path.dirname(path.resolve(configPath)),'fee-pending-transaction.json');
  if(execute){
    // The payout job shares this signer and its lock; wait out an overlap rather than page about it.
    release=acquireExecutionLock(String(chainId),address,{waitMs:300_000});
    if(await provider.getTransactionCount(address,'pending')!==await provider.getTransactionCount(address,'latest'))throw Error('signer has pending transactions; resolve before retry');
    if(fs.existsSync(marker)) {
      const entry=JSON.parse(fs.readFileSync(marker)),receipt=await provider.getTransactionReceipt(entry.hash);
      if(!receipt)throw Error(`unresolved transaction ${entry.hash}`);
      fs.unlinkSync(marker);
    }
  }
  const c=config.contracts;
  const artifact=name=>JSON.parse(fs.readFileSync(new URL(`../out/${name}.sol/${name}.json`,import.meta.url))).abi;
  const at=(name,address)=>new Contract(address,artifact(name),signer);
  const executor=at('SpcxcSwapExecutor',c.executor),feeRouter=at('SplitsFeeRouter',c.feeRouter);
  const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
  if(!same(await executor.weth(),c.weth)||!same(await executor.spcxc(),c.spcxc)||!same(await executor.distributor(),c.distributor)||!same(await feeRouter.swapExecutor(),c.executor)||!same(await feeRouter.weth(),c.weth)||!same(await feeRouter.dickbutt(),c.dickbutt))throw Error('deployed fee path differs from config');
  const aero=c.aero?at(aerodromeHarvesterName({kind:config.sources?.aerodromeKind}),c.aero):null;
  await verifyAerodromeRuntime(aero,config);
  const quoter=new Contract(config.quoter,['function quoteExactInput(bytes,uint256) returns(uint256,uint160[],uint32[],uint256)'],provider);
  const swapPath=await executor.swapPath();
  const onEvent=event=>{
    if(event.status==='submitted'){
      const fd=fs.openSync(marker,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({...event,chainId:String(chainId),signer:address}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    }
    if(['confirmed','reverted'].includes(event.status)&&fs.existsSync(marker))fs.unlinkSync(marker);
    console.log(JSON.stringify(event));
  };
  const result=await runFeeCycle({provider,signerAddress:address,execute,allowMainnet,config,
    locker:c.clanker?at('LockerHarvester',c.clanker):null,aero,legacy:c.legacy?at('LegacyFeeHarvester',c.legacy):null,
    feeRouter,executor,weth:new Contract(c.weth,['function balanceOf(address) view returns(uint256)'],provider),quote:async (amount,snapshot)=>(await quoter.quoteExactInput.staticCall(swapPath,amount,snapshot))[0],onEvent});
  console.log(JSON.stringify(result));if(result.swapStatus==='price-floor-refresh-required'||result.attention?.length)process.exitCode=2;
} catch(e) {console.error(e.code?'Fee operation failed; inspect transaction events and RPC status':e.message);process.exitCode=1;}
finally {release?.();closeProvider(provider);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(error=>{console.error(error.code?'Fee operation failed; inspect transaction events and RPC status':error.message);process.exitCode=1;});
}
