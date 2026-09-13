import 'dotenv/config';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {ethers} from 'ethers';import {runCalculator} from './calculator/engine.js';import {Journal,stringify} from './calculator/journal.js';import {normalize} from './calculator/core.js';import {ERC20_ABI,DISTRIBUTOR_ABI} from './calculator/chain.js';import {closeProvider,createRpcProvider} from './operations/provider.js';
function integer(value,name,min=1){const n=Number(value);if(!Number.isSafeInteger(n)||n<min)throw Error(`invalid ${name}`);return n;}
export async function main(){
 const dir=path.resolve(process.env.CALCULATOR_DATA_DIR||'.');
 if(process.argv.includes('rebuild-state')){const j=new Journal(dir);j.lock();try{const s=j.rebuild();if(!s)throw Error('no committed journal to rebuild');j.cache(s);console.log(`Rebuilt state through block ${s.lastProcessedBlock}. Plans and batches remain in periods/*.json.`);}finally{j.unlock();}return;}
 // --config takes the exact object the keeper will verify against. Rebuilding the same object
 // from environment variables is possible but one stray value produces a journal the keeper
 // rejects as a configuration identity mismatch, so prefer the file a deployment emitted.
 const flag=process.argv.indexOf('--config'),configPath=flag>=0?process.argv[flag+1]:null;
 if(flag>=0&&(!configPath||configPath.startsWith('--')))throw Error('missing value for --config');
 // --bootstrap commits the first period with a zero pot so round 1 does not weight holders over the
 // token's whole history. Only valid before any period has been journaled; see calculator/README.md.
 const bootstrap=process.argv.includes('--bootstrap');
 if(!process.env.RPC_URL)throw Error('Missing RPC_URL');
 if(!configPath)for(const name of ['DICKBUTT_ADDRESS','DISTRIBUTOR_ADDRESS','DICKBUTT_DEPLOY_BLOCK','PAYOUT_THRESHOLD_RAW','WEIGHTING'])if(!process.env[name])throw Error(`Missing ${name}`);
 const provider=createRpcProvider(process.env.RPC_URL, undefined, {cacheTimeout: -1});try{
 const network=await provider.getNetwork();
 let config;
 if(configPath){
  config=JSON.parse(fs.readFileSync(configPath,'utf8'));
  const expected=['chainId','token','distributor','deployBlock','holderThresholdRaw','payoutThresholdRaw','curve','excluded','batchSize','chunkSize','finalityTag'];
  const actual=Object.keys(config);
  if(actual.length!==expected.length||expected.some((k,i)=>actual[i]!==k))throw Error(`config must contain exactly ${expected.join(', ')} in that order; the calculator hashes its serialization`);
  if(config.chainId!==network.chainId.toString())throw Error(`config chainId ${config.chainId} does not match RPC chain ${network.chainId}`);
  if(!Array.isArray(config.excluded)||!config.excluded.length)throw Error('config.excluded must include pools, burn and pipeline addresses');
 } else {
  const excluded=(process.env.EXCLUDED_ADDRESSES||'').split(',').map(a=>a.trim()).filter(Boolean).map(normalize).sort();if(!excluded.length)throw Error('EXCLUDED_ADDRESSES must include pools and burn addresses');
  const curve=process.env.WEIGHTING;if(!['sqrt','linear'].includes(curve))throw Error('WEIGHTING must be sqrt or linear');
  config={chainId:network.chainId.toString(),token:normalize(process.env.DICKBUTT_ADDRESS),distributor:normalize(process.env.DISTRIBUTOR_ADDRESS),deployBlock:integer(process.env.DICKBUTT_DEPLOY_BLOCK,'deploy block'),holderThresholdRaw:ethers.parseUnits(process.env.HOLDER_THRESHOLD||'6900000',18).toString(),payoutThresholdRaw:BigInt(process.env.PAYOUT_THRESHOLD_RAW).toString(),curve,excluded,batchSize:integer(process.env.BATCH_SIZE||250,'batch size'),chunkSize:integer(process.env.SCAN_CHUNK_SIZE||2000,'scan chunk'),finalityTag:process.env.FINALITY_TAG||'finalized'};
 }
 if(!['sqrt','linear'].includes(config.curve))throw Error('WEIGHTING must be sqrt or linear');
 if(BigInt(config.payoutThresholdRaw)<0n||BigInt(config.holderThresholdRaw)<0n)throw Error('negative threshold');
 const record=await runCalculator({dir,provider,token:new ethers.Contract(config.token,ERC20_ABI,provider),distributor:new ethers.Contract(config.distributor,DISTRIBUTOR_ABI,provider),config,bootstrap});
 if(record.unchanged)console.log('No new finalized period.');
 else if(record.pendingPlan)console.log(stringify({pendingPlan:true,roundId:record.roundId,root:record.plan.root,total:record.plan.total,note:'Round already planned and awaiting proposal; nothing further to calculate until it is committed.'}));
 else console.log(stringify({block:record.block,curve:config.curve,bootstrap:record.bootstrap,roundId:record.roundId,root:record.root,total:record.plan?.total??'0',batches:record.plan?.batches.length??0,superseded:Object.values(record.state?.plans??{}).filter(p=>p.superseded).map(p=>p.roundId),journal:path.join(dir,'periods')}));
 console.log('Nothing submitted on-chain. Review the committed period plan before proposing.');
 }finally{closeProvider(provider);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(err=>{console.error(`FAILED: ${err.message}`);process.exitCode=1;});
