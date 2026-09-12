/**
 * Owner-side price-floor refresh for SpcxcSwapExecutor.
 *
 * Deliberately separate from the keeper: different key, different lock namespace, no calculator
 * journal, no distributor contact. The executor's floor expires within one day, so this runs on a
 * schedule while the keeper runs on its own. The only write is setPriceFloor.
 *
 * The floor is a coarse administrative backstop quoted at the per-call cap, not an oracle and not
 * the per-transaction slippage limit. The keeper still supplies a tight minOut quoted at the actual
 * swap size; the executor enforces max(keeperMin, ownerFloor).
 */

export const FLOOR_STATUS = ['fresh', 'refresh-required', 'refreshed', 'expired'];

function positiveInt(value, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw Error(`invalid ${name}`);
  return value;
}

export async function runFloorRefresh({
  provider, executor, quote, signerAddress, execute = false, force = false,
  lifetimeSeconds = 20 * 3600, refreshBeforeSeconds = 8 * 3600, warnBeforeSeconds = 4 * 3600,
  slippageBps = 500, maxDeviationBps = 5000, referenceAmount, onEvent = () => {},
}) {
  const chainId = (await provider.getNetwork()).chainId;
  if (execute && ![31337n, 84532n].includes(chainId)) throw Error('production floor execution is disabled');
  positiveInt(lifetimeSeconds, 'lifetimeSeconds');
  positiveInt(refreshBeforeSeconds, 'refreshBeforeSeconds');
  positiveInt(warnBeforeSeconds, 'warnBeforeSeconds');
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) throw Error('slippage must be 0..5000 basis points');
  if (!Number.isInteger(maxDeviationBps) || maxDeviationBps <= 0) throw Error('invalid maxDeviationBps');

  const [currentFloor, expiresAt, cap, maxLifetime, owner] = (await Promise.all([
    executor.minSpcxcPerWeth(), executor.priceFloorExpiresAt(), executor.maxSwapPerCall(),
    executor.MAX_FLOOR_LIFETIME(), executor.owner(),
  ])).map(v => (typeof v === 'string' ? v : BigInt(v)));
  if (BigInt(lifetimeSeconds) > BigInt(maxLifetime)) throw Error(`lifetimeSeconds exceeds contract MAX_FLOOR_LIFETIME (${maxLifetime})`);

  // The whole point of this bot: it must never hold a key that can also move funds through the
  // executor. An approved keeper signing floor refreshes collapses the two roles into one host.
  if (signerAddress && await executor.isKeeper(signerAddress)) {
    throw Error('ops signer is an approved keeper; the floor bot requires a key that is not a keeper');
  }

  const now = BigInt((await provider.getBlock('latest')).timestamp);
  const remaining = BigInt(expiresAt) > now ? BigInt(expiresAt) - now : 0n;
  const active = BigInt(currentFloor) > 0n && remaining > 0n;
  const result = {
    mode: execute ? 'execute' : 'dry-run', chainId: chainId.toString(),
    currentFloor: currentFloor.toString(), expiresAt: expiresAt.toString(),
    secondsRemaining: Number(remaining), status: 'fresh', swapsBlocked: !active,
  };

  if (!active) result.status = 'expired';
  else if (remaining <= BigInt(refreshBeforeSeconds)) result.status = 'refresh-required';

  // A crashed refresher cannot page anyone about itself, so the alert threshold is evaluated on
  // every call and is the whole job of a read-only monitor running elsewhere. Callers map `alert`
  // to a nonzero exit; the acting bot clears it by refreshing in the same invocation.
  result.alert = !active || remaining <= BigInt(warnBeforeSeconds);
  if (result.alert) {
    onEvent({ type: 'floor-expiring', status: result.status, secondsRemaining: result.secondsRemaining, swapsBlocked: result.swapsBlocked });
  }
  if (result.status === 'fresh') return result;

  // Fail on the cheap authority check before spending an RPC round trip on a quote.
  if (execute) {
    if (!signerAddress) throw Error('execute requires signerAddress');
    if (signerAddress.toLowerCase() !== String(owner).toLowerCase()) throw Error('floor signer is not the executor owner');
  }

  // Quote at the per-call cap: the largest swap the executor can make, so the worst price impact
  // and therefore the most conservative floor. A smaller real swap clears it comfortably.
  const amount = referenceAmount === undefined ? BigInt(cap) : BigInt(referenceAmount);
  if (amount <= 0n) throw Error('reference amount must be positive');
  const quoted = BigInt(await quote(amount));
  if (quoted <= 0n) throw Error('zero quote');
  const proposed = (quoted * BigInt(10000 - slippageBps) / 10000n) * (10n ** 18n) / amount;
  if (proposed <= 0n) throw Error('proposed floor rounds to zero');
  result.referenceAmount = amount.toString();
  result.quoted = quoted.toString();
  result.proposedFloor = proposed.toString();

  if (BigInt(currentFloor) > 0n) {
    const previous = BigInt(currentFloor);
    const delta = proposed > previous ? proposed - previous : previous - proposed;
    result.deviationBps = Number(delta * 10000n / previous);
    if (result.deviationBps > maxDeviationBps && !force) {
      throw Error(`proposed floor deviates ${result.deviationBps}bps from the active floor; review the quote, then rerun with force`);
    }
  }

  if (!execute) return result;

  const expiry = now + BigInt(lifetimeSeconds);
  const tx = await executor.setPriceFloor(proposed, expiry);
  onEvent({ type: 'transaction-submitted', action: 'set-price-floor', hash: tx.hash });
  const receipt = await tx.wait(1);
  if (!receipt || Number(receipt.status) !== 1) throw Error(`set-price-floor failed: ${tx.hash}`);
  onEvent({ type: 'transaction-confirmed', action: 'set-price-floor', hash: tx.hash });
  result.transaction = tx.hash;
  result.expiresAt = expiry.toString();
  result.secondsRemaining = lifetimeSeconds;
  result.status = 'refreshed';
  result.swapsBlocked = false;
  result.alert = false;
  return result;
}
