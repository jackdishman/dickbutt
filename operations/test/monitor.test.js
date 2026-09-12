import test from 'node:test';
import assert from 'node:assert/strict';
import { runMonitor } from '../monitor.js';

const ZERO = '0x' + '0'.repeat(64);
const KNOWN = '0x' + 'ab'.repeat(32);
const ROGUE = '0x' + 'cd'.repeat(32);
const NOW = 1_700_000_000n;

function harness({ floor = 1n, remaining = 20n * 3600n, paused = false, balances = {},
  rounds = [], next = 1n } = {}) {
  const provider = {
    getNetwork: async () => ({ chainId: 8453n }),
    getBlock: async () => ({ timestamp: Number(NOW) }),
    getBalance: async a => balances[a.toLowerCase()] ?? 10n ** 18n,
  };
  const executor = {
    minSpcxcPerWeth: async () => floor,
    priceFloorExpiresAt: async () => (remaining > 0n ? NOW + remaining : NOW - 1n),
  };
  const byId = new Map(rounds.map(r => [String(r.id), r]));
  const distributor = {
    proposalsPaused: async () => paused,
    nextRoundId: async () => next,
    roundInfo: async id => {
      const r = byId.get(String(id));
      return r ? [r.root ?? ZERO, r.total ?? 0n, r.distributed ?? 0n, r.active ?? false, r.closed ?? false]
        : [ZERO, 0n, 0n, false, false];
    },
    pending: async id => {
      const r = byId.get(String(id));
      return r ? [r.pendingRoot ?? ZERO, r.pendingTotal ?? 0n, r.readyAt ?? 0n] : [ZERO, 0n, 0n];
    },
  };
  return { provider, executor, distributor, journalRoots: [KNOWN] };
}

test('a healthy system reports ok and exit 0', async () => {
  const r = await runMonitor({ ...harness(), gasAccounts: { keeper: '0x' + '11'.repeat(20) } });
  assert.equal(r.severity, 'ok');
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.attention, []);
});

test('an expired or soon-to-expire floor asks for attention', async () => {
  const dead = await runMonitor({ ...harness({ remaining: 0n }) });
  assert.equal(dead.exitCode, 2);
  assert.ok(dead.attention.some(c => c.name === 'price-floor' && c.detail.includes('blocked')));

  const soon = await runMonitor({ ...harness({ remaining: 2n * 3600n }), floorWarnSeconds: 4 * 3600 });
  assert.equal(soon.exitCode, 2);
  assert.ok(soon.attention.some(c => c.detail.includes('refresher may be down')));

  // A floor outliving the contract maximum means the executor is not what we think it is.
  const impossible = await runMonitor({ ...harness({ remaining: 40n * 3600n }) });
  assert.equal(impossible.severity, 'failed');
  assert.equal(impossible.exitCode, 1);
});

test('an unfunded bot is flagged before it fails silently', async () => {
  const keeper = '0x' + '22'.repeat(20);
  const r = await runMonitor({
    ...harness({ balances: { [keeper.toLowerCase()]: 10n ** 12n } }),
    gasAccounts: { keeper, proposer: '0x' + '33'.repeat(20) },
  });
  assert.equal(r.exitCode, 2);
  const low = r.attention.find(c => c.name === 'gas');
  assert.equal(low.role, 'keeper');
  assert.ok(low.detail.includes('stop silently'));
  // The funded one is reported but not escalated.
  assert.ok(r.checks.some(c => c.name === 'gas' && c.role === 'proposer' && c.severity === 'ok'));
});

test('a guardian pause is surfaced rather than mistaken for a dead proposer', async () => {
  const r = await runMonitor({ ...harness({ paused: true }) });
  assert.equal(r.exitCode, 2);
  assert.ok(r.attention.some(c => c.name === 'proposals' && c.detail.includes('guardian')));
});

test('a root the journal never produced is the alarm that matters', async () => {
  const rogue = await runMonitor({
    ...harness({ next: 2n, rounds: [{ id: 1, pendingRoot: ROGUE, pendingTotal: 500n, readyAt: NOW + 3600n }] }),
  });
  assert.equal(rogue.exitCode, 2);
  const hit = rogue.attention.find(c => c.name === 'unknown-commitment');
  assert.equal(hit.root, ROGUE);
  assert.equal(hit.roundId, '1');

  // The same shape with a root the journal knows is not an alarm.
  const legit = await runMonitor({
    ...harness({ next: 2n, rounds: [{ id: 1, pendingRoot: KNOWN, pendingTotal: 500n, readyAt: NOW + 3600n }] }),
  });
  assert.ok(!legit.attention.some(c => c.name === 'unknown-commitment'));
});

test('a round left sitting past its timelock is flagged and outstanding value is totalled', async () => {
  const stale = await runMonitor({
    ...harness({ next: 2n, rounds: [{ id: 1, pendingRoot: KNOWN, pendingTotal: 500n, readyAt: NOW - 9n * 3600n }] }),
    staleRoundSeconds: 6 * 3600,
  });
  assert.equal(stale.exitCode, 2);
  assert.ok(stale.attention.some(c => c.name === 'stale-round'));

  const active = await runMonitor({
    ...harness({ next: 2n, rounds: [{ id: 1, root: KNOWN, total: 1000n, distributed: 400n, active: true }] }),
  });
  assert.equal(active.outstandingRewards, '600');
});
