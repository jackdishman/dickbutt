import fs from 'node:fs';
import path from 'node:path';
import { Contract, FetchRequest, JsonRpcProvider, formatEther, formatUnits } from 'ethers';

/** Read only the disposable local chain; never load a key or connect to a public RPC here. */
export async function localWallets(root) {
  const file = path.join(root, '.context/current-local.json');
  if (!fs.existsSync(file)) return { running: false, message: 'Start npm run rehearse -- --keep-alive first.' };
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const url = new URL(state.rpcUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw Error('Local wallet RPC must be loopback.');
  const request = new FetchRequest(url.href);
  request.timeout = 5000;
  const provider = new JsonRpcProvider(request, 31337, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  try {
    if (BigInt(await provider.send('eth_chainId', [])) !== 31337n) throw Error('Local wallet RPC must use chain 31337.');
    const block = await provider.getBlockNumber();
    const abi = ['function balanceOf(address) view returns(uint256)'];
    const dick = new Contract(state.manifest.contracts.dickbutt, abi, provider);
    const reward = new Contract(state.manifest.contracts.spcxc, abi, provider);
    const wallets = [];
    for (const { role, address } of state.wallets) {
      const [eth, d, s] = await Promise.all([provider.getBalance(address, block), dick.balanceOf(address, { blockTag: block }), reward.balanceOf(address, { blockTag: block })]);
      wallets.push({ role, address, eth: formatEther(eth), dickbutt: formatUnits(d, 18), spcxc: formatUnits(s, 8), spcxcRaw: String(s) });
    }
    return { running: true, rpcUrl: state.rpcUrl, chainId: 31337, block, evidence: state.evidence, wallets };
  } catch {
    return { running: false, message: 'The local rehearsal node is unavailable. Restart npm run rehearse -- --keep-alive.' };
  } finally { provider.destroy(); }
}
