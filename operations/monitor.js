/**
 * Keyless health check. Loads no private key, sends no transaction, and is meant to run on a host
 * that shares nothing with the bots it watches — a crashed refresher cannot page anyone about
 * itself, and a monitor that dies alongside the keeper is decoration.
 *
 * Severity maps to exit status: `ok` -> 0, `attention` -> 2, `failed` -> 1.
 */

const DAY = 86400n;

export const SEVERITY = { ok: 0, attention: 2, failed: 1 };

function check(name, severity, detail, extra = {}) {
  return { name, severity, detail, ...extra };
}

/**
 * @param journalRoots Round roots the local calculator journal has committed. Any on-chain
 * commitment outside this set was proposed by something other than this pipeline.
 */
export async function runMonitor({
  provider, distributor, executor, journalRoots = [], gasAccounts = {},
  minGasWei = 2n * 10n ** 15n, floorWarnSeconds = 4 * 3600, staleRoundSeconds = 6 * 3600, now,
}) {
  const checks = [];
  const chainId = (await provider.getNetwork()).chainId.toString();
  const timestamp = now ?? BigInt((await provider.getBlock('latest')).timestamp);

  // --- price floor -------------------------------------------------------
  const [floor, expiresAt] = await Promise.all([executor.minSpcxcPerWeth(), executor.priceFloorExpiresAt()]);
  const remaining = BigInt(expiresAt) > timestamp ? BigInt(expiresAt) - timestamp : 0n;
  if (BigInt(floor) === 0n || remaining === 0n) {
    checks.push(check('price-floor', 'attention', 'floor expired or unset; swaps are blocked', { secondsRemaining: 0 }));
  } else if (remaining <= BigInt(floorWarnSeconds)) {
    checks.push(check('price-floor', 'attention', 'floor expires soon; the refresher may be down', { secondsRemaining: Number(remaining) }));
  } else if (remaining > DAY) {
    checks.push(check('price-floor', 'failed', 'floor outlives the contract maximum; inspect the executor', { secondsRemaining: Number(remaining) }));
  } else {
    checks.push(check('price-floor', 'ok', 'floor active', { secondsRemaining: Number(remaining) }));
  }

  // --- floor lower bound -------------------------------------------------
  // The floor-setter key is hot. Without an owner bound it can set any floor, which is the whole
  // opening a compromised host needs. An executor without the getter predates the role: redeploy.
  try {
    const bound = BigInt(await executor.floorLowerBound());
    checks.push(bound === 0n
      ? check('floor-lower-bound', 'attention', 'floorLowerBound is zero; a compromised floor setter can set any floor', { lowerBound: '0' })
      : check('floor-lower-bound', 'ok', 'floor setters are bounded', { lowerBound: bound.toString() }));
  } catch {
    checks.push(check('floor-lower-bound', 'failed', 'executor does not expose floorLowerBound; it predates the floor-setter role and needs redeploying', {}));
  }

  // --- gas ---------------------------------------------------------------
  // An unfunded bot fails exactly like a compromised one is stopped: silently.
  for (const [role, address] of Object.entries(gasAccounts)) {
    if (!address) continue;
    const balance = await provider.getBalance(address);
    checks.push(BigInt(balance) < BigInt(minGasWei)
      ? check('gas', 'attention', `${role} is low on gas and will stop silently`, { role, address, balance: balance.toString() })
      : check('gas', 'ok', `${role} funded`, { role, address, balance: balance.toString() }));
  }

  // --- guardian pause ----------------------------------------------------
  const paused = await distributor.proposalsPaused();
  checks.push(paused
    ? check('proposals', 'attention', 'the guardian has paused proposals; no new rounds will be committed', {})
    : check('proposals', 'ok', 'proposals enabled', {}));

  // --- on-chain commitments the journal does not know about --------------
  // This is the alarm that matters: a root this pipeline did not produce means either a stolen
  // proposer key or an operator working outside the journal. Either way, a human decides.
  const known = new Set(journalRoots.map(r => r.toLowerCase()));
  const next = BigInt(await distributor.nextRoundId());
  let unpaidTotal = 0n;
  for (let id = next - 1n; id >= 1n && id > next - 6n; id--) {
    const [round, pending] = await Promise.all([distributor.roundInfo(id), distributor.pending(id)]);
    const [root, total, distributed, active, closed] = round;
    const [pendingRoot, pendingTotal, readyAt] = pending;
    for (const [label, candidate, amount] of [['pending', pendingRoot, pendingTotal], ['active', root, total]]) {
      if (!candidate || BigInt(amount) === 0n) continue;
      // A foreign round the guardian cancelled before anything was paid is the incident resolved, not
      // a fresh one; it keeps its root on-chain forever. One that paid anything stays alarming.
      if (label === 'active' && closed && BigInt(distributed) === 0n) continue;
      if (!known.has(candidate.toLowerCase())) {
        checks.push(check('unknown-commitment', 'attention',
          `round ${id} carries a ${label} root the calculator journal never produced`,
          { roundId: id.toString(), root: candidate, total: amount.toString() }));
      }
    }
    if (active && BigInt(total) > BigInt(distributed)) {
      unpaidTotal += BigInt(total) - BigInt(distributed);
      checks.push(check('round-progress', 'ok', `round ${id} active with an outstanding balance`,
        { roundId: id.toString(), outstanding: (BigInt(total) - BigInt(distributed)).toString() }));
    }
    if (BigInt(pendingTotal) > 0n && BigInt(readyAt) > 0n && timestamp > BigInt(readyAt) + BigInt(staleRoundSeconds)) {
      checks.push(check('stale-round', 'attention',
        `round ${id} passed its timelock ${Number(timestamp - BigInt(readyAt))}s ago and has not been activated`,
        { roundId: id.toString(), readyAt: readyAt.toString() }));
    }
    if (closed) break;
  }

  const severity = checks.some(c => c.severity === 'failed') ? 'failed'
    : checks.some(c => c.severity === 'attention') ? 'attention' : 'ok';
  return {
    chainId, timestamp: timestamp.toString(), severity, exitCode: SEVERITY[severity],
    attention: checks.filter(c => c.severity !== 'ok'),
    outstandingRewards: unpaidTotal.toString(),
    checks,
  };
}
