import 'dotenv/config';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {ethers} from 'ethers';import {runCalculator} from './calculator/engine.js';import {Journal,stringify} from './calculator/journal.js';import {normalize} from './calculator/core.js';import {ERC20_ABI,DISTRIBUTOR_ABI} from './calculator/chain.js';
function integer(value,name,min=1){const n=Number(value);if(!Number.isSafeInteger(n)||n<min)throw Error(`invalid ${name}`);return n;}
export async function main(){
 const dir=path.resolve(process.env.CALCULATOR_DATA_DIR||'.');
 if(process.argv.includes('rebuild-state')){const j=new Journal(dir);j.lock();try{const s=j.rebuild();if(!s)throw Error('no committed journal to rebuild');j.cache(s);console.log(`Rebuilt state through block ${s.lastProcessedBlock}. Plans and batches remain in periods/*.json.`);}finally{j.unlock();}return;}
 for(const name of ['RPC_URL','DICKBUTT_ADDRESS','DISTRIBUTOR_ADDRESS','DICKBUTT_DEPLOY_BLOCK','PAYOUT_THRESHOLD_RAW','WEIGHTING'])if(!process.env[name])throw Error(`Missing ${name}`);
 const excluded=(process.env.EXCLUDED_ADDRESSES||'').split(',').map(a=>a.trim()).filter(Boolean).map(normalize).sort();if(!excluded.length)throw Error('EXCLUDED_ADDRESSES must include pools and burn addresses');
 const curve=process.env.WEIGHTING;if(!['sqrt','linear'].includes(curve))throw Error('WEIGHTING must be sqrt or linear');
 const provider=new ethers.JsonRpcProvider(process.env.RPC_URL, undefined, {cacheTimeout: -1});try{
 const network=await provider.getNetwork(),config={chainId:network.chainId.toString(),token:normalize(process.env.DICKBUTT_ADDRESS),distributor:normalize(process.env.DISTRIBUTOR_ADDRESS),deployBlock:integer(process.env.DICKBUTT_DEPLOY_BLOCK,'deploy block'),holderThresholdRaw:ethers.parseUnits(process.env.HOLDER_THRESHOLD||'6900000',18).toString(),payoutThresholdRaw:BigInt(process.env.PAYOUT_THRESHOLD_RAW).toString(),curve,excluded,batchSize:integer(process.env.BATCH_SIZE||250,'batch size'),chunkSize:integer(process.env.SCAN_CHUNK_SIZE||2000,'scan chunk'),finalityTag:process.env.FINALITY_TAG||'finalized'};
 if(BigInt(config.payoutThresholdRaw)<0n||BigInt(config.holderThresholdRaw)<0n)throw Error('negative threshold');
 const record=await runCalculator({dir,provider,token:new ethers.Contract(config.token,ERC20_ABI,provider),distributor:new ethers.Contract(config.distributor,DISTRIBUTOR_ABI,provider),config});
 console.log(record.unchanged?'No new finalized period.':stringify({block:record.block,curve,roundId:record.roundId,root:record.root,total:record.plan?.total??'0',batches:record.plan?.batches.length??0,journal:path.join(dir,'periods')}));
 console.log('Nothing submitted on-chain. Review the committed period plan before proposing.');
 }finally{provider.destroy();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(err=>{console.error(`FAILED: ${err.message}`);process.exitCode=1;});
