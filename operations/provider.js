import http from 'node:http';
import https from 'node:https';
import {FetchRequest,JsonRpcProvider} from 'ethers';

/** Bound concurrent sockets and reuse connections instead of opening a socket per balance read.
 * RPC_IPV4_ONLY is an operator opt-in for hosts with unusable IPv6 routes. It changes transport
 * only; chain checks, finality and transaction recovery rules remain at their call sites.
 */
export function createRpcProvider(url,network,options={}) {
  const request=url instanceof FetchRequest?url.clone():new FetchRequest(url);
  const Agent=new URL(request.url).protocol==='https:'?https.Agent:http.Agent;
  const agent=new Agent({keepAlive:true,maxSockets:4,...(process.env.RPC_IPV4_ONLY==='1'?{family:4}:{})});
  request.timeout=30000;
  request.getUrlFunc=FetchRequest.createGetUrlFunc({agent});
  return new JsonRpcProvider(request,network,{batchMaxCount:1,cacheTimeout:-1,...options});
}

/**
 * Shut down an ethers provider without turning a successful run into a crash.
 *
 * `provider.destroy()` rejects every in-flight request. After a settled `tx.wait()` the block
 * poller can still have one `eth_blockNumber` outstanding, and that rejection has nobody to catch
 * it — so a run that confirmed every transaction exits non-zero with an unhandled rejection.
 * A scheduler reads that as "needs a human" and pages someone about a job that worked.
 *
 * Local forks answer fast enough to hide this; a public RPC does not. Removing the listeners stops
 * the poller, the event loop drains, and the process exits on its own with sockets closed by the
 * runtime — which is all a short-lived CLI needs.
 */
export function closeProvider(provider) {
  if (!provider) return;
  provider.removeAllListeners();
}
