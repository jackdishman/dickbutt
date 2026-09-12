import test from 'node:test';
import assert from 'node:assert/strict';
import { runFloorRefresh } from '../floor.js';

const OWNER = '0x0000000000000000000000000000000000000A11';
const OPS = '0x0000000000000000000000000000000000000B0B';
const KEEPER = '0xddF3C9dc9AE1F68196F4a63dfAEaF34b3B61d26F';
const NOW = 1_700_000_000n;
const DAY = 86400n;

function harness({ floor = 19n * 10n ** 17n, remaining = DAY, keepers = [KEEPER], setters = [OPS], lowerBound = 10n ** 18n, chainId = 31337n, sendFails = false } = {}) {
  const calls = [];
  const executor = {
    minSpcxcPerWeth: async () => floor,
    priceFloorExpiresAt: async () => (remaining > 0n ? NOW + remaining : NOW - 1n),
    maxSwapPerCall: async () => 10n ** 18n,
    MAX_FLOOR_LIFETIME: async () => DAY,
    owner: async () => OWNER,
    isKeeper: async a => keepers.some(k => k.toLowerCase() === a.toLowerCase()),
    isFloorSetter: async a => setters.some(k => k.toLowerCase() === a.toLowerCase()),
    floorLowerBound: async () => lowerBound,
    setPriceFloor: async (f, e) => {
      calls.push({ floor: f, expiresAt: e });
      return { hash: '0xfeed', wait: async () => (sendFails ? { status: 0 } : { status: 1 }) };
    },
  };
  const provider = { getNetwork: async () => ({ chainId }), getBlock: async () => ({ timestamp: Number(NOW) }) };
  return { calls, executor, provider, quote: async amount => amount * 2n };
}

test('a fresh floor does no work and reports time remaining', async () => {
  const h = harness({ remaining: 20n * 3600n });
  const r = await runFloorRefresh({ ...h, signerAddress: OWNER });
  assert.equal(r.status, 'fresh');
  assert.equal(r.swapsBlocked, false);
  assert.equal(r.secondsRemaining, 72000);
  assert.equal(h.calls.length, 0);
  assert.equal(r.proposedFloor, undefined);
});

test('alerts on the way to expiry and once swaps are blocked', async () => {
  // Read-only monitor role: no signer, no key, runs anywhere. Only job is to raise `alert`.
  const quiet = await runFloorRefresh({ ...harness({ remaining: 20n * 3600n }), warnBeforeSeconds: 4 * 3600 });
  assert.equal(quiet.status, 'fresh');
  assert.equal(quiet.alert, false);

  const events = [];
  const late = await runFloorRefresh({ ...harness({ remaining: 3n * 3600n }),
    refreshBeforeSeconds: 8 * 3600, warnBeforeSeconds: 4 * 3600, onEvent: e => events.push(e) });
  assert.equal(late.status, 'refresh-required');
  assert.equal(late.alert, true, 'the refresher should have run by now; page someone');
  assert.ok(events.some(e => e.type === 'floor-expiring'));

  const dead = [];
  const expired = await runFloorRefresh({ ...harness({ remaining: 0n }), onEvent: e => dead.push(e) });
  assert.equal(expired.status, 'expired');
  assert.equal(expired.swapsBlocked, true);
  assert.equal(expired.alert, true);
  assert.ok(dead.some(e => e.type === 'floor-expiring' && e.swapsBlocked === true));

  // Acting in the same invocation clears the alert rather than leaving a stale page.
  const fixed = await runFloorRefresh({ ...harness({ remaining: 0n }), signerAddress: OWNER, execute: true });
  assert.equal(fixed.status, 'refreshed');
  assert.equal(fixed.alert, false);
});

test('refuses a signer that is also an approved keeper', async () => {
  await assert.rejects(
    runFloorRefresh({ ...harness(), signerAddress: KEEPER, execute: true }),
    /not a keeper/);
  // Still refuses in dry-run: the key must never be shared, regardless of mode.
  await assert.rejects(runFloorRefresh({ ...harness(), signerAddress: KEEPER }), /not a keeper/);
});

test('dry-run computes the floor from a cap-sized quote without sending', async () => {
  const h = harness({ remaining: 60n });
  const r = await runFloorRefresh({ ...h, signerAddress: OWNER, slippageBps: 500 });
  assert.equal(r.status, 'refresh-required');
  assert.equal(r.mode, 'dry-run');
  assert.equal(r.referenceAmount, (10n ** 18n).toString());
  // cap 1e18 quoted at 2x, less 5%, normalised per 1e18 WETH.
  assert.equal(r.proposedFloor, (19n * 10n ** 17n).toString());
  assert.equal(h.calls.length, 0);
});

test('execute refreshes and bounds the expiry to the contract maximum', async () => {
  const h = harness({ remaining: 60n });
  const r = await runFloorRefresh({ ...h, signerAddress: OWNER, execute: true, lifetimeSeconds: 20 * 3600 });
  assert.equal(r.status, 'refreshed');
  assert.equal(r.transaction, '0xfeed');
  assert.equal(r.swapsBlocked, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].expiresAt, NOW + 20n * 3600n);
  await assert.rejects(
    runFloorRefresh({ ...harness({ remaining: 60n }), signerAddress: OWNER, execute: true, lifetimeSeconds: 25 * 3600 }),
    /MAX_FLOOR_LIFETIME/);
});

test('guards the quote, the owner, the chain and reverted receipts', async () => {
  const base = { ...harness({ remaining: 60n }), signerAddress: OWNER, execute: true };
  await assert.rejects(runFloorRefresh({ ...base, quote: async () => 0n }), /zero quote/);
  await assert.rejects(runFloorRefresh({ ...base, signerAddress: '0x00000000000000000000000000000000000000Bb' }), /neither an approved floor setter nor the executor owner/);
  await assert.rejects(runFloorRefresh({ ...harness({ remaining: 60n, chainId: 8453n }), signerAddress: OWNER, execute: true }), /disabled/);
  await assert.rejects(runFloorRefresh({ ...harness({ remaining: 60n, sendFails: true }), signerAddress: OWNER, execute: true }), /set-price-floor failed/);
  await assert.rejects(runFloorRefresh({ ...base, slippageBps: 9000 }), /basis points/);
  await assert.rejects(runFloorRefresh({ ...base, warnBeforeSeconds: 0 }), /invalid warnBeforeSeconds/);
});

test('a wildly different quote is rejected until explicitly forced', async () => {
  // Active floor 1e18; a 10x quote move should not silently become the new backstop.
  const h = harness({ remaining: 60n, floor: 10n ** 17n });
  await assert.rejects(runFloorRefresh({ ...h, signerAddress: OWNER, execute: true }), /deviates/);
  const forced = await runFloorRefresh({ ...h, signerAddress: OWNER, execute: true, force: true });
  assert.equal(forced.status, 'refreshed');
  assert.ok(forced.deviationBps > 5000);
  // A modest move passes without force.
  const calm = await runFloorRefresh({ ...harness({ remaining: 60n, floor: 18n * 10n ** 17n }), signerAddress: OWNER, execute: true });
  assert.equal(calm.status, 'refreshed');
});

test('the floor-setter role refreshes; the owner is accepted; a stranger is not', async () => {
  const h = harness({ remaining: 60n });
  const r = await runFloorRefresh({ ...h, signerAddress: OPS, execute: true });
  assert.equal(r.status, 'refreshed');
  assert.equal(h.calls.length, 1);
  assert.equal(r.floorLowerBound, (10n ** 18n).toString());
  assert.equal(r.lowerBoundUnset, false);
  const asOwner = await runFloorRefresh({ ...harness({ remaining: 60n }), signerAddress: OWNER, execute: true });
  assert.equal(asOwner.status, 'refreshed');
  await assert.rejects(runFloorRefresh({ ...harness({ remaining: 60n }), signerAddress: '0x00000000000000000000000000000000000000Cc', execute: true }), /neither an approved floor setter/);
});

test('a quote that lands below the owner lower bound is refused for every signer', async () => {
  // Quote 2x less 5% is 1.9e18; a bound at 2e18 means the market has fallen through the owner's line.
  const low = harness({ remaining: 60n, lowerBound: 2n * 10n ** 18n });
  await assert.rejects(runFloorRefresh({ ...low, signerAddress: OPS, execute: true }), /below the owner lower bound/);
  await assert.rejects(runFloorRefresh({ ...low, signerAddress: OWNER, execute: true }), /below the owner lower bound/);
  assert.equal(low.calls.length, 0);
  // An unset bound is reported so the monitor can flag it; it does not stop the refresh.
  const unset = await runFloorRefresh({ ...harness({ remaining: 60n, lowerBound: 0n }), signerAddress: OPS, execute: true });
  assert.equal(unset.lowerBoundUnset, true);
  assert.equal(unset.status, 'refreshed');
});
