#!/usr/bin/env node
/**
 * Local control console for the DICKBUTT fee flywheel.
 *
 *   node ui/server.mjs                  read-only: reads config, runs read-only commands
 *   node ui/server.mjs --allow-execute  additionally permits the commands that sign and broadcast
 *
 * This is a panel that can spend money, so it is deliberately unexciting about access:
 *
 *  - it binds to the loopback interface only, and refuses a non-loopback --host;
 *  - every request carries a token minted at startup and printed in the launch URL. The page gets it
 *    only from that URL, never from an endpoint, so a browser page on some other site cannot obtain
 *    it. (Another process on the same machine is not the boundary: it already shares the environment
 *    the keys live in.)
 *  - the Origin and Host headers must be the console's own, so a page cannot POST to it cross-site;
 *  - commands come from a fixed registry with typed slots and are spawned without a shell — nothing
 *    from the browser ever reaches a command line;
 *  - transaction-sending commands need --allow-execute AND an explicit confirmation in the request;
 *  - private keys are never read here. The child CLIs load their own from the environment, and the
 *    API reports only whether a variable is set.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadState, resolveFlow, readDoc, saveOverrides, readJson, updateConfigField, EDITABLE_FIELDS, OVERRIDES_FILE } from './state.js';
import { applyOverride } from './readiness.js';
import { describeCommands, resolveCommand } from './commands.js';
import { localWallets } from './local-wallets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUBLIC = path.join(HERE, 'public');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function parseServerArgs(argv) {
  const options = { port: 4319, host: '127.0.0.1', allowExecute: false, open: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allow-execute') options.allowExecute = true;
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--help') options.help = true;
    else if (arg === '--port' || arg === '--host') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw Error(`missing value for ${arg}`);
      if (arg === '--port') {
        options.port = Number(value);
        if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw Error('invalid --port');
      } else options.host = value;
    } else throw Error(`unknown option: ${arg.startsWith('--') ? arg : 'positional argument'}`);
  }
  // Binding beyond loopback would publish a transaction-signing console onto the network.
  if (!LOOPBACK.has(options.host)) throw Error('the console binds to loopback only; --host must be 127.0.0.1 or ::1');
  return options;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

/** In-memory run log. Restarting the console forgets it, which is the right lifetime for a scratchpad. */
export class Runs {
  constructor(limit = 40) { this.limit = limit; this.entries = new Map(); this.order = []; }
  create(command, argv) {
    const id = crypto.randomUUID();
    const entry = { id, commandId: command.id, label: command.label, kind: command.kind, argv,
      startedAt: new Date().toISOString(), status: 'running', exitCode: null, lines: [], listeners: new Set() };
    this.entries.set(id, entry);
    this.order.push(id);
    while (this.order.length > this.limit) {
      const oldest = this.entries.get(this.order.shift());
      if (oldest) {
        oldest.child?.kill('SIGTERM');
        // Tell anyone still watching, or their stream hangs open on a run that no longer exists.
        for (const listener of oldest.listeners) listener({ type: 'end', status: 'stopped', exitCode: null, signal: 'evicted' });
        this.entries.delete(oldest.id);
      }
    }
    return entry;
  }
  get(id) { return this.entries.get(id); }
  append(entry, stream, text) {
    for (const line of text.split('\n')) {
      if (!line.length) continue;
      const record = { stream, text: line.slice(0, 4000), at: Date.now() };
      entry.lines.push(record);
      if (entry.lines.length > 2000) entry.lines.splice(0, entry.lines.length - 2000);
      for (const listener of entry.listeners) listener({ type: 'line', ...record });
    }
  }
  finish(entry, exitCode, signal) {
    // 'error' and 'close' can both fire for a command that failed to start; settle once.
    if (entry.status !== 'running') return;
    entry.status = signal ? 'stopped' : exitCode === 0 ? 'succeeded' : exitCode === 2 ? 'attention' : 'failed';
    entry.exitCode = exitCode;
    entry.finishedAt = new Date().toISOString();
    entry.child = null;
    for (const listener of entry.listeners) listener({ type: 'end', status: entry.status, exitCode, signal: signal ?? null });
  }
  summary() {
    return this.order.map(id => this.entries.get(id)).filter(Boolean).map(({ id, commandId, label, kind, argv, status, exitCode, startedAt, finishedAt }) =>
      ({ id, commandId, label, kind, argv, status, exitCode, startedAt, finishedAt: finishedAt ?? null })).reverse();
  }
}

function json(response, status, body) {
  const text = JSON.stringify(body, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(text);
}

async function readBody(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createServer({ token, allowExecute = false, root = ROOT, runs = new Runs(), port = 4319 } = {}) {
  const origin = `http://127.0.0.1:${port}`;

  /**
   * A cross-site page cannot read this server's responses (no CORS headers), but it can still send
   * requests, so the browser-supplied provenance headers are checked before anything else runs.
   */
  const sameSite = request => {
    const host = (request.headers.host ?? '').split(':')[0];
    if (!LOOPBACK.has(host)) return false;
    const sent = request.headers.origin;
    if (sent && sent !== origin && sent !== `http://localhost:${port}`) return false;
    const site = request.headers['sec-fetch-site'];
    return !site || site === 'same-origin' || site === 'none';
  };

  /** Same-origin plus a startup token: enough to keep every other process on the box out. */
  const authorized = (request, url) => {
    if (!sameSite(request)) return false;
    const supplied = request.headers['x-console-token'] ?? url.searchParams.get('token');
    // Constant-time compare so the token cannot be recovered a character at a time.
    return typeof supplied === 'string' && supplied.length === token.length
      && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, origin);
    try {
      // The shell page is served unauthenticated so the browser can bootstrap; it contains no data.
      if (url.pathname === '/' && request.method === 'GET') {
        const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
        response.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'" });
        return response.end(html);
      }
      if (!url.pathname.startsWith('/api/') && request.method === 'GET') {
        const file = path.join(PUBLIC, url.pathname.replace(/^\/+/, ''));
        if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          return json(response, 404, { error: 'not found' });
        }
        response.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        return response.end(fs.readFileSync(file));
      }

      if (url.pathname === '/api/session' && request.method === 'GET') {
        // Mode only. The token travels in the launch URL and is never handed out by the server.
        if (!sameSite(request)) return json(response, 403, { error: 'cross-site request refused' });
        return json(response, 200, { allowExecute, port });
      }

      if (!authorized(request, url)) return json(response, 403, { error: 'unauthorized console request' });

      if (url.pathname === '/api/local-wallets' && request.method === 'GET') {
        return json(response, 200, await localWallets(root));
      }

      if (url.pathname === '/api/state' && request.method === 'GET') {
        const state = loadState(root);
        const network = url.searchParams.get('network') ?? 'base-mainnet';
        return json(response, 200, {
          ...state,
          allowExecute,
          flow: resolveFlow(network, state.config),
          commands: describeCommands({ allowWrite: allowExecute, env: process.env, root }),
          runs: runs.summary(),
          editableFields: EDITABLE_FIELDS,
        });
      }

      if (url.pathname === '/api/doc' && request.method === 'GET') {
        return json(response, 200, { path: url.searchParams.get('path'), text: readDoc(root, url.searchParams.get('path') ?? '') });
      }

      if (url.pathname === '/api/checklist' && request.method === 'POST') {
        const { id, state, note } = await readBody(request);
        const next = applyOverride(readJson(root, OVERRIDES_FILE) ?? {}, id, state, note);
        saveOverrides(root, next);
        return json(response, 200, { ok: true, readiness: loadState(root).readiness });
      }

      if (url.pathname === '/api/config' && request.method === 'POST') {
        const { field, value } = await readBody(request);
        updateConfigField(root, field, value);
        const state = loadState(root);
        return json(response, 200, { ok: true, config: state.config, readiness: state.readiness });
      }

      if (url.pathname === '/api/run' && request.method === 'POST') {
        const body = await readBody(request);
        const { command, argv, env } = resolveCommand(body.id, { inputs: body.inputs ?? {}, allowWrite: allowExecute, confirm: body.confirm ?? null, root });
        const entry = runs.create(command, argv);
        // No shell: argv goes to the binary verbatim, so nothing in it can be reinterpreted.
        const child = spawn(argv[0], argv.slice(1), { cwd: root, shell: false, env: { ...process.env, ...env, FORCE_COLOR: '0' } });
        entry.child = child;
        child.stdout.on('data', chunk => runs.append(entry, 'out', chunk.toString()));
        child.stderr.on('data', chunk => runs.append(entry, 'err', chunk.toString()));
        child.on('error', error => { runs.append(entry, 'err', `failed to start: ${error.message}`); runs.finish(entry, 1, null); });
        child.on('close', (code, signal) => runs.finish(entry, code, signal));
        return json(response, 200, { id: entry.id, commandId: command.id, argv, kind: command.kind });
      }

      if (url.pathname === '/api/stop' && request.method === 'POST') {
        const { id } = await readBody(request);
        const entry = runs.get(id);
        if (!entry?.child) return json(response, 404, { error: 'no running command with that id' });
        entry.child.kill('SIGTERM');
        return json(response, 200, { ok: true });
      }

      if (url.pathname === '/api/stream' && request.method === 'GET') {
        const entry = runs.get(url.searchParams.get('id'));
        if (!entry) return json(response, 404, { error: 'unknown run' });
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        // A browser can vanish between a socket closing and the 'close' event; a write that loses
        // that race must not take the console down with it.
        response.on('error', () => {});
        const send = event => {
          if (response.writableEnded || response.destroyed) return;
          try { response.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client left */ }
        };
        for (const line of entry.lines) send({ type: 'line', ...line });
        if (entry.status !== 'running') { send({ type: 'end', status: entry.status, exitCode: entry.exitCode }); return response.end(); }
        entry.listeners.add(send);
        const keepAlive = setInterval(() => response.write(': ping\n\n'), 15000);
        const close = () => { clearInterval(keepAlive); entry.listeners.delete(send); };
        request.on('close', close);
        return undefined;
      }

      return json(response, 404, { error: 'no such endpoint' });
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  });
  return server;
}

const USAGE = `Usage: node ui/server.mjs [--port 4319] [--allow-execute] [--no-open]

Local console for the DICKBUTT fee flywheel: flow diagram, launch checklist, configuration and the
operating commands. Binds to loopback only and mints a per-session token.

  --allow-execute  permit the commands that sign and broadcast transactions. Without it the console
                   runs reads, dry runs and the local rehearsal only.`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseServerArgs(process.argv.slice(2));
  if (options.help) console.log(USAGE);
  else {
    const token = crypto.randomBytes(24).toString('base64url');
    const server = createServer({ token, allowExecute: options.allowExecute, port: options.port });
    // A second console on the same port would otherwise die with an unhandled 'error' event and a
    // stack trace, which reads like a bug rather than "it is already running".
    server.on('error', error => {
      console.error(error.code === 'EADDRINUSE'
        ? `  Port ${options.port} is already in use — the console may already be running. Try --port ${options.port + 1}.`
        : `  Console failed to start: ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(options.port, options.host, () => {
      const url = `http://127.0.0.1:${options.port}/?token=${token}`;
      console.log(`\n  DICKBUTT console  ${options.allowExecute ? 'EXECUTE ENABLED — transaction-signing commands are available' : 'read-only'}`);
      console.log(`  ${url}\n`);
      if (options.open) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    });
  }
}
