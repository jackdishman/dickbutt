/**
 * The operations this console is allowed to run.
 *
 * A registry, not a shell. Every command is a fixed argv with typed, validated slots; nothing the
 * browser sends is ever concatenated into a command line, and the server spawns without a shell.
 * A dashboard that can spend money should be boring about how it decides what to execute.
 *
 * `kind` is the blast radius, and it is the only thing the server's execute gate consults:
 *   read   — no signing key is loaded and no transaction is sent
 *   local  — writes, but only to a disposable local fork it starts and stops itself
 *   write  — signs and broadcasts. Requires the server to be started with --allow-execute.
 */

const PATH_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/** Repo-relative paths only: no absolute paths, no traversal, no option-lookalikes. */
export function validatePath(value, label) {
  if (typeof value !== 'string' || !value.length) throw Error(`${label} is required`);
  if (value.length > 200) throw Error(`${label} is too long`);
  if (!PATH_PATTERN.test(value)) throw Error(`${label} must be a repository-relative path`);
  if (value.split('/').includes('..')) throw Error(`${label} must not traverse outside the repository`);
  return value;
}

const manifest = { name: 'config', label: 'Deployment manifest', type: 'path', default: 'config/deployment-sepolia.json' };
const calculator = { name: 'calculator', label: 'Calculator config', type: 'path', default: '.context/calculator-config.json' };
const journal = { name: 'journal', label: 'Journal directory', type: 'path', default: '.context/journal' };

export const COMMANDS = [
  // --- verify ----------------------------------------------------------------
  {
    id: 'test', group: 'Verify', kind: 'read', label: 'JavaScript tests',
    summary: 'Calculator, keeper, operations and golden-vector suites.',
    argv: () => ['npm', 'test'],
  },
  {
    id: 'forge-test', group: 'Verify', kind: 'read', label: 'Solidity tests',
    summary: 'Foundry unit tests. Fork suites skip without BASE_RPC_URL.',
    argv: () => ['forge', 'test'],
  },
  {
    id: 'preflight', group: 'Verify', kind: 'read', label: 'Preflight (Base mainnet)',
    summary: 'Read-only finalized Base inspection: recipients, rewards pool, both swap hops, locker owner. --strict exits 1 while any prerequisite is unmet.',
    inputs: [{ name: 'config', label: 'Config', type: 'path', default: 'config/base-mainnet.json' },
      { name: 'strict', label: 'Strict (exit 1 on any error)', type: 'flag', default: true }],
    needs: ['BASE_RPC_URL'],
    argv: o => ['npm', 'run', 'preflight', '--', '--config', o.config, ...(o.strict ? ['--strict'] : [])],
    exits: { 0: 'every configured prerequisite passes', 1: 'prerequisites remain unmet — read errors[]' },
  },
  {
    id: 'inspect-legacy', group: 'Verify', kind: 'read', label: 'Inspect legacy fee module',
    summary: 'Reads the real Clanker fee Safes and legacy module: creator authority, sink addresses, claimable balances.',
    needs: ['BASE_RPC_URL'],
    argv: () => ['npm', 'run', 'inspect:legacy'],
  },
  {
    id: 'schedule', group: 'Verify', kind: 'read', label: 'Render the operating schedule',
    summary: 'Validates the four-host job definition and renders systemd units or a crontab from it.',
    inputs: [{ name: 'format', label: 'Format', type: 'choice', choices: ['plan', 'systemd', 'cron'], default: 'plan' }],
    argv: o => ['npm', 'run', 'schedule', '--', '--format', o.format],
  },

  // --- observe ---------------------------------------------------------------
  {
    id: 'monitor', group: 'Observe', kind: 'read', label: 'Health check (keyless)',
    summary: 'Loads no key and sends nothing. Flags an expired price floor, an unfunded bot, a guardian pause, a stale round, and any on-chain root the calculator journal never produced.',
    inputs: [manifest, { ...journal, required: false }],
    needs: ['RPC_URL'],
    argv: o => ['npm', 'run', 'monitor', '--', '--config', o.config, ...(o.journal ? ['--journal', o.journal] : [])],
    exits: { 0: 'healthy', 2: 'needs a human', 1: 'the check itself failed' },
  },
  {
    id: 'floor-monitor', group: 'Observe', kind: 'read', label: 'Price floor status',
    summary: 'Reports the active floor and time remaining. Never loads a key.',
    inputs: [manifest],
    needs: ['RPC_URL'],
    argv: o => ['npm', 'run', 'floor', '--', '--config', o.config, '--monitor'],
    exits: { 0: 'fresh', 2: 'inside the warning window or already expired' },
  },
  {
    id: 'fees-dry', group: 'Observe', kind: 'read', label: 'Fee cycle (dry run)',
    summary: 'Plans every harvest and split without sending a transaction.',
    inputs: [manifest],
    needs: ['RPC_URL'],
    argv: o => ['npm', 'run', 'fees', '--', '--config', o.config],
  },
  {
    id: 'keeper-dry', group: 'Observe', kind: 'read', label: 'Keeper (dry run)',
    summary: 'Rebuilds the plan from the journal and compares it against on-chain commitments without signing.',
    inputs: [calculator, journal],
    needs: ['RPC_URL'],
    argv: o => ['npm', 'run', 'keeper', '--', '--config', o.calculator, '--journal', o.journal],
  },
  {
    id: 'calculate', group: 'Observe', kind: 'read', label: 'Calculate a reward plan',
    summary: 'Time-weighted balances over finalized state, then a Merkle plan written to the journal. Reads finalized blocks only, so it lags head by the chain finality delay.',
    inputs: [calculator, journal],
    needs: ['RPC_URL'],
    note: 'Writes the journal the keeper later verifies against. It signs nothing.',
    argv: o => ['node', 'calculate-rewards.js', '--config', o.calculator],
    // The calculator takes its data directory from the environment, not a flag.
    envFrom: o => ({ CALCULATOR_DATA_DIR: o.journal }),
  },

  // --- rehearse --------------------------------------------------------------
  {
    id: 'rehearse', group: 'Rehearse', kind: 'local', label: 'Full local rehearsal',
    summary: 'Starts a disposable Anvil fork of Base, deploys the architecture against the genuine Splits factory, and runs the whole cycle: harvest, route, swap, calculate, propose, timelock, blocked recipient, retry, close, reconcile.',
    needs: ['BASE_RPC_URL'],
    note: 'Starts and stops its own node on chain 31337. Nothing signs against mainnet.',
    argv: () => ['npm', 'run', 'rehearse'],
  },

  // --- execute ---------------------------------------------------------------
  {
    id: 'deploy-sepolia', group: 'Execute', kind: 'write', label: 'Deploy to Base Sepolia',
    summary: 'Deploys the architecture to chain 84532 and emits the manifest plus the exact calculator configuration the operating CLIs consume. Base mainnet is rejected outright.',
    inputs: [{ name: 'roles', label: 'Roles file', type: 'path', default: 'config/roles-sepolia.example.json' },
      { name: 'out', label: 'Manifest output', type: 'path', default: 'config/deployment-sepolia.json' },
      { name: 'force', label: 'Overwrite an existing manifest', type: 'flag', default: false }],
    needs: ['RPC_URL', 'DEPLOYER_PRIVATE_KEY'],
    danger: 'Deploys 14 contracts. Overwriting an existing manifest orphans the previous deployment and anything it holds — read the old one first.',
    argv: o => ['npm', 'run', 'deploy:sepolia', '--', '--roles', o.roles, '--out', o.out, ...(o.force ? ['--force'] : [])],
  },
  {
    id: 'floor-execute', group: 'Execute', kind: 'write', label: 'Refresh the price floor',
    summary: 'Quotes the route and writes a fresh floor. Refuses a signer that is an approved keeper, in dry run as well as execution.',
    inputs: [manifest],
    needs: ['RPC_URL', 'OPS_PRIVATE_KEY'],
    danger: 'Signs with the ops key. This key must never be the keeper key or run on the keeper host.',
    argv: o => ['npm', 'run', 'floor', '--', '--config', o.config, '--execute'],
  },
  {
    id: 'fees-execute', group: 'Execute', kind: 'write', label: 'Run a fee cycle',
    summary: 'Harvests all three sources, routes through Splits and swaps the WETH allocation.',
    inputs: [manifest],
    needs: ['RPC_URL', 'KEEPER_PRIVATE_KEY'],
    danger: 'Signs with the keeper key and broadcasts. Keep fee cycles and keeper runs sequential for one signer.',
    argv: o => ['npm', 'run', 'fees', '--', '--config', o.config, '--execute'],
    exits: { 2: 'the price floor needs refreshing before the swap can run' },
  },
  {
    id: 'keeper-propose', group: 'Execute', kind: 'write', label: 'Propose a round',
    summary: 'Commits the journal root and stops before activation or payment. Refuses to start on a host where KEEPER_PRIVATE_KEY exists.',
    inputs: [calculator, journal],
    needs: ['RPC_URL', 'PROPOSER_PRIVATE_KEY'],
    danger: 'Starts the timelock on a real round. Bounded on-chain by the share cap, the round interval and the guardian pause.',
    argv: o => ['npm', 'run', 'keeper', '--', '--config', o.calculator, '--journal', o.journal, '--execute', '--propose-only'],
    exits: { 2: 'rate limited by the contract', 1: 'the plan was rejected' },
  },
  {
    id: 'keeper-execute', group: 'Execute', kind: 'write', label: 'Activate, pay and close',
    summary: 'Activates rounds past their timelock, pays outstanding batches and closes completed rounds. Verifies every on-chain commitment against the local journal first.',
    inputs: [calculator, journal],
    needs: ['RPC_URL', 'KEEPER_PRIVATE_KEY'],
    danger: 'Moves tokens to holders. Re-runnable: paid recipients are not paid twice.',
    argv: o => ['npm', 'run', 'keeper', '--', '--config', o.calculator, '--journal', o.journal, '--execute'],
    exits: { 2: 'recipients remain unpaid and a rerun is expected' },
  },
];

export const COMMAND_GROUPS = [...new Set(COMMANDS.map(c => c.group))];

/** What the browser is allowed to know: never a value, only whether a variable is set. */
export function describeCommands({ allowWrite = false, env = {} } = {}) {
  return COMMANDS.map(command => ({
    id: command.id, group: command.group, kind: command.kind, label: command.label,
    summary: command.summary, note: command.note ?? null, danger: command.danger ?? null,
    inputs: command.inputs ?? [], exits: command.exits ?? null,
    needs: (command.needs ?? []).map(name => ({ name, present: Boolean(env[name]) })),
    runnable: command.kind !== 'write' || allowWrite,
    blockedReason: command.kind === 'write' && !allowWrite
      ? 'The console was started read-only. Restart it with --allow-execute to sign transactions.'
      : null,
  }));
}

/** Turn a request into an argv. Throws rather than guessing; the caller surfaces the message. */
export function resolveCommand(id, { inputs = {}, allowWrite = false, confirm = null } = {}) {
  const command = COMMANDS.find(c => c.id === id);
  if (!command) throw Error(`unknown command: ${id}`);
  if (command.kind === 'write') {
    if (!allowWrite) throw Error('this console was started read-only; restart it with --allow-execute');
    // Deliberate friction: the exact id has to come back from the browser with the request.
    if (confirm !== id) throw Error(`confirmation required: send confirm="${id}"`);
  }
  const resolved = {};
  for (const input of command.inputs ?? []) {
    const raw = inputs[input.name];
    if (input.type === 'flag') { resolved[input.name] = raw === true || raw === 'true'; continue; }
    if (input.type === 'choice') {
      const value = raw ?? input.default;
      if (!input.choices.includes(value)) throw Error(`${input.label} must be one of ${input.choices.join(', ')}`);
      resolved[input.name] = value;
      continue;
    }
    const value = (raw ?? input.default ?? '').trim();
    if (!value) {
      if (input.required === false) { resolved[input.name] = ''; continue; }
      throw Error(`${input.label} is required`);
    }
    resolved[input.name] = validatePath(value, input.label);
  }
  return { command, argv: command.argv(resolved), env: command.envFrom?.(resolved) ?? {}, inputs: resolved };
}
