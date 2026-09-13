import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { FetchRequest, JsonRpcProvider, Wallet, formatEther, parseEther } from 'ethers';
import { validateRoles } from '../operations/deployment.js';

const args=process.argv.slice(2),options={env:'.env',roles:'config/roles-sepolia.local.json'};
for(let i=0;i<args.length;i++){
  if(!['--env','--roles'].includes(args[i])||!args[i+1])throw Error('Usage: node script/check-wallets.mjs [--env .env] [--roles roles.json]');
  options[args[i].slice(2)]=args[++i];
}
const env={...dotenv.parse(fs.readFileSync(options.env)),...process.env};
const request=new FetchRequest(env.RPC_URL);request.timeout=15000;
const provider=new JsonRpcProvider(request,84532,{staticNetwork:true,batchMaxCount:1,cacheTimeout:-1});
try{
  if(BigInt(await provider.send('eth_chainId',[]))!==84532n)throw Error('Wallet check is restricted to Base Sepolia (84532).');
  const roles=JSON.parse(fs.readFileSync(options.roles));
  const walletRoles={deployer:'DEPLOYER_PRIVATE_KEY',keeper:'KEEPER_PRIVATE_KEY',proposer:'PROPOSER_PRIVATE_KEY',ops:'OPS_PRIVATE_KEY'};
  const wallets=[],errors=[];
  for(const [role,key]of Object.entries(walletRoles)){
    if(!env[key]){errors.push(`${key} is missing`);continue;}
    const address=new Wallet(env[key]).address;
    if(role!=='deployer'&&roles[role]?.toLowerCase()!==address.toLowerCase())errors.push(`${role} key does not match the roles file`);
    const balance=await provider.getBalance(address),minimum=parseEther(role==='deployer'?'0.02':'0.002');
    wallets.push({role,address,balanceEth:formatEther(balance),testnetFundingTargetEth:formatEther(minimum),funded:balance>=minimum});
  }
  errors.push(...validateRoles(roles,{deployer:wallets.find(w=>w.role==='deployer')?.address}));
  const result={checkedAt:new Date().toISOString(),readOnly:true,network:'Base Sepolia',chainId:84532,wallets,errors,
    ready:errors.length===0&&wallets.length===4&&wallets.every(w=>w.funded)};
  fs.mkdirSync('.context/test-results',{recursive:true});
  fs.writeFileSync(path.resolve('.context/test-results/wallet-readiness.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
  if(!result.ready)process.exitCode=2;
}catch(error){console.error(error.code?'Wallet RPC check failed; no transaction was sent.':error.message);process.exitCode=1;}
finally{provider.destroy();}
