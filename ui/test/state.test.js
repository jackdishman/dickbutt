import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFlow, envPresence, updateConfigField, saveOverrides, readDoc, loadState, readJson } from '../state.js';

const REPO = path.resolve(import.meta.dirname, '../..');

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dickbutt-console-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'config/base-mainnet.json'), path.join(dir, 'config/base-mainnet.json'));
  return dir;
}

test('mainnet shows this repository\'s contracts as undeployed, not as errors', () => {
  const mainnet = readJson(REPO, 'config/base-mainnet.json');
  const { nodes } = resolveFlow('base-mainnet', { mainnet, sepolia: null, legacy: null });
  const router = nodes.find(node => node.id === 'feeRouter');
  assert.equal(router.status, 'undeployed');
  assert.equal(router.tone, 'warning');
  assert.equal(nodes.find(node => node.id === 'rewardsPool').tone, 'good');
  // Exercise missing-pool behavior explicitly; the repository now records a real pool.
  const missingPool = structuredClone(mainnet);
  missingPool.rewardsPool.pool = null;
  const missing = resolveFlow('base-mainnet', { mainnet: missingPool, sepolia: null, legacy: null });
  assert.equal(missing.nodes.find(node => node.id === 'rewardsPool').tone, 'critical');
});

test('the sepolia manifest resolves the same nodes as deployed', () => {
  const state = loadState(REPO);
  const { nodes } = resolveFlow('base-sepolia', state.config);
  const router = nodes.find(node => node.id === 'feeRouter');
  assert.equal(router.status, 'deployed');
  assert.match(router.address, /^0x[0-9a-fA-F]{40}$/);
});

test('nodes carry the geometry the client draws with', () => {
  const { nodes, viewBox } = resolveFlow('base-mainnet', loadState(REPO).config);
  for (const node of nodes) {
    for (const key of ['x', 'y', 'w', 'h']) assert.equal(typeof node[key], 'number', `${node.id} has no ${key}`);
    assert.ok(node.x + node.w <= viewBox.width);
  }
});

test('production shows ERC-20 LP while the historical NFT rehearsal keeps its own model',()=>{
  const config=loadState(REPO).config;
  const main=resolveFlow('base-mainnet',config).nodes.find(n=>n.id==='aeroHarvester');
  assert.equal(main.contract,'src/AerodromeVammHarvester.sol');assert.match(main.sub,/ERC-20/);
  const old=resolveFlow('base-sepolia',config).nodes.find(n=>n.id==='aeroHarvester');
  assert.equal(old.contract,'src/AerodromeFeeHarvester.sol');assert.match(old.sub,/NFT/);
});

test('environment reporting states presence and never the value', () => {
  const entries = envPresence({ RPC_URL: 'https://secret.example', KEEPER_PRIVATE_KEY: '0xdeadbeef' }, os.tmpdir());
  assert.ok(!JSON.stringify(entries).includes('secret.example'));
  assert.ok(!JSON.stringify(entries).includes('deadbeef'));
  assert.equal(entries.find(entry => entry.name === 'RPC_URL').present, true);
  assert.equal(entries.find(entry => entry.name === 'OPS_PRIVATE_KEY').present, false);
});

test('config edits are limited to the fields the console owns', () => {
  const dir = scratch();
  assert.throws(() => updateConfigField(dir, 'dickbutt', '0x' + '11'.repeat(20)), /not editable/);
  assert.throws(() => updateConfigField(dir, 'clankerLocker', '0x' + '11'.repeat(20)), /not editable/);
  assert.throws(() => updateConfigField(dir, 'deployment.owner', 'not-an-address'), /20-byte hex address/);
  assert.throws(() => updateConfigField(dir, 'rewardsPool.tokenId', '42'), /vAMM uses ERC-20 LP/);
  assert.throws(() => updateConfigField(dir, 'rewardsPool.lpOwner', 'bad-wallet'), /20-byte hex address/);
});

test('a config edit changes only its own field and leaves the evidence intact', () => {
  const dir = scratch();
  const before = readJson(dir, 'config/base-mainnet.json');
  const owner = `0x${'ab'.repeat(20)}`;
  updateConfigField(dir, 'deployment.owner', owner);
  const after = readJson(dir, 'config/base-mainnet.json');
  assert.equal(after.deployment.owner, owner);
  assert.deepEqual(after.deployment.recipientVerification, before.deployment.recipientVerification);
  assert.deepEqual(after.aerodrome, before.aerodrome);
  assert.equal(after.deployment.keeper, before.deployment.keeper);
});

test('clearing a field writes null rather than an empty string', () => {
  const dir = scratch();
  updateConfigField(dir, 'deployment.guardian', '   ');
  assert.equal(readJson(dir, 'config/base-mainnet.json').deployment.guardian, null);
});

test('only indexed documents can be read', () => {
  assert.throws(() => readDoc(REPO, '../../etc/hosts'), /not an indexed document/);
  assert.throws(() => readDoc(REPO, 'package.json'), /not an indexed document/);
  assert.match(readDoc(REPO, 'docs/RUNBOOK.md'), /^# /);
});

test('overrides round-trip through the gitignored file', () => {
  const dir = scratch();
  saveOverrides(dir, { 'custody.locker': { state: 'done', note: null, updatedAt: '2026-01-01T00:00:00.000Z' } });
  assert.equal(readJson(dir, 'ui/checklist.local.json')['custody.locker'].state, 'done');
});

test('the console reports the same schedule the units are rendered from', () => {
  const { schedule } = loadState(REPO);
  assert.deepEqual(schedule.errors, []);
  const monitor = schedule.hosts.find(host => host.host === 'monitor');
  assert.deepEqual(monitor.keys, [], 'the watchdog must hold no key');
  const keys = schedule.hosts.flatMap(host => host.keys);
  assert.equal(new Set(keys).size, keys.length, 'a key appears on two hosts');
});
