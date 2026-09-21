import test from 'node:test';
import assert from 'node:assert/strict';
import { JOBS, validateSchedule, hostPlan, CONTRACT_LIMITS } from '../schedule.js';
import { renderSystemd, renderCron, renderPlan, parseScheduleArgs } from '../../script/render-schedule.mjs';

const opts = { workdir: '/srv/d', manifest: 'm.json', calculator: 'c.json', journal: './data' };

test('six-hour reward rounds have no extra review delay and check for payouts each minute', () => {
  const proposer = JOBS.find(j => j.name === 'calculate-and-propose');
  assert.equal(proposer.everySeconds, 6 * 3600);
  assert.equal(CONTRACT_LIMITS.minRoundIntervalSeconds, proposer.everySeconds);
  assert.equal(CONTRACT_LIMITS.roundDelaySeconds, 0);
  assert.equal(JOBS.find(j => j.name === 'fee-cycle').everySeconds, 6 * 3600);
  assert.equal(JOBS.find(j => j.name === 'payout').everySeconds, 60);
  assert.ok(renderSystemd([proposer], opts).includes('OnUnitActiveSec=21600s'));
  assert.ok(renderCron([proposer], opts).includes('0 */6 * * *'));
  assert.deepEqual(validateSchedule(), []);
});

test('the shipped schedule keeps every key on exactly one host', () => {
  assert.deepEqual(validateSchedule(), []);
  const plan = hostPlan();
  const seen = new Map();
  for (const h of plan) for (const k of h.keys) {
    assert.ok(!seen.has(k), `${k} appears on ${seen.get(k)} and ${h.host}`);
    seen.set(k, h.host);
  }
  assert.deepEqual(plan.find(h => h.host === 'monitor').keys, [], 'the monitor holds no key');
});

test('a key on two hosts is rejected', () => {
  const bad = JOBS.map(j => (j.name === 'floor-refresh' ? { ...j, key: 'KEEPER_PRIVATE_KEY' } : j));
  assert.ok(validateSchedule(bad).some(e => e.includes('more than one host')));
});

test('the keeper key may not run on the ops host', () => {
  const bad = JOBS.map(j => (j.name === 'payout' ? { ...j, host: 'ops' } : j));
  assert.ok(validateSchedule(bad).some(e => e.includes('must not run on the ops host')));
});

test('the monitor must be keyless and live alone', () => {
  assert.ok(validateSchedule(JOBS.filter(j => j.name !== 'monitor')).some(e => e.includes('cannot alert on itself')));
  const keyed = JOBS.map(j => (j.name === 'monitor' ? { ...j, key: 'KEEPER_PRIVATE_KEY' } : j));
  assert.ok(validateSchedule(keyed).some(e => e.includes('must not hold a signing key')));
  const colocated = JOBS.map(j => (j.name === 'monitor' ? { ...j, host: 'keeper' } : j));
  assert.ok(validateSchedule(colocated).some(e => e.includes('dies with the thing it watches')));
});

test('cadences that contradict contract limits are rejected', () => {
  const slowFloor = JOBS.map(j => (j.name === 'floor-refresh' ? { ...j, everySeconds: CONTRACT_LIMITS.floorLifetimeSeconds } : j));
  assert.ok(validateSchedule(slowFloor).some(e => e.includes('floor expires within')));
  const eagerPropose = JOBS.map(j => (j.name === 'calculate-and-propose' ? { ...j, everySeconds: 3600 } : j));
  assert.ok(validateSchedule(eagerPropose).some(e => e.includes('round interval')));
  const lazyPayout = JOBS.map(j => (j.name === 'payout' ? { ...j, everySeconds: 48 * 3600 } : j));
  assert.ok(validateSchedule(lazyPayout).some(e => e.includes('activated and unpaid')));
  assert.ok(validateSchedule([{ name: 'x', host: 'h', everySeconds: 5, command: ['a'] }]).some(e => e.includes('at least 60')));
});

test('the proposer job never asks for the keeper key', () => {
  const propose = JOBS.find(j => j.name === 'calculate-and-propose');
  const text = JSON.stringify(propose);
  assert.ok(text.includes('--propose-only'));
  assert.ok(!text.includes('KEEPER_PRIVATE_KEY'));
});

test('renderers substitute paths and mark exit 2 as non-fatal', () => {
  const systemd = renderSystemd(JOBS, opts);
  assert.ok(systemd.includes('SuccessExitStatus=0 2'), 'exit 2 is "needs a human", not a crash loop');
  assert.ok(systemd.includes('WorkingDirectory=/srv/d'));
  assert.ok(systemd.includes('OnUnitActiveSec=60s'));
  assert.ok(!systemd.includes('${MANIFEST}'), 'placeholders must be substituted');
  assert.ok(systemd.includes('EnvironmentFile=/srv/d/env/keeper.env'));

  const cron = renderCron(JOBS, opts);
  assert.ok(cron.includes('*/1 * * * *'));
  assert.ok(cron.includes('0 */6 * * *'));
  assert.ok(!cron.includes('${JOURNAL}'));
  assert.ok(!cron.match(/PRIVATE_KEY=/), 'a rendered crontab must never contain a key value');

  assert.ok(renderPlan(JOBS).includes('shared blast radius'));
});

test('schedule CLI validates its own options', () => {
  assert.equal(parseScheduleArgs([]).format, 'plan');
  assert.equal(parseScheduleArgs(['--format', 'systemd']).format, 'systemd');
  assert.equal(parseScheduleArgs(['--host', 'keeper']).host, 'keeper');
  assert.throws(() => parseScheduleArgs(['--format', 'ansible']), /systemd, cron or plan/);
  assert.throws(() => parseScheduleArgs(['--host', 'laptop']), /unknown host/);
  assert.throws(() => parseScheduleArgs(['--format']), /missing value/);
  assert.throws(() => parseScheduleArgs(['--wat', 'x']), /unknown schedule option/);
});
