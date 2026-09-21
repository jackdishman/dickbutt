import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

test('environment-only calculator refuses an omitted batch size before contacting any RPC', () => {
  const script = fileURLToPath(new URL('../../calculate-rewards.js', import.meta.url));
  const result = spawnSync(process.execPath, [script], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, RPC_URL: 'http://127.0.0.1:1',
      DICKBUTT_ADDRESS: '0x' + '11'.repeat(20), DISTRIBUTOR_ADDRESS: '0x' + '22'.repeat(20),
      DICKBUTT_DEPLOY_BLOCK: '1', PAYOUT_THRESHOLD_RAW: '1', WEIGHTING: 'linear' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing BATCH_SIZE/);
  assert.doesNotMatch(result.stderr, /ECONNREFUSED|failed to detect network/);
});
