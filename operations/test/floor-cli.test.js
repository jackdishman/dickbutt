import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFloorArgs } from '../../script/run-floor.mjs';

const base = ['--config', 'deployment.json'];

test('floor CLI defaults are read-only with a warning window inside the refresh window', () => {
  const o = parseFloorArgs(base);
  assert.equal(o.execute, false);
  assert.equal(o.monitor, false);
  assert.equal(o.lifetimeSeconds, 20 * 3600);
  assert.equal(o.refreshBeforeSeconds, 8 * 3600);
  assert.equal(o.warnBeforeSeconds, 4 * 3600);
  assert.ok(o.warnBeforeSeconds < o.refreshBeforeSeconds, 'alert must fire only after a refresh was already due');
  assert.ok(o.lifetimeSeconds <= 24 * 3600, 'contract rejects a lifetime over one day');
});

test('floor CLI rejects contradictory and malformed options', () => {
  assert.throws(() => parseFloorArgs([...base, '--monitor', '--execute']), /read-only/);
  assert.throws(() => parseFloorArgs([...base, '--force']), /only applies to --execute/);
  assert.throws(() => parseFloorArgs(['--execute']), /--config is required/);
  assert.throws(() => parseFloorArgs([...base, '--lifetime-hours']), /missing or invalid/);
  assert.throws(() => parseFloorArgs([...base, '--lifetime-hours', '0']), /invalid value/);
  assert.throws(() => parseFloorArgs([...base, '--lifetime-hours', 'soon']), /missing or invalid/);
  assert.throws(() => parseFloorArgs([...base, '--slippage-bps', '1.5']), /must be an integer/);
  assert.throws(() => parseFloorArgs([...base, '--config']), /missing value/);
  assert.throws(() => parseFloorArgs([...base, '--danger']), /unknown floor option/);
  assert.throws(() => parseFloorArgs([...base, 'deploy']), /positional argument/);
});

test('floor CLI accepts fractional hours and explicit tuning', () => {
  const o = parseFloorArgs([...base, '--execute', '--force', '--lifetime-hours', '23.5',
    '--refresh-before-hours', '6', '--warn-before-hours', '2', '--slippage-bps', '300', '--max-deviation-bps', '2000']);
  assert.equal(o.lifetimeSeconds, 84600);
  assert.equal(o.refreshBeforeSeconds, 6 * 3600);
  assert.equal(o.warnBeforeSeconds, 2 * 3600);
  assert.equal(o.slippageBps, 300);
  assert.equal(o.maxDeviationBps, 2000);
  assert.equal(o.force, true);
});
