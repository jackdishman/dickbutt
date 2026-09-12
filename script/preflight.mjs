// Read-only finalized Base inspection. --strict exits nonzero until all deployment prerequisites pass.
import 'dotenv/config';
import fs from 'node:fs';
import {Contract,JsonRpcProvider,ZeroAddress} from 'ethers';
import {validatePoolFacts,validateDeployment,validateSwapRoute} from '../operations/preflight.js';
const args=process.argv.slice(2),configPath=args.includes('--config')?args[args.indexOf('--config')+1]:'config/base-mainnet.json';
const config=JSON.parse(fs.readFileSync(configPath));
const provider=new JsonRpcProvider(process.env.BASE_RPC_URL||'https://mainnet.base.org',undefined,{batchMaxCount:1,cacheTimeout:-1});
try {
  const network=await provider.getNetwork();
  if(network.chainId!==8453n||config.chainId!==8453) throw Error('Preflight requires Base mainnet read-only RPC/config');
  const block=await provider.getBlock('finalized');
  if(!block?.hash) throw Error('Finalized block unavailable');
  const tag={blockTag:block.number},errors=validateDeployment(config.deployment??{});
  const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
  const desired=config.rewardsPool;
  if(!desired) throw Error('Missing rewardsPool specification');
  const factory=new Contract(desired.factory,['function getPool(address,address,int24) view returns(address)','function tickSpacingToFee(int24) view returns(uint24)','function getUnstakedFee(address) view returns(uint24)'],provider);
  const discovered=await factory.getPool(config.dickbutt,config.spcxc,desired.tickSpacing,tag);
  const baseFee=await factory.tickSpacingToFee(desired.tickSpacing,tag);
  let facts=null;
  if(discovered!==ZeroAddress&&desired.pool&&desired.tokenId) {
    if(discovered.toLowerCase()!==desired.pool.toLowerCase()) errors.push('Configured pool differs from factory discovery');
    const pool=new Contract(desired.pool,['function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)','function fee() view returns(uint24)','function tickSpacing() view returns(int24)','function liquidity() view returns(uint128)'],provider);
    const manager=new Contract(desired.manager,['function factory() view returns(address)','function ownerOf(uint256) view returns(address)','function positions(uint256) view returns(uint96,address,address,address,int24,int24,int24,uint128,uint256,uint256,uint128,uint128)'],provider);
    const pos=await manager.positions(desired.tokenId,tag);
    facts={token0:await pool.token0(tag),token1:await pool.token1(tag),factory:await pool.factory(tag),managerFactory:await manager.factory(tag),fee:await pool.fee(tag),tickSpacing:await pool.tickSpacing(tag),liquidity:await pool.liquidity(tag),positionOwner:await manager.ownerOf(desired.tokenId,tag),positionToken0:pos[2],positionToken1:pos[3],positionTickSpacing:pos[4],tickLower:pos[5],tickUpper:pos[6],positionLiquidity:pos[7],unstakedFee:await factory.getUnstakedFee(desired.pool,tag)};
  }
  errors.push(...validatePoolFacts(facts,{tokens:[config.dickbutt,config.spcxc],...desired}));
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
  const output={readOnly:true,chainId:8453,block:block.number,blockHash:block.hash,baseFee,discoveredPool:discovered,rewardsPool:facts,swapRoute,locker:{owner:await locker.owner(tag),deductionPercent:await locker._fee(tag),feeSink:await locker._feeRecipient(tag)},rewardDecimals:await reward.decimals(tag),readyForCustodyHandoff:false,configurationChecksPass:errors.length===0,errors,remainingChecks:['Verify actual Splits factory and immutable recipient allocations','Verify independent legacy tokenCreator authority and sink module','Re-quote production swap path and validate real B20 payments','Verify deployed destinations, custody targets and review rehearsal receipts']};
  const end=await provider.getBlock(block.number);
  if(end?.hash!==block.hash) throw Error('Snapshot hash changed');
  console.log(JSON.stringify(output,(_,v)=>typeof v==='bigint'?v.toString():v,2));
  if(args.includes('--strict')&&errors.length) process.exitCode=1;
} catch(e) {console.error(`Preflight failed: ${e.message}`);process.exitCode=1;} finally {provider.destroy();}
