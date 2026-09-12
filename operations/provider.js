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
