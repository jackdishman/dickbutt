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
  previousProgress = null,
}) {
  const checks = [];
  const chainId = (await provider.getNetwork()).chainId.toString();
  const block = await provider.getBlock('latest');
  if (!Number.isSafeInteger(block?.number) || !block.hash) throw Error('monitor snapshot unavailable');
  const tag = { blockTag: block.number };
  const timestamp = BigInt(now ?? block.timestamp);
  if(previousProgress && (previousProgress.version!==1||previousProgress.chainId!==chainId
    ||!previousProgress.rounds||BigInt(previousProgress.timestamp)>timestamp)) throw Error('invalid monitor progress history');
  const progress={version:1,chainId,timestamp:timestamp.toString(),rounds:{}};

  // --- price floor -------------------------------------------------------
  const [floor, expiresAt] = await Promise.all([executor.minSpcxcPerWeth(tag), executor.priceFloorExpiresAt(tag)]);
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
    const bound = BigInt(await executor.floorLowerBound(tag));
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
    const balance = await provider.getBalance(address, block.number);
    checks.push(BigInt(balance) < BigInt(minGasWei)
      ? check('gas', 'attention', `${role} is low on gas and will stop silently`, { role, address, balance: balance.toString() })
      : check('gas', 'ok', `${role} funded`, { role, address, balance: balance.toString() }));
  }

  // --- guardian pause ----------------------------------------------------
  const paused = await distributor.proposalsPaused(tag);
  checks.push(paused
    ? check('proposals', 'attention', 'the guardian has paused proposals; no new rounds will be committed', {})
    : check('proposals', 'ok', 'proposals enabled', {}));

  // --- on-chain commitments the journal does not know about --------------
  // This is the alarm that matters: a root this pipeline did not produce means either a stolen
  // proposer key or an operator working outside the journal. Either way, a human decides.
  // null means the CLI explicitly requested chain-only monitoring. An empty array instead means
  // a supplied journal with no known roots; that must still alarm on an unexpected commitment.
  const known = journalRoots === null ? null : new Set(journalRoots.map(r => r.toLowerCase()));
  const next = BigInt(await distributor.nextRoundId(tag));
  const totalReserved = BigInt(await distributor.totalReserved(tag));
  let unpaidTotal = 0n;
  let inspectedReserved = 0n;
  for (let id = next - 1n; id >= 1n && id > next - 6n; id--) {
    const [round, pending] = await Promise.all([distributor.roundInfo(id, tag), distributor.pending(id, tag)]);
    const [root, total, distributed, active, closed] = round;
    const [pendingRoot, pendingTotal, readyAt] = pending;
    inspectedReserved += BigInt(pendingTotal);
    for (const [label, candidate, amount] of [['pending', pendingRoot, pendingTotal], ['active', root, total]]) {
      if (!candidate || BigInt(amount) === 0n) continue;
      // A foreign round the guardian cancelled before anything was paid is the incident resolved, not
      // a fresh one; it keeps its root on-chain forever. One that paid anything stays alarming.
      if (label === 'active' && closed && BigInt(distributed) === 0n) continue;
      if (known !== null && !known.has(candidate.toLowerCase())) {
        checks.push(check('unknown-commitment', 'attention',
          `round ${id} carries a ${label} root the calculator journal never produced`,
          { roundId: id.toString(), root: candidate, total: amount.toString() }));
      }
    }
    if (active && BigInt(total) > BigInt(distributed)) {
      unpaidTotal += BigInt(total) - BigInt(distributed);
      inspectedReserved += BigInt(total) - BigInt(distributed);
      const previous=previousProgress?.rounds?.[id.toString()];
      const matches=previous?.root===root && previous?.total===total.toString();
      if(matches&&(BigInt(previous.distributed)<0n||BigInt(previous.distributed)>BigInt(distributed)||BigInt(previous.lastProgressAt)>timestamp
        ||BigInt(previous.lastProgressAt)<0n))throw Error('monitor round progress regressed; reconcile chain history');
      const lastProgressAt=matches&&BigInt(previous.distributed)===BigInt(distributed)?BigInt(previous.lastProgressAt):timestamp;
      progress.rounds[id.toString()]={root,total:total.toString(),distributed:distributed.toString(),lastProgressAt:lastProgressAt.toString()};
      const stale=timestamp-lastProgressAt>=BigInt(staleRoundSeconds);
      checks.push(check('round-progress', !matches||stale?'attention':'ok', !matches
        ? `round ${id} payment age unknown; monitoring starts with this persisted observation`
        : stale?`round ${id} has made no payment progress for ${timestamp-lastProgressAt}s`
        : `round ${id} active with recent observed progress`,
        { roundId: id.toString(), outstanding: (BigInt(total) - BigInt(distributed)).toString(),lastProgressAt:lastProgressAt.toString() }));
    }
    if (BigInt(pendingTotal) > 0n && BigInt(readyAt) > 0n && timestamp > BigInt(readyAt) + BigInt(staleRoundSeconds)) {
      checks.push(check('stale-round', 'attention',
        `round ${id} passed its timelock ${Number(timestamp - BigInt(readyAt))}s ago and has not been activated`,
        { roundId: id.toString(), readyAt: readyAt.toString() }));
    }
    // Rounds close independently. A newer closed round says nothing about older ones.
  }

  // Keep routine RPC work bounded, but never silently overlook funds reserved by older rounds.
  // Operators must inspect those older ids; this does not claim they have all been enumerated.
  const uninspectedReserved = totalReserved > inspectedReserved ? totalReserved - inspectedReserved : 0n;
  if (uninspectedReserved > 0n) checks.push(check('older-reservations', 'attention',
    'reserved rewards exist outside the five recent rounds; inspect older pending and active rounds',
    { uninspectedReserved: uninspectedReserved.toString() }));
  if (inspectedReserved > totalReserved) checks.push(check('reservation-accounting', 'failed',
    'inspected reservations exceed totalReserved at the same block'));
  const end = await provider.getBlock(block.number);
  if (end?.hash !== block.hash) throw Error('monitor snapshot hash changed');

  const severity = checks.some(c => c.severity === 'failed') ? 'failed'
    : checks.some(c => c.severity === 'attention') ? 'attention' : 'ok';
  return {
    chainId, timestamp: timestamp.toString(), severity, exitCode: SEVERITY[severity],
    attention: checks.filter(c => c.severity !== 'ok'),
    journal: known === null ? 'absent: pass --journal to detect commitments this pipeline did not produce' : 'checked',
    outstandingRewards: unpaidTotal.toString(),
    totalReserved: totalReserved.toString(), uninspectedReserved: uninspectedReserved.toString(),
    blockNumber: block.number, blockHash: block.hash,
    checks,
    progress,
  };
}
