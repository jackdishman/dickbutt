/**
 * The operating schedule, as data.
 *
 * Four bot roles run on separate hosts and must never share a key. Writing that down once and
 * rendering every scheduler from it is the only way systemd, cron and a compose file stay in
 * agreement about which key runs where — a drift that would quietly undo the key isolation the
 * contracts and CLIs go to some trouble to enforce.
 *
 * Cadences are constrained by the contracts, not by taste. `validateSchedule` checks them.
 */

/** Contract-side limits the schedule has to respect. Mirrors the selected deployment settings. */
export const CONTRACT_LIMITS = {
  floorLifetimeSeconds: 24 * 3600, // SpcxcSwapExecutor.MAX_FLOOR_LIFETIME
  roundDelaySeconds: 0, // Explicit setRoundDelay(0) during deployment; constructor defaults to 24h.
  minRoundIntervalSeconds: 6 * 3600, // DickbuttRewardsDistributor.minRoundInterval
};

/**
 * `host` is a grouping, not a hostname: two jobs sharing a host share a blast radius. `key` is the
 * environment variable the job needs, and null means the job runs without any signing key at all.
 */
export const JOBS = [
  {
    name: 'fee-cycle',
    host: 'keeper',
    key: 'KEEPER_PRIVATE_KEY',
    everySeconds: 6 * 3600,
    description: 'Harvest all three fee sources, route through Splits, swap the WETH allocation.',
    command: ['npm', 'run', 'fees', '--', '--config', '${MANIFEST}', '--execute'],
    attention: 'exit 2 means the price floor needs refreshing before the swap can run',
  },
  {
    name: 'floor-refresh',
    host: 'ops',
    key: 'OPS_PRIVATE_KEY',
    everySeconds: 3600,
    description: 'Refresh the swap price floor well before it expires.',
    command: ['npm', 'run', 'floor', '--', '--config', '${MANIFEST}', '--execute'],
    attention: 'exit 2 means the floor is inside the warning window or already expired',
  },
  {
    name: 'calculate-and-propose',
    host: 'proposer',
    key: 'PROPOSER_PRIVATE_KEY',
    everySeconds: 6 * 3600,
    description: 'Build a plan from finalized state, then commit its root.',
    // Paths are positional arguments, never interpolated into shell source. Bind the calculator
    // writer to the same explicit journal every reader uses, overriding stale host environment.
    command: ['sh', '-c',
      'CALCULATOR_DATA_DIR="$1" node calculate-rewards.js --config "$2" && npm run keeper -- --config "$2" --journal "$1" --execute --propose-only',
      'dickbutt-calculate-and-propose', '${JOURNAL}', '${CALCULATOR_CONFIG}'],
    attention: 'exit 2 means the round was rate limited; exit 1 means the plan was rejected',
  },
  {
    name: 'propose-pending',
    host: 'proposer',
    key: 'PROPOSER_PRIVATE_KEY',
    everySeconds: 60,
    description: 'Retry an already calculated plan when the six-hour on-chain interval has elapsed; do not calculate a new period.',
    command: ['npm', 'run', 'keeper', '--', '--config', '${CALCULATOR_CONFIG}', '--journal', '${JOURNAL}', '--execute', '--propose-only'],
    attention: 'exit 2 means the existing plan is still rate limited; retry on the next minute',
  },
  {
    name: 'payout',
    host: 'keeper',
    key: 'KEEPER_PRIVATE_KEY',
    everySeconds: 60,
    description: 'Check for ready rounds, pay outstanding batches, and close completed rounds. New rounds are proposed every six hours.',
    command: ['npm', 'run', 'keeper', '--', '--config', '${CALCULATOR_CONFIG}', '--journal', '${JOURNAL}', '--execute'],
    attention: 'exit 2 means recipients remain unpaid and a rerun is expected',
  },
  {
    name: 'monitor',
    host: 'monitor',
    key: null,
    everySeconds: 300,
    description: 'Keyless health check: floor expiry, gas balances, unexpected on-chain commitments.',
    command: ['npm', 'run', 'monitor', '--', '--config', '${MANIFEST}', '--calculator', '${CALCULATOR_CONFIG}', '--journal', '${JOURNAL}'],
    attention: 'exit 2 means something needs a human; exit 1 means the check itself failed',
  },
];

export function validateSchedule(jobs = JOBS, limits = CONTRACT_LIMITS) {
  const errors = [];
  const byHost = new Map();
  for (const job of jobs) {
    if (!job.name || !job.host) { errors.push('every job needs a name and a host'); continue; }
    if (!Number.isSafeInteger(job.everySeconds) || job.everySeconds < 60) {
      errors.push(`${job.name}: everySeconds must be an integer of at least 60`);
    }
    if (!Array.isArray(job.command) || !job.command.length) errors.push(`${job.name}: missing command`);
    byHost.set(job.host, [...(byHost.get(job.host) ?? []), job]);
  }

  // A key must not appear on two hosts: that is the same compromise surface wearing two names.
  const hostsByKey = new Map();
  for (const job of jobs) {
    for (const key of [job.key, ...(job.alsoNeeds ?? [])].filter(Boolean)) {
      hostsByKey.set(key, new Set([...(hostsByKey.get(key) ?? []), job.host]));
    }
  }
  for (const [key, hosts] of hostsByKey) {
    if (hosts.size > 1) errors.push(`${key} is used on more than one host (${[...hosts].sort().join(', ')})`);
  }

  // The ops key signs setPriceFloor and must never be able to move funds.
  const opsHosts = jobs.filter(j => j.key === 'OPS_PRIVATE_KEY').map(j => j.host);
  for (const job of jobs) {
    if (job.key === 'KEEPER_PRIVATE_KEY' && opsHosts.includes(job.host)) {
      errors.push(`${job.name}: the keeper key must not run on the ops host`);
    }
  }

  const monitor = jobs.find(j => j.name === 'monitor');
  if (!monitor) errors.push('a keyless monitor job is required: a crashed bot cannot alert on itself');
  else {
    if (monitor.key) errors.push('the monitor must not hold a signing key');
    if (jobs.some(j => j !== monitor && j.host === monitor.host)) {
      errors.push('the monitor must run on its own host, or it dies with the thing it watches');
    }
  }

  const floor = jobs.find(j => j.name === 'floor-refresh');
  if (floor && floor.everySeconds >= limits.floorLifetimeSeconds) {
    errors.push(`floor-refresh runs every ${floor.everySeconds}s but the floor expires within ${limits.floorLifetimeSeconds}s`);
  }
  const propose = jobs.find(j => j.name === 'calculate-and-propose');
  if (propose && propose.everySeconds < limits.minRoundIntervalSeconds) {
    errors.push(`calculate-and-propose runs faster than the contract's ${limits.minRoundIntervalSeconds}s round interval, so most runs will be rejected`);
  }
  const payout = jobs.find(j => j.name === 'payout');
  const retry = jobs.find(j => j.name === 'propose-pending');
  if (propose && (!retry || retry.everySeconds > 60 || retry.host !== propose.host || retry.key !== propose.key)) {
    errors.push('propose-pending must retry within 60 seconds on the proposer host with its separate key');
  }
  const payoutCheckLimit = limits.roundDelaySeconds > 0 ? limits.roundDelaySeconds : 60;
  if (payout && payout.everySeconds > payoutCheckLimit) {
    errors.push('payout checks are too slow for the selected review delay; rounds will sit activated and unpaid');
  }
  return errors;
}

/** Environment each host needs. Used by the renderer and by the docs table. */
export function hostPlan(jobs = JOBS) {
  const hosts = new Map();
  for (const job of jobs) {
    const entry = hosts.get(job.host) ?? { host: job.host, jobs: [], keys: new Set() };
    entry.jobs.push(job.name);
    for (const key of [job.key, ...(job.alsoNeeds ?? [])].filter(Boolean)) entry.keys.add(key);
    hosts.set(job.host, entry);
  }
  return [...hosts.values()]
    .map(e => ({ ...e, keys: [...e.keys].sort() }))
    .sort((a, b) => a.host.localeCompare(b.host));
}
