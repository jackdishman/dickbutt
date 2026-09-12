// Read-only finalized-block inspection. No signer, private key, or broadcast path.
import { Contract, JsonRpcProvider, keccak256 } from 'ethers';

class LegacyReadProvider extends JsonRpcProvider {
  async send(method, params) {
    for (let attempt = 0; ; attempt++) {
      try { return await super.send(method, params); }
      catch (error) {
        if (attempt >= 4 || !/rate limit|429/i.test(String(error))) throw error;
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
  }
}

const provider = new LegacyReadProvider(process.env.BASE_RPC_URL || 'https://mainnet.base.org', undefined, { batchMaxCount: 1 });
if ((await provider.getNetwork()).chainId !== 8453n) throw new Error('Expected Base mainnet');
const block = await provider.getBlock(process.env.LEGACY_BLOCK ? Number(process.env.LEGACY_BLOCK) : 'finalized');
if (!block) throw new Error('Block not found');
const tag = { blockTag: block.number };
const tokenAddress = '0x2D57C47BC5D2432FEEEdf2c9150162A9862D3cCf';
const moduleAddress = '0x10F4485d6f90239B72c6A5eaD2F2320993D285E4';
const lockerAddress = '0x2Ad4DB8ba8de03834DB14454Afcd74C2393d81C4';
const knownSafes = ['0x1eaf444ebDf6495C57aD52A04C61521bBf564ace', '0x04F6ef12a8B6c2346C8505eE4Cff71C43D2dd825'];
const module = new Contract(moduleAddress, [
  'function tokenCreator(address) view returns(address)',
  'function tokenCreatorRoot() view returns(bytes32)',
  'function teamGrantedTokensMap(address) view returns(bool)',
  'function owner() view returns(address)',
], provider);
const locker = new Contract(lockerAddress, [
  'function owner() view returns(address)',
  'function _feeRecipient() view returns(address)',
  'function _fee() view returns(uint256)',
], provider);
const token = new Contract(tokenAddress, ['function balanceOf(address) view returns(uint256)'], provider);
const out = {
  chainId: 8453, block: block.number, blockHash: block.hash, timestamp: block.timestamp,
  token: tokenAddress, feeModule: moduleAddress,
  moduleCodeHash: keccak256(await provider.getCode(moduleAddress, block.number)),
  tokenCreator: await module.tokenCreator(tokenAddress, tag),
  tokenCreatorRoot: await module.tokenCreatorRoot(tag),
  teamGranted: await module.teamGrantedTokensMap(tokenAddress, tag),
  moduleOwner: await module.owner(tag),
  locker: lockerAddress, lockerOwner: await locker.owner(tag),
  lockerFeePercent: await locker._fee(tag), currentFeeSink: await locker._feeRecipient(tag),
  safes: [],
  sources: {
    sdkCommit: '4f4d2bbf41c7f10543559dc043c85f443a6d452e',
    sdk: 'https://github.com/clanker-devco/clanker-sdk/blob/4f4d2bbf41c7f10543559dc043c85f443a6d452e/src/legacyFeeClaims/index.ts',
    deployedSource: 'https://base.blockscout.com/address/0x10F4485d6f90239B72c6A5eaD2F2320993D285E4?tab=contract',
    historicalSafeClaim: 'https://basescan.org/tx/0x7a5d764da96a870b387d7b49a3b094da32dbcdb41ca9f184140240d3622ea7ce',
  },
  warning: 'Read-only snapshot. Revalidate before deployment; no claim or authority change is performed.',
};
for (const address of knownSafes) {
  const safe = new Contract(address, ['function isModuleEnabled(address) view returns(bool)'], provider);
  out.safes.push({ address, moduleEnabled: await safe.isModuleEnabled(moduleAddress, tag), tokenBalance: await token.balanceOf(address, tag) });
}
console.log(JSON.stringify(out, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
await provider.destroy();
