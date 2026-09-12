/**
 * Everything the console knows about the repository, read fresh on each request.
 *
 * Deliberately has no cache: the whole point is that the picture and the checklist agree with the
 * files the CLIs read, and a stale in-memory copy is precisely how they would stop agreeing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NODES, EDGES, VIEWBOX, LANES, route, boxes } from './flow.js';
import { buildReadiness } from './readiness.js';
import { JOBS, hostPlan, validateSchedule, CONTRACT_LIMITS } from '../operations/schedule.js';

const get = (object, keyPath) => keyPath.split('.').reduce((value, key) => (value == null ? value : value[key]), object);

export const OVERRIDES_FILE = 'ui/checklist.local.json';

export function readJson(root, relative) {
  try { return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')); }
  catch { return null; }
}

/** Which environment variables exist. Values never leave the server. */
export function envPresence(env = process.env, root = '.') {
  const names = ['RPC_URL', 'BASE_RPC_URL', 'KEEPER_PRIVATE_KEY', 'OPS_PRIVATE_KEY',
    'PROPOSER_PRIVATE_KEY', 'OWNER_PRIVATE_KEY', 'DEPLOYER_PRIVATE_KEY', 'CALCULATOR_DATA_DIR'];
  // dotenv is what the CLIs themselves load, so report the same surface they will see.
  let dotenv = {};
  try {
    for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/);
      if (match) dotenv[match[1]] = true;
    }
  } catch { dotenv = {}; }
  return names.map(name => ({
    name,
    present: Boolean(env[name]) || Boolean(dotenv[name]),
    from: env[name] ? 'process' : dotenv[name] ? '.env' : null,
    secret: name.includes('PRIVATE_KEY'),
  }));
}

export function gitStatus(root) {
  const run = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    return {
      branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
      head: run(['rev-parse', '--short', 'HEAD']),
      subject: run(['log', '-1', '--pretty=%s']),
      dirty: run(['status', '--porcelain']).split('\n').filter(Boolean).length,
    };
  } catch { return null; }
}

const DOC_ROOTS = ['README.md', 'START-HERE.md', 'AERODROME-SETUP.md', 'AUDITOR-BRIEF.md', 'calculator/README.md'];

export function docIndex(root) {
  const files = [...DOC_ROOTS];
  try { for (const name of fs.readdirSync(path.join(root, 'docs'))) if (name.endsWith('.md')) files.push(`docs/${name}`); }
  catch { /* docs/ is optional */ }
  return files.filter(file => fs.existsSync(path.join(root, file))).map(file => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    return {
      path: file,
      title: text.match(/^#\s+(.+)$/m)?.[1] ?? file,
      words: text.split(/\s+/).length,
    };
  });
}

/** Only markdown, only inside the repo, only files the index already offers. */
export function readDoc(root, relative) {
  if (!docIndex(root).some(doc => doc.path === relative)) throw Error(`not an indexed document: ${relative}`);
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

/**
 * Resolve every flow node against the selected network.
 *
 * Two vocabularies, because two different things are being described. Contracts and Splits are what
 * this repository deploys: on Base mainnet they simply do not exist, and saying so plainly is more
 * useful than colouring them red. Sources and recipients are pre-existing addresses: a null one
 * there is a genuine blocker.
 *
 * `tone` is the status-palette slot; every badge also carries an icon and a label, so nothing is
 * distinguished by colour alone.
 */
const TONES = {
  live: ['good', 'live on chain'],
  deployed: ['good', 'deployed'],
  undeployed: ['warning', 'not deployed here'],
  missing: ['critical', 'address not set'],
  standin: ['muted', 'stand-in only'],
  external: ['muted', 'off-chain'],
};

export function resolveFlow(network, { mainnet, sepolia, legacy }) {
  const onManifest = network === 'base-sepolia';
  const files = { mainnet, sepolia, legacy };
  const nodes = NODES.map(node => {
    const ours = node.kind === 'contract' || node.kind === 'split';
    let keyPath = onManifest ? node.manifest : node.address;
    // A few mainnet facts live in their own evidence file rather than the deployment config.
    let source = onManifest ? sepolia : mainnet;
    if (!onManifest && keyPath?.includes(':')) {
      const [file, rest] = keyPath.split(':');
      source = files[file];
      keyPath = rest;
    }
    let value = source && keyPath ? get(source, keyPath) : null;
    if (Array.isArray(value)) value = value.length ? value[0] : null;

    let status;
    if (!node.address && !node.manifest) status = 'external';
    else if (value) status = onManifest ? 'deployed' : 'live';
    else if (onManifest) status = ours ? 'missing' : 'standin';
    else status = ours ? 'undeployed' : 'missing';

    const [tone, statusLabel] = TONES[status];
    return { ...node, address: value ? String(value) : null, status, tone, statusLabel };
  });
  // Attach geometry here rather than in NODES: the client draws boxes, it does not compute them.
  const placed = boxes(nodes);
  return {
    network, nodes: nodes.map(node => placed.get(node.id)),
    edges: route(nodes, EDGES), viewBox: VIEWBOX, lanes: LANES,
  };
}

function countRehearsals(root) {
  try { return fs.readdirSync(path.join(root, '.context')).filter(name => name.startsWith('rehearsal-run-')).length; }
  catch { return 0; }
}

export function loadState(root, { env = process.env } = {}) {
  const mainnet = readJson(root, 'config/base-mainnet.json');
  const sepolia = readJson(root, 'config/deployment-sepolia.json');
  const legacy = readJson(root, 'config/legacy-fees.json');
  const splits = readJson(root, 'config/splits.json');
  const overrides = readJson(root, OVERRIDES_FILE) ?? {};
  const readiness = buildReadiness({ mainnet, sepolia, overrides, rehearsalRuns: countRehearsals(root) });
  return {
    generatedAt: new Date().toISOString(),
    git: gitStatus(root),
    env: envPresence(env, root),
    networks: [
      { id: 'base-mainnet', label: 'Base mainnet', chainId: 8453, role: 'target',
        writable: false, note: 'The operating CLIs refuse to send transactions here. Reads only.' },
      { id: 'base-sepolia', label: 'Base Sepolia', chainId: 84532, role: 'rehearsal',
        writable: true, note: sepolia ? `Live deployment recorded at block ${sepolia.deployedAtBlock}.` : 'No deployment manifest yet.' },
    ],
    config: { mainnet, sepolia, legacy, splits },
    readiness,
    docs: docIndex(root),
    rehearsalRuns: countRehearsals(root),
    // Rendered from the same definition the schedulers are generated from, so the console cannot
    // show an isolation story the installed units disagree with.
    schedule: { jobs: JOBS, hosts: hostPlan(), errors: validateSchedule(), limits: CONTRACT_LIMITS },
  };
}

/** Write the manual checklist overrides atomically; a torn write would lose the whole list. */
export function saveOverrides(root, overrides) {
  const target = path.join(root, OVERRIDES_FILE);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(overrides, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return overrides;
}

const ADDRESS_FIELDS = new Set([
  'deployment.owner', 'deployment.proposer', 'deployment.guardian', 'deployment.keeper',
  'deployment.kcGreen', 'deployment.cdbVault', 'deployment.burnAddress',
  'rewardsPool.pool',
]);

/**
 * Edit the narrow set of mainnet config fields the console is allowed to touch.
 *
 * Everything else in that file is evidence — verified balances, recorded block numbers, the rejected
 * swap route — and a dashboard has no business rewriting evidence. Checksums are not recomputed: an
 * address is stored exactly as supplied so `validateDeployment` still gets to reject a bad one.
 */
export function updateConfigField(root, field, value) {
  if (!ADDRESS_FIELDS.has(field) && field !== 'rewardsPool.tokenId') throw Error(`field is not editable here: ${field}`);
  const relative = 'config/base-mainnet.json';
  const config = readJson(root, relative);
  if (!config) throw Error('config/base-mainnet.json is missing');
  const trimmed = typeof value === 'string' ? value.trim() : value;
  const next = trimmed === '' || trimmed == null ? null : String(trimmed);
  if (next && ADDRESS_FIELDS.has(field) && !/^0x[0-9a-fA-F]{40}$/.test(next)) throw Error('expected a 20-byte hex address');
  if (next && field === 'rewardsPool.tokenId' && !/^[0-9]+$/.test(next)) throw Error('expected a numeric token id');

  const [section, key] = field.split('.');
  config[section] = { ...config[section], [key]: next };
  const target = path.join(root, relative);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(temporary, target);
  return config;
}

export const EDITABLE_FIELDS = [...ADDRESS_FIELDS, 'rewardsPool.tokenId'];
