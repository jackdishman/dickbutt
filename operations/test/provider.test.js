import test from 'node:test';
import assert from 'node:assert/strict';
import { closeProvider } from '../provider.js';

test('teardown stops the poller and never calls destroy', () => {
  // destroy() rejects in-flight requests. After a settled tx.wait() one poll can still be open,
  // and that rejection turns a fully successful run into a non-zero exit.
  const calls = [];
  closeProvider({ removeAllListeners: () => calls.push('removeAllListeners'),
    destroy: () => calls.push('destroy') });
  assert.deepEqual(calls, ['removeAllListeners']);
});

test('teardown tolerates an absent provider', () => {
  assert.doesNotThrow(() => closeProvider(undefined));
  assert.doesNotThrow(() => closeProvider(null));
});
