import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Single writer for both the recovery ledger and its deploying signer on this host. */
export function acquireDeploymentLocks(output, chainId, address) {
  const target = path.resolve(output);
  const canonical = fs.existsSync(target) ? fs.realpathSync(target)
    : path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
  const locations = [
    `${canonical}.deployment-lock`,
    path.join(os.tmpdir(), `dickbutt-deployer-${chainId}-${address.toLowerCase()}.lock`),
  ];
  const owned = [];
  const release = () => { for (const location of owned.splice(0).reverse()) fs.rmSync(location, {recursive:true,force:true}); };
  try {
    for (const location of locations) {
      try { fs.mkdirSync(location,{mode:0o700}); }
      catch (error) {
        if (error.code === 'EEXIST') throw Error(`deployment lock exists: ${location}; inspect its owner and pending transactions before manual recovery`);
        throw error;
      }
      owned.push(location);
      fs.writeFileSync(path.join(location,'owner.json'),JSON.stringify({pid:process.pid,host:os.hostname(),chainId:String(chainId),signer:address,output:canonical,started:new Date().toISOString()}),{mode:0o600,flag:'wx'});
    }
    return release;
  } catch (error) { release(); throw error; }
}

/** Called only after both locks; a pending/ambiguous deployment needs receipt reconciliation. */
export async function requireSettledDeployer(provider, address) {
  const [latest,pending] = await Promise.all([
    provider.getTransactionCount(address,'latest'),provider.getTransactionCount(address,'pending'),
  ]);
  if (![latest,pending].every(n=>Number.isSafeInteger(n)&&n>=0)) throw Error('invalid deployer nonce response; reconcile provider state');
  if (latest !== pending) throw Error('deployer has pending transactions; reconcile their receipts and nonce before starting or resuming');
}
