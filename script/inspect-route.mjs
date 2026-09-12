// Read-only Base route discovery. Every eth_call is pinned to the recorded block.
import { JsonRpcProvider, Contract, Interface, solidityPacked, parseEther, ZeroAddress } from 'ethers';
import fs from 'node:fs';
const provider = new JsonRpcProvider(process.env.BASE_RPC_URL || 'https://base-rpc.publicnode.com',8453,{batchMaxCount:1});
const delay = () => new Promise(r=>setTimeout(r,1200));
const block=await provider.getBlock(process.env.ROUTE_BLOCK || 'latest');
const tag={blockTag:block.number};
const tokens={WETH:'0x4200000000000000000000000000000000000006',USDC:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',SPCXc:'0xb2000000000000000000007b9fcbd005511acbd5'};
const deployments=[
 {generation:'initial',factory:'0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a',router:'0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5',quoter:'0x254cf9e1e6e233aa1ac962cb9b05b2cfeaae15b0'},
 {generation:'gauge-caps',factory:'0xade65c38cd4849adba595a4323a8c7ddfe89716a',router:'0xcbbb8035cac7d4b3ca7abb74cf7bdf900215ce0d',quoter:'0x3d4c22254f86f64b7ec90ab8f7aec1fbfd271c6c'},
 {generation:'gauges-v3',factory:'0xf8f2eb4940cfe7d13603dddd87f123820fc061ef',router:'0x698cb2b6dd822994581fea6ea4fc755d1363a92f',quoter:'0x514c8b5f54112481e28028f1166bd78501089259'}
];
const abi=new Interface(['function tickSpacings() view returns(int24[])','function factory() view returns(address)','function getPool(address,address,int24) view returns(address)','function liquidity() view returns(uint128)','function token0() view returns(address)','function token1() view returns(address)','function balanceOf(address) view returns(uint256)','function quoteExactInput(bytes,uint256) returns(uint256,uint160[],uint32[],uint256)']);
const mc=new Contract('0xca11bde05977b3631167028862be2a173976ca11',['function aggregate3((address target,bool allowFailure,bytes callData)[]) payable returns((bool success,bytes returnData)[])'],provider);
async function calls(items){let out=[];for(let i=0;i<items.length;i+=10){await delay();const chunk=items.slice(i,i+10);const values=await mc.aggregate3.staticCall(chunk.map(x=>[x.target,true,abi.encodeFunctionData(x.fn,x.args||[])]),tag);out.push(...values.map((v,j)=>v.success?abi.decodeFunctionResult(chunk[j].fn,v.returnData):null));}return out;}
const basics=await calls(deployments.flatMap(d=>[{target:d.factory,fn:'tickSpacings'},{target:d.router,fn:'factory'}]));
for(let i=0;i<deployments.length;i++){deployments[i].tickSpacings=basics[i*2]?.[0].map(Number)||[];deployments[i].routerFactory=basics[i*2+1]?.[0]||null;}
const pairs=[['WETH','USDC'],['USDC','SPCXc'],['WETH','SPCXc']];
const candidates=deployments.flatMap(d=>pairs.flatMap(pair=>d.tickSpacings.map(spacing=>({generation:d.generation,pair,spacing,target:d.factory,fn:'getPool',args:[tokens[pair[0]],tokens[pair[1]],spacing]}))));
const found=await calls(candidates);const pools=candidates.flatMap((p,i)=>found[i]&&found[i][0]!==ZeroAddress?[{generation:p.generation,pair:p.pair,tickSpacing:p.spacing,address:found[i][0]}]:[]);
const details=await calls(pools.flatMap(p=>[{target:p.address,fn:'liquidity'},...p.pair.map(t=>({target:tokens[t],fn:'balanceOf',args:[p.address]}))]));
for(let i=0;i<pools.length;i++){pools[i].activeLiquidity=details[3*i]?.[0]??null;pools[i].tokenBalances=Object.fromEntries(pools[i].pair.map((t,j)=>[t,details[3*i+1+j]?.[0]??null]));}
const routes=[];
for(const d of deployments){const ps=pools.filter(p=>p.generation===d.generation&&p.activeLiquidity>0n);for(const a of ps.filter(p=>p.pair.join('/')==='WETH/USDC'))for(const b of ps.filter(p=>p.pair.join('/')==='USDC/SPCXc'))routes.push({generation:d.generation,router:d.router,quoter:d.quoter,pools:[a.address,b.address],spacings:[a.tickSpacing,b.tickSpacing],path:solidityPacked(['address','int24','address','int24','address'],[tokens.WETH,a.tickSpacing,tokens.USDC,b.tickSpacing,tokens.SPCXc])});for(const a of ps.filter(p=>p.pair.join('/')==='WETH/SPCXc'))routes.push({generation:d.generation,router:d.router,quoter:d.quoter,pools:[a.address],spacings:[a.tickSpacing],path:solidityPacked(['address','int24','address'],[tokens.WETH,a.tickSpacing,tokens.SPCXc])});}
const amounts=['0.001','0.01','0.1'];
const quotes=await calls(routes.flatMap(r=>amounts.map(a=>({target:r.quoter,fn:'quoteExactInput',args:[r.path,parseEther(a)]}))));
for(let i=0;i<routes.length;i++)routes[i].quotes=amounts.map((amount,j)=>({wethIn:amount,spcxcRawOut:quotes[3*i+j]?.[0]??null,estimatedSwapGas:quotes[3*i+j]?.[3]??null}));
const out={chainId:8453,block:block.number,blockHash:block.hash,timestamp:block.timestamp,blockPolicy:process.env.ROUTE_BLOCK||'latest discovery snapshot',sources:['https://github.com/aerodrome-finance/slipstream/blob/main/README.md','https://github.com/aerodrome-finance/slipstream/blob/main/contracts/periphery/interfaces/IQuoterV2.sol'],tokens,deployments,pools,routes,limitations:'Snapshot quotes only; no transaction broadcasts. Token balances are not concentrated-liquidity reserves or executable depth. Zero-current-liquidity pools excluded from route quoting. Only same-factory routes supported by this splitter. Re-run at finalized block and fork-test before deployment.'};
fs.writeFileSync('config/route-candidates.json',JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');console.log(JSON.stringify({block:out.block,pools:pools.length,routes},(_,v)=>typeof v==='bigint'?v.toString():v,2));
