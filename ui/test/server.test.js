import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseServerArgs, createServer, Runs } from '../server.mjs';

const TOKEN = 'a'.repeat(32);

/** Start a console on an ephemeral port and hand the caller a fetch bound to it. */
async function withConsole(options, body) {
  const server = createServer({ token: TOKEN, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, init = {}) => fetch(base + path, {
    ...init,
    headers: { 'x-console-token': TOKEN, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  request.base = base;
  try { return await body(request); } finally { server.close(); }
}

/** The stream stays open while a run is live, so wait for it to settle before reading it whole. */
async function settle(request, id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { runs } = await (await request('/api/state')).json();
    const run = runs.find(entry => entry.id === id);
    if (run && run.status !== 'running') return run;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('run never finished');
}

test('the console refuses to bind anywhere but loopback', () => {
  assert.throws(() => parseServerArgs(['--host', '0.0.0.0']), /loopback only/);
  assert.throws(() => parseServerArgs(['--host', '192.168.1.10']), /loopback only/);
  assert.equal(parseServerArgs([]).host, '127.0.0.1');
  assert.equal(parseServerArgs([]).allowExecute, false);
});

test('unknown and malformed options are rejected', () => {
  assert.throws(() => parseServerArgs(['--allow-everything']), /unknown option/);
  assert.throws(() => parseServerArgs(['--port']), /missing value/);
  assert.throws(() => parseServerArgs(['--port', '99999']), /invalid --port/);
});

test('an API call without the token is refused', async () => {
  await withConsole({}, async request => {
    const response = await fetch(`${request.base}/api/state`);
    assert.equal(response.status, 403);
  });
});

test('a cross-site request is refused even when it carries the token', async () => {
  await withConsole({}, async request => {
    const response = await request('/api/state', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(response.status, 403);
    const withOrigin = await request('/api/state', { headers: { origin: 'https://evil.example' } });
    assert.equal(withOrigin.status, 403);
  });
});

test('state describes the flow, the checklist and the commands', async () => {
  await withConsole({}, async request => {
    const state = await (await request('/api/state?network=base-sepolia')).json();
    assert.equal(state.flow.network, 'base-sepolia');
    assert.ok(state.flow.nodes.length > 10);
    assert.ok(state.readiness.items.length > 10);
    assert.ok(state.commands.length > 10);
    assert.equal(state.allowExecute, false);
  });
});

test('a read-only console refuses to start a transaction-signing command', async () => {
  await withConsole({}, async request => {
    const response = await request('/api/run', { method: 'POST', body: JSON.stringify({ id: 'fees-execute', confirm: 'fees-execute' }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /read-only/);
  });
});

test('an execute-enabled console still requires the confirmation', async () => {
  await withConsole({ allowExecute: true }, async request => {
    const response = await request('/api/run', { method: 'POST', body: JSON.stringify({ id: 'fees-execute' }) });
    assert.match((await response.json()).error, /confirmation required/);
  });
});

test('a command runs, streams its output and reports its exit code', async () => {
  await withConsole({ runs: new Runs() }, async request => {
    const started = await (await request('/api/run', {
      method: 'POST', body: JSON.stringify({ id: 'schedule', inputs: { format: 'cron' } }),
    })).json();
    assert.equal(started.kind, 'read');

    const finished = await settle(request, started.id);
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.exitCode, 0);

    // Replaying a settled run closes the stream, so the whole transcript can be read at once.
    const text = await (await request(`/api/stream?id=${started.id}`)).text();
    assert.match(text, /"type":"line"/);
    assert.match(text, /"type":"end"/);
    assert.match(text, /"status":"succeeded"/);
    // The rendered crontab is the actual evidence that a real child process ran.
    assert.match(text, /npm run fees/);
  });
});

test('run status distinguishes "needs a human" from "crashed"', () => {
  const runs = new Runs();
  const entry = runs.create({ id: 'monitor', label: 'Health check', kind: 'read' }, ['true']);
  runs.finish(entry, 2, null);
  assert.equal(entry.status, 'attention');
  const failed = runs.create({ id: 'monitor', label: 'Health check', kind: 'read' }, ['false']);
  runs.finish(failed, 1, null);
  assert.equal(failed.status, 'failed');
});

test('the run log is bounded so a long session cannot grow without limit', () => {
  const runs = new Runs(3);
  for (let i = 0; i < 10; i++) runs.finish(runs.create({ id: 'x', label: 'x', kind: 'read' }, ['true']), 0, null);
  assert.equal(runs.summary().length, 3);
});

test('output lines are truncated and capped', () => {
  const runs = new Runs();
  const entry = runs.create({ id: 'x', label: 'x', kind: 'read' }, ['true']);
  runs.append(entry, 'out', `${'x'.repeat(9000)}\n`);
  assert.equal(entry.lines[0].text.length, 4000);
  for (let i = 0; i < 2500; i++) runs.append(entry, 'out', `line ${i}\n`);
  assert.equal(entry.lines.length, 2000);
});

test('static files outside the public directory are not served', async () => {
  await withConsole({}, async request => {
    for (const path of ['/../package.json', '/..%2fpackage.json', '/api/doc?path=../package.json']) {
      const response = await request(path);
      assert.ok(response.status >= 400, `${path} was served`);
    }
  });
});

test('a torn or oversized request body is rejected rather than parsed', async () => {
  await withConsole({}, async request => {
    const huge = await request('/api/checklist', { method: 'POST', body: JSON.stringify({ id: 'x', note: 'y'.repeat(70000) }) });
    assert.equal(huge.status, 400);
    assert.match((await huge.json()).error, /too large/);
  });
});

test('the token comparison is length-guarded so it cannot throw', async () => {
  await withConsole({}, async request => {
    for (const candidate of ['', 'short', crypto.randomBytes(64).toString('hex')]) {
      const response = await fetch(`${request.base}/api/state`, { headers: { 'x-console-token': candidate } });
      assert.equal(response.status, 403);
    }
  });
});
