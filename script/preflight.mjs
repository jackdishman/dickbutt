// Read-only finalized Base inspection. --strict exits nonzero until all deployment prerequisites pass.
import 'dotenv/config';
import fs from 'node:fs';
import {Contract,JsonRpcProvider,ZeroAddress} from 'ethers';
import {validatePoolFacts,validateDeployment,validateSwapRoute,validateExclusions} from '../operations/preflight.js';
import { inspectRewardPool } from '../operations/aerodrome.js';
import { closeProvider } from '../operations/provider.js';
const args=process.argv.slice(2),configPath=args.includes('--config')?args[args.indexOf('--config')+1]:'config/base-mainnet.json';
const config=JSON.parse(fs.readFileSync(configPath));
const provider=new JsonRpcProvider(process.env.BASE_RPC_URL||'https://mainnet.base.org',undefined,{batchMaxCount:1,cacheTimeout:-1});
try {
  const network=await provider.getNetwork();
  if(network.chainId!==8453n||config.chainId!==8453) throw Error('Preflight requires Base mainnet read-only RPC/config');
  const block=await provider.getBlock('finalized');
  if(!block?.hash) throw Error('Finalized block unavailable');
  const tag={blockTag:block.number},errors=[...validateDeployment(config.deployment??{}),...validateExclusions(config)];
  const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
  const desired=config.rewardsPool;
  if(!desired) throw Error('Missing rewardsPool specification');
  const inspection=await inspectRewardPool(provider,config,block.number);
  const facts=inspection.facts;
  errors.push(...inspection.errors,...validatePoolFacts(facts,{tokens:[config.dickbutt,config.spcxc],...desired}));
  // The executor's path encodes tick spacings; confirm they still resolve to the intended two-hop pools.
  const route=config.aerodrome;
  const routeFactory=new Contract(route.factory,['function getPool(address,address,int24) view returns(address)'],provider);
  const liquidityOf=async address=>same(address,ZeroAddress)?0n
    :await new Contract(address,['function liquidity() view returns(uint128)'],provider).liquidity(tag);
  const wethUsdc=await routeFactory.getPool(config.weth,config.usdc,route.wethUsdcTickSpacing,tag);
  const usdcSpcxc=await routeFactory.getPool(config.usdc,config.spcxc,route.usdcSpcxcTickSpacing,tag);
  const swapRoute={path:route.swapRoute,wethUsdc,usdcSpcxc,
    wethUsdcLiquidity:await liquidityOf(wethUsdc),usdcSpcxcLiquidity:await liquidityOf(usdcSpcxc)};
  errors.push(...validateSwapRoute(swapRoute,route));
  const locker=new Contract(config.clankerLocker,['function owner() view returns(address)','function _fee() view returns(uint256)','function _feeRecipient() view returns(address)'],provider);
  const reward=new Contract(config.spcxc,['function decimals() view returns(uint8)'],provider);
  const output={readOnly:true,chainId:8453,block:block.number,blockHash:block.hash,rewardsPoolKind:inspection.kind,discoveredPool:facts?.discoveredPool??null,rewardsPool:facts,swapRoute,locker:{owner:await locker.owner(tag),deductionPercent:await locker._fee(tag),feeSink:await locker._feeRecipient(tag)},rewardDecimals:await reward.decimals(tag),readyForCustodyHandoff:false,configurationChecksPass:errors.length===0,errors,remainingChecks:['Verify actual Splits factory and immutable recipient allocations','Verify independent legacy tokenCreator authority and sink module','Re-quote production swap path and validate real B20 payments','Verify deployed destinations, custody targets and review rehearsal receipts']};
  const end=await provider.getBlock(block.number);
  if(end?.hash!==block.hash) throw Error('Snapshot hash changed');
  console.log(JSON.stringify(output,(_,v)=>typeof v==='bigint'?v.toString():v,2));
  if(args.includes('--strict')&&errors.length) process.exitCode=1;
} catch(e) {console.error(`Preflight failed: ${e.message}`);process.exitCode=1;} finally {closeProvider(provider);}
