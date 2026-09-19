#!/usr/bin/env node
// Render the operating schedule to systemd units, crontab or a checklist. One definition in
// operations/schedule.js, several renderings, so the schedulers cannot disagree about which key
// runs on which host.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOBS, validateSchedule, hostPlan, CONTRACT_LIMITS } from '../operations/schedule.js';

const USAGE = `Usage: npm run schedule -- [--format systemd|cron|plan] [--host keeper|ops|proposer|monitor]
                       [--workdir /srv/dickbutt] [--manifest deployment.json]
                       [--calculator calculator-config.json] [--journal ./data]

Prints to stdout; nothing is installed. The schedule is validated first and refuses to render
if a key would end up on two hosts or a cadence contradicts a contract limit.`;

export function parseScheduleArgs(args) {
  const o = { format: 'plan', workdir: '/srv/dickbutt', manifest: 'deployment.json',
    calculator: 'calculator-config.json', journal: './data' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') { o.help = true; continue; }
    const map = { '--format': 'format', '--host': 'host', '--workdir': 'workdir',
      '--manifest': 'manifest', '--calculator': 'calculator', '--journal': 'journal' };
    if (!map[arg]) throw Error(`unknown schedule option: ${arg.startsWith('--') ? arg : 'positional argument'}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw Error(`missing value for ${arg}`);
    o[map[arg]] = value;
  }
  if (o.help) return o;
  if (!['systemd', 'cron', 'plan'].includes(o.format)) throw Error('--format must be systemd, cron or plan');
  if (o.host && !JOBS.some(j => j.host === o.host)) throw Error(`unknown host: ${o.host}`);
  validateRenderOptions(o);
  return o;
}

function validateRenderOptions(o) {
  for (const key of ['workdir','manifest','calculator','journal']) {
    if (typeof o[key] !== 'string' || !o[key].length || /[\0\r\n]/.test(o[key])) {
      throw Error(`scheduler ${key} must be a nonempty path without control characters`);
    }
  }
}

const substitute = (command, o) => command.map(part => part
  .replaceAll('${MANIFEST}', o.manifest)
  .replaceAll('${CALCULATOR_CONFIG}', o.calculator)
  .replaceAll('${JOURNAL}', o.journal));

const shellQuote = part => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`);

// systemd parses its own argument syntax, then expands $ and % even inside quotes. Preserve
// literal paths and the shell's positional arguments instead of letting systemd consume them.
const systemdValue = part => {
  if (/[\0\r\n]/.test(part)) throw Error('scheduler arguments must not contain control characters');
  const escaped = part.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  return /^[\w@+=:,./-]+$/.test(escaped) ? escaped : `"${escaped}"`;
};
const systemdQuote = part => systemdValue(part.replaceAll('$', () => '$$'));

export function renderSystemd(jobs, o) {
  validateRenderOptions(o);
  return jobs.map(job => {
    const exec = substitute(job.command, o).map(systemdQuote).join(' ');
    const keys = [job.key, ...(job.alsoNeeds ?? [])].filter(Boolean);
    return `# ---- ${job.name} (host: ${job.host}) ----
# ${job.description}
# ${job.attention}
# /etc/systemd/system/dickbutt-${job.name}.service
[Unit]
Description=dickbutt ${job.name}
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${systemdValue(o.workdir)}
# RPC_URL plus ${keys.length ? keys.join(', ') : 'no signing key'}
EnvironmentFile=${systemdValue(`${o.workdir}/env/${job.host}.env`)}
ExecStart=${exec}
# Exit 2 is "needs a human", not a crash loop. Alert on it; do not restart into it.
SuccessExitStatus=0 2
User=dickbutt-${job.host}

# /etc/systemd/system/dickbutt-${job.name}.timer
[Unit]
Description=dickbutt ${job.name} timer

[Timer]
OnBootSec=2min
OnUnitActiveSec=${job.everySeconds}s
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target`;
  }).join('\n\n');
}

export function renderCron(jobs, o) {
  validateRenderOptions(o);
  // Vixie/Cronie consume backslashes before passing command text to the shell. In particular,
  // a filename's literal backslash before an escaped percent can unescape that percent and
  // truncate the command. Keep cron paths unambiguous instead of silently changing a filename.
  for (const key of ['workdir','manifest','calculator','journal']) {
    if (o[key].includes('\\')) throw Error(`cron ${key} must not contain backslashes; choose a Unix path without them`);
  }
  const spec = seconds => {
    if (seconds < 3600) return `*/${Math.max(1, Math.round(seconds / 60))} * * * *`;
    if (seconds < 86400) return `0 */${Math.round(seconds / 3600)} * * *`;
    return '0 3 * * *';
  };
  const lines = jobs.map(job => {
    const parts = substitute(job.command, o);
    if ([o.workdir, ...parts].some(part => /[\0\r\n]/.test(part))) throw Error('scheduler arguments must not contain control characters');
    // Cron handles percent signs before the shell, including inside quoted arguments.
    const exec = parts.map(shellQuote).join(' ').replaceAll('%', '\\%');
    const keys = [job.key, ...(job.alsoNeeds ?? [])].filter(Boolean);
    return `# ${job.name} (host: ${job.host}) -- ${job.description}
# needs: RPC_URL${keys.length ? ', ' + keys.join(', ') : ' only; no signing key'}
# ${job.attention}
${spec(job.everySeconds)} cd ${shellQuote(o.workdir).replaceAll('%', '\\%')} && ${exec} >> /var/log/dickbutt/${job.name}.log 2>&1`;
  });
  return ['# Load secrets from the host environment, never from this file.', ...lines].join('\n\n');
}

export function renderPlan(jobs) {
  const rows = hostPlan(jobs).map(h =>
    `  ${h.host.padEnd(9)} jobs: ${h.jobs.join(', ').padEnd(34)} keys: ${h.keys.length ? h.keys.join(', ') : 'none'}`);
  const cadence = jobs.map(j => {
    const every = j.everySeconds >= 3600 ? `${j.everySeconds / 3600}h` : `${j.everySeconds / 60}m`;
    return `  ${j.name.padEnd(22)} every ${every.padEnd(5)} on ${j.host.padEnd(9)} ${j.attention}`;
  });
  return ['Hosts (a shared host is a shared blast radius):', ...rows, '',
    'Cadence:', ...cadence, '',
    'Contract limits this schedule respects:',
    `  price floor expires within ${CONTRACT_LIMITS.floorLifetimeSeconds / 3600}h`,
    `  round timelock ${CONTRACT_LIMITS.roundDelaySeconds / 3600}h`,
    `  minimum ${CONTRACT_LIMITS.minRoundIntervalSeconds / 3600}h between proposals`].join('\n');
}

export function main(args = process.argv.slice(2)) {
  const o = parseScheduleArgs(args);
  if (o.help) { console.log(USAGE); return; }
  const errors = validateSchedule();
  if (errors.length) throw Error(`schedule rejected:\n  - ${errors.join('\n  - ')}`);
  const jobs = o.host ? JOBS.filter(j => j.host === o.host) : JOBS;
  const out = o.format === 'systemd' ? renderSystemd(jobs, o)
    : o.format === 'cron' ? renderCron(jobs, o) : renderPlan(jobs);
  console.log(out);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
