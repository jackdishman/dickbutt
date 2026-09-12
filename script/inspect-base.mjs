import { JsonRpcProvider, Contract } from 'ethers';
import fs from 'node:fs';
class ThrottledProvider extends JsonRpcProvider {
  async send(method, params) {
    await new Promise(resolve => setTimeout(resolve, 500));
    for (let attempt = 0; ; attempt++) {
      try { return await super.send(method, params); }
      catch (e) {
        if (attempt >= 5 || !JSON.stringify(e).includes('rate limit')) throw e;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
}
const provider = new ThrottledProvider(process.env.BASE_RPC_URL || 'https://mainnet.base.org',undefined,{batchMaxCount:1});
const block = await provider.getBlock('finalized');
const tag = {blockTag: block.number};
const lockerAddress = '0x2Ad4DB8ba8de03834DB14454Afcd74C2393d81C4';
const managerAddress = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const locker = new Contract(lockerAddress, ['function owner() view returns(address)','function end() view returns(uint256)','function released(address) view returns(uint256)','function _fee() view returns(uint256)'], provider);
const manager = new Contract(managerAddress, ['function ownerOf(uint256) view returns(address)','function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)','function factory() view returns(address)'], provider);
const id = await locker.released(managerAddress, tag);
const pos = await manager.positions(id, tag);
const factory = new Contract(await manager.factory(tag), ['function getPool(address,address,uint24) view returns(address)'], provider);
const out = {chainId: 8453, block: block.number, blockHash: block.hash, timestamp: block.timestamp, locker: lockerAddress, manager: managerAddress, tokenId:id, owner:await locker.owner(tag), unlockTime:await locker.end(tag), feePercent:await locker._fee(tag), nftOwner:await manager.ownerOf(id,tag), position: [...pos], pool:await factory.getPool(pos[2],pos[3],pos[4],tag)};
for (const [name,address] of Object.entries({dickbutt:'0x2d57c47bc5d2432feeedf2c9150162a9862d3ccf',spcxc:'0xb2000000000000000000007b9fcbd005511acbd5'})) {
  const t = new Contract(address,['function decimals() view returns(uint8)','function totalSupply() view returns(uint256)','function symbol() view returns(string)'],provider);
  out[name] = {address, decimals:await t.decimals(tag), totalSupply:await t.totalSupply(tag),symbol:await t.symbol(tag)};
}
fs.writeFileSync('artifacts/base-inspection.json',JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
console.log(JSON.stringify(out,(_,v)=>typeof v==='bigint'?v.toString():v,2));
