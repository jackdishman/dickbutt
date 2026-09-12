/**
 * Console front end. No build step and no framework: the whole thing is a fetch, a render function
 * per tab, and an EventSource for the command output.
 *
 * Everything is built with DOM calls rather than innerHTML. Half of what this page displays is
 * repository text and command output, and neither should ever be able to become markup here.
 */
import { renderDiagram, renderLegend, shortAddress, STATUS_GLYPH } from './diagram.js';
import { renderMarkdown } from './markdown.js';

/**
 * The hash is `#tab` or `#tab/selection`, so a specific node or command can be linked to in a
 * review comment rather than described.
 */
const readHash = () => {
  const [tab, selection] = location.hash.slice(1).split('/');
  return { tab: tab || 'flow', selection: selection || null };
};

const app = {
  token: null, allowExecute: false, data: null,
  network: localStorage.getItem('network') ?? 'base-mainnet',
  tab: readHash().tab,
  node: readHash().tab === 'flow' ? readHash().selection : null,
  command: readHash().tab === 'operate' ? readHash().selection : null,
  run: null, doc: null, docText: null, source: null, suppressHash: false,
};

/* ------------------------------------------------------------------ helpers */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    // cssText goes through the CSSOM; setAttribute('style', ...) is blocked by the page's CSP.
    else if (key === 'style') node.style.cssText = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter(child => child != null));
  return node;
}

const TONE_FOR_STATE = { done: 'good', pending: 'muted', blocked: 'critical', 'n/a': 'muted' };
const GLYPH_FOR_STATE = { done: '●', pending: '◔', blocked: '▲', 'n/a': '○' };

const badge = (tone, glyph, label) =>
  h('span', { class: `badge tone-${tone}` }, h('span', { class: 'dot', text: glyph }), label);

const stateBadge = state => badge(TONE_FOR_STATE[state], GLYPH_FOR_STATE[state], state);

function toast(message, bad = false) {
  document.querySelector('.toast')?.remove();
  const node = h('div', { class: `toast${bad ? ' bad' : ''}`, text: message });
  document.body.append(node);
  setTimeout(() => node.remove(), bad ? 6000 : 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'x-console-token': app.token, ...(options.body ? { 'content-type': 'application/json' } : {}) },
  });
  const body = await response.json();
  if (!response.ok) throw Error(body.error ?? `request failed (${response.status})`);
  return body;
}

const relative = iso => {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
};

/* -------------------------------------------------------------------- shell */
const TABS = [
  { id: 'flow', label: 'Flow' },
  { id: 'checklist', label: 'Checklist' },
  { id: 'configure', label: 'Configure' },
  { id: 'operate', label: 'Operate' },
  { id: 'docs', label: 'Docs' },
];

function renderShell() {
  const { data } = app;
  document.getElementById('gitline').textContent = data.git
    ? `${data.git.branch} · ${data.git.head}${data.git.dirty ? ` · ${data.git.dirty} uncommitted` : ''}`
    : 'not a git repository';

  const mode = document.getElementById('mode');
  mode.className = `mode${app.allowExecute ? ' execute' : ''}`;
  mode.replaceChildren(h('span', { text: app.allowExecute ? '▲' : '○' }),
    h('span', { text: app.allowExecute ? 'execute enabled' : 'read-only' }));
  mode.title = app.allowExecute
    ? 'Started with --allow-execute: transaction-signing commands are available.'
    : 'Started read-only. Restart with --allow-execute to enable transaction-signing commands.';

  const networks = document.getElementById('network');
  networks.replaceChildren(...data.networks.map(net => h('button', {
    type: 'button', 'aria-pressed': String(net.id === app.network), title: net.note,
    onclick: () => { app.network = net.id; localStorage.setItem('network', net.id); refresh(); },
  }, net.label)));

  const counts = { checklist: data.readiness.summary.blocked || null };
  document.getElementById('tabs').replaceChildren(...TABS.map(tab => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(tab.id === app.tab),
    onclick: () => { app.tab = tab.id; setHash(); render(); },
  }, tab.label, counts[tab.id] ? h('span', { class: 'count', text: `${counts[tab.id]} blocked` }) : null)));

  for (const tab of TABS) document.getElementById(`tab-${tab.id}`).hidden = tab.id !== app.tab;
}

/* --------------------------------------------------------------------- flow */
function renderFlow() {
  const { data } = app;
  const flow = data.flow;
  const summary = data.readiness.summary;
  const ours = flow.nodes.filter(node => node.kind === 'contract' || node.kind === 'split');
  const onChain = ours.filter(node => node.status === 'deployed').length;
  const network = data.networks.find(net => net.id === app.network);

  const tiles = h('div', { class: 'tiles' },
    tile('Launch readiness', `${summary.percent}%`, `${summary.done} of ${summary.total} checks done`,
      meter([[summary.done, 'var(--good)'], [summary.pending, 'var(--rule)'], [summary.blocked, 'var(--critical)']])),
    tile('Blocking items', String(summary.blocked), summary.blocked
      ? `waiting on ${[...new Set(summary.blockers.map(b => b.owner))].join(', ')}`
      : 'nothing derived from config is blocked'),
    tile('Contracts on this network', `${onChain}/${ours.length}`, network?.note ?? ''),
    tile('Local rehearsals recorded', String(data.rehearsalRuns), 'disposable Base forks under .context/'),
  );

  const selected = flow.nodes.find(node => node.id === app.node);
  const section = document.getElementById('tab-flow');
  section.replaceChildren(
    tiles,
    h('h2', {}, 'Fee flow'),
    h('p', { class: 'lede' },
      'Resolved from the same configuration the operating CLIs read. Edge colour is the token; every edge is labelled, so the path reads without it. Select a node for its role and open questions.'),
    h('div', { class: 'diagram-wrap' }, renderDiagram(flow, {
      selected: app.node, onSelect: id => { app.node = app.node === id ? null : id; setHash(); render(); },
    })),
    renderLegend(flow),
    selected ? nodeDetail(selected) : h('div', { class: 'detail' },
      h('h3', {}, 'Select a node'),
      h('p', {}, 'Each box reports the address configured for the selected network and whether anything is deployed at it.')),
  );
}

function tile(key, value, note, extra) {
  return h('div', { class: 'tile' }, h('div', { class: 'k', text: key }),
    h('div', { class: 'v', text: value }), note ? h('div', { class: 'n', text: note }) : null, extra ?? null);
}

function meter(parts) {
  const total = parts.reduce((sum, [value]) => sum + value, 0) || 1;
  return h('div', { class: 'meter' }, ...parts.filter(([value]) => value > 0).map(([value, color]) =>
    h('i', { style: `width:${(value / total) * 100}%;background:${color}` })));
}

function nodeDetail(node) {
  const explorer = app.network === 'base-sepolia' ? 'https://sepolia.basescan.org/address/' : 'https://basescan.org/address/';
  return h('div', { class: 'detail' },
    h('h3', {}, node.label, ' ', badge(node.tone, STATUS_GLYPH[node.status], node.statusLabel)),
    node.address
      ? h('p', {}, h('a', { class: 'addr', href: explorer + node.address, target: '_blank', rel: 'noreferrer noopener' }, node.address))
      : h('p', { class: 'addr', text: 'no address configured' }),
    node.contract ? h('p', {}, h('code', { text: node.contract })) : null,
    h('p', { text: node.detail }),
    node.caveat ? h('p', {}, badge('warning', '◔', 'open'),  ` ${node.caveat}`) : null,
    node.doc ? h('p', {}, h('button', {
      class: 'btn', onclick: () => { app.tab = 'docs'; app.doc = node.doc; app.docText = null; location.hash = 'docs'; render(); loadDoc(node.doc); },
    }, `Read ${node.doc}`)) : null,
  );
}

/* ---------------------------------------------------------------- checklist */
function renderChecklist() {
  const { readiness } = app.data;
  const owners = [...new Set(readiness.items.filter(i => i.state !== 'done' && i.state !== 'n/a').map(i => i.owner))];
  const section = document.getElementById('tab-checklist');
  section.replaceChildren(
    h('div', { class: 'tiles' },
      tile('Done', String(readiness.summary.done), 'verified by config or recorded by hand'),
      tile('Pending', String(readiness.summary.pending), 'not started or not yet evidenced'),
      tile('Blocked', String(readiness.summary.blocked), 'a required value is null in config'),
      tile('Waiting on', owners.join(', ') || '—', 'owners of the outstanding work'),
    ),
    h('h2', {}, 'Launch checklist'),
    h('p', { class: 'lede' },
      'Items marked derived are read from the repository and cannot be ticked by hand — a checkbox must never outrank the config it describes. The rest have no local evidence, so they are recorded here and stored outside version control.'),
    ...readiness.groups.map(group => h('div', { class: 'group' },
      h('header', {},
        h('h3', { text: group.group }),
        h('div', { class: 'rest' },
          ...['done', 'pending', 'blocked'].filter(state => group.items.some(i => i.state === state))
            .map(state => badge(TONE_FOR_STATE[state], GLYPH_FOR_STATE[state],
              `${group.items.filter(i => i.state === state).length} ${state}`)))),
      ...group.items.map(checklistItem))),
  );
}

function checklistItem(item) {
  const controls = item.source === 'derived'
    ? h('div', { class: 'controls' }, stateBadge(item.state), h('span', { class: 'derived', text: 'derived' }))
    : h('div', { class: 'controls' },
      h('select', {
        onchange: async event => {
          try {
            const body = await api('/api/checklist', { method: 'POST', body: JSON.stringify({ id: item.id, state: event.target.value, note: item.note }) });
            app.data.readiness = body.readiness;
            render();
            toast(`${item.label}: ${event.target.value}`);
          } catch (error) { toast(error.message, true); }
        },
      }, ...['pending', 'done', 'blocked', 'n/a'].map(state =>
        h('option', { value: state, selected: state === item.state }, state))));

  return h('div', { class: 'item' },
    h('div', {}, h('div', { class: 'who', text: item.owner }), item.updatedAt ? h('div', { class: 'who', text: relative(item.updatedAt) }) : null),
    h('div', {},
      h('div', { class: 'label', text: item.label }),
      h('div', { class: 'detail-text', text: item.detail }),
      item.note ? h('div', { class: 'note', text: item.note }) : null,
      item.doc ? h('div', {}, h('button', {
        class: 'btn', style: 'margin-top:8px',
        onclick: () => { app.tab = 'docs'; app.doc = item.doc; app.docText = null; setHash(); render(); loadDoc(item.doc); },
      }, item.doc)) : null),
    controls);
}

/* ---------------------------------------------------------------- configure */
const FIELD_LABELS = {
  'deployment.owner': ['Owner multisig', 'Distributor + harvesters. Commits reward roots.'],
  'deployment.proposer': ['Proposer', 'Bot key for proposeRound. Cannot move tokens.'],
  'deployment.guardian': ['Guardian', 'Leave empty to inherit the owner multisig.'],
  'deployment.keeper': ['Keeper', 'Hot key for processWeth and distributeBatch.'],
  'deployment.kcGreen': ['KC Green', '10% of both fee tokens. Immutable Split recipient.'],
  'deployment.cdbVault': ['CDB treasury', '10% of WETH. Immutable Split recipient.'],
  'deployment.burnAddress': ['Burn address', '90% of DICKBUTT.'],
  'rewardsPool.pool': ['Rewards pool', '0.3% full-range DICKBUTT/SPCXc position.'],
  'rewardsPool.tokenId': ['Position NFT id', 'Unblocks the only real Aerodrome collection test.'],
};

function renderConfigure() {
  const { data } = app;
  const mainnet = data.config.mainnet ?? {};
  const get = path => path.split('.').reduce((value, key) => (value == null ? value : value[key]), mainnet);

  const section = document.getElementById('tab-configure');
  section.replaceChildren(
    h('h2', {}, 'Base mainnet addresses'),
    h('p', { class: 'lede' },
      'Written straight into config/base-mainnet.json, which preflight and the deployment scripts read. Recipients land in immutable Splits with no setter, so a wrong address means redeploying the router and re-pointing every harvester — verify before saving.'),
    h('div', { class: 'fields' }, ...data.editableFields.map(field => {
      const [label, hint] = FIELD_LABELS[field] ?? [field, ''];
      const input = h('input', { type: 'text', value: get(field) ?? '', placeholder: 'not set',
        spellcheck: 'false', autocomplete: 'off' });
      return h('div', { class: 'field' },
        h('div', {}, h('label', { text: label }), h('div', { class: 'hint', text: hint })),
        input,
        h('button', {
          class: 'btn', onclick: async () => {
            try {
              const body = await api('/api/config', { method: 'POST', body: JSON.stringify({ field, value: input.value }) });
              app.data.config = body.config;
              app.data.readiness = body.readiness;
              await refresh();
              toast(`${label} saved`);
            } catch (error) { toast(error.message, true); }
          },
        }, 'Save'));
    })),

    h('h2', {}, 'Round bounds'),
    h('p', { class: 'lede' }, mainnet.roundLimits?.note ?? ''),
    table(['Bound', 'Value'], Object.entries(mainnet.roundLimits ?? {})
      .filter(([key]) => key !== 'note').map(([key, value]) => [key, String(value)])),

    h('h2', {}, 'Operating hosts'),
    h('p', { class: 'lede' },
      'Rendered from operations/schedule.js — the same definition npm run schedule installs from, so this table cannot disagree with the units on the boxes. No key appears on two hosts and the monitor holds none.'),
    table(['Host', 'Jobs', 'Key'], data.schedule.hosts.map(host =>
      [host.host, host.jobs.join(', '), host.keys.join(', ') || 'none (keyless watchdog)'])),
    data.schedule.errors.length
      ? h('p', {}, badge('critical', '▲', `schedule invalid: ${data.schedule.errors.join('; ')}`))
      : h('p', {}, badge('good', '●', 'schedule validates: key isolation and contract cadences hold')),

    h('h2', {}, 'Environment on this machine'),
    h('p', { class: 'lede' },
      'Presence only. The console never reads a private key; the child CLIs load their own from the environment.'),
    table(['Variable', 'Status', 'Source'], data.env.map(entry =>
      [entry.name, entry.present ? badge('good', '●', 'set') : badge('muted', '○', 'not set'), entry.from ?? '—'])),

    h('h2', {}, 'Calculator exclusions'),
    h('p', { class: 'lede' }, mainnet.calculatorExclusions?.note ?? ''),
    table(['Role', 'Address', 'Why'], (mainnet.calculatorExclusions?.required ?? []).map(entry =>
      [entry.role, [entry.address].flat().join(', '), entry.reason])),
  );
}

function table(headers, rows) {
  return h('table', { class: 'plain' },
    h('thead', {}, h('tr', {}, ...headers.map(header => h('th', { text: header })))),
    h('tbody', {}, ...rows.map(cells => h('tr', {}, ...cells.map((cell, index) =>
      h('td', { class: index === 1 && typeof cell === 'string' && cell.startsWith('0x') ? 'mono' : '' },
        typeof cell === 'string' ? cell : cell))))));
}

/* ------------------------------------------------------------------ operate */
function renderOperate() {
  const { data } = app;
  const groups = [...new Set(data.commands.map(command => command.group))];
  const section = document.getElementById('tab-operate');
  section.replaceChildren(
    h('h2', {}, 'Operate'),
    h('p', { class: 'lede' },
      'A fixed registry, not a shell: each command is a validated argv spawned in the repository root. Reads and dry runs always work; anything that signs needs the console started with --allow-execute and an explicit confirmation.'),
    h('div', { class: 'ops' },
      h('div', {}, ...groups.flatMap(group => [
        h('h2', { style: 'margin-top:18px' }, group),
        ...data.commands.filter(command => command.group === group).map(commandCard),
      ])),
      h('div', {}, consolePanel(), runHistory())),
  );
}

function commandCard(command) {
  const open = app.command === command.id;
  const inputs = {};
  const body = [h('div', { class: 'summary', text: command.summary })];
  if (open) {
    if (command.note) body.push(h('div', { class: 'why' }, badge('muted', '○', command.note)));
    if (command.danger) body.push(h('div', { class: 'why' }, badge('critical', '▲', command.danger)));
    if (command.needs.length) {
      body.push(h('div', { class: 'why' }, ...command.needs.map(need =>
        h('span', { style: 'margin-right:12px' },
          badge(need.present ? 'good' : 'warning', need.present ? '●' : '◔', need.name)))));
    }
    if (command.inputs.length) {
      body.push(h('div', { class: 'args' }, ...command.inputs.map(input => {
        let control;
        if (input.type === 'flag') {
          control = h('input', { type: 'checkbox', checked: input.default });
          inputs[input.name] = () => control.checked;
        } else if (input.type === 'choice') {
          control = h('select', {}, ...input.choices.map(choice =>
            h('option', { value: choice, selected: choice === input.default }, choice)));
          inputs[input.name] = () => control.value;
        } else {
          control = h('input', { type: 'text', value: input.default ?? '', spellcheck: 'false' });
          inputs[input.name] = () => control.value;
        }
        return h('div', { class: 'row' }, h('label', { text: input.label }), control);
      })));
    }
    if (command.exits) {
      body.push(h('div', { class: 'why' }, ...Object.entries(command.exits).map(([code, meaning]) =>
        h('div', {}, h('code', { text: `exit ${code}` }), ` — ${meaning}`))));
    }
    body.push(h('div', { class: 'actions' },
      h('button', {
        class: `btn ${command.kind === 'write' ? 'danger' : 'primary'}`,
        disabled: !command.runnable,
        onclick: () => start(command, Object.fromEntries(Object.entries(inputs).map(([key, read]) => [key, read()]))),
      }, command.kind === 'write' ? 'Confirm and run' : 'Run'),
      command.blockedReason ? h('span', { class: 'why', text: command.blockedReason }) : null));
  }
  return h('div', { class: `cmd${open ? ' sel' : ''}` },
    h('button', {
      class: 'head', type: 'button',
      onclick: () => { app.command = open ? null : command.id; setHash(); render(); },
    }, h('span', { class: 'name', text: command.label }),
      h('span', { class: `kind ${command.kind}`, text: command.kind })),
    ...body);
}

async function start(command, inputValues) {
  if (command.kind === 'write' && !confirm(`${command.label}\n\n${command.danger ?? ''}\n\nThis signs and broadcasts. Continue?`)) return;
  try {
    const run = await api('/api/run', {
      method: 'POST',
      body: JSON.stringify({ id: command.id, inputs: inputValues, confirm: command.kind === 'write' ? command.id : null }),
    });
    app.run = { ...run, label: command.label, status: 'running', lines: [] };
    render();
    listen(run.id);
  } catch (error) { toast(error.message, true); }
}

function listen(id) {
  app.source?.close();
  const source = new EventSource(`/api/stream?id=${encodeURIComponent(id)}&token=${encodeURIComponent(app.token)}`);
  app.source = source;
  source.onmessage = event => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'line') {
      app.run.lines.push(payload);
      appendLine(payload);
    } else {
      app.run.status = payload.status;
      app.run.exitCode = payload.exitCode;
      source.close();
      refresh();
    }
  };
  source.onerror = () => source.close();
}

function appendLine(line) {
  const pre = document.getElementById('console-out');
  if (!pre) return;
  pre.append(h('span', { class: line.stream === 'err' ? 'err' : '', text: `${line.text}\n` }));
  pre.scrollTop = pre.scrollHeight;
}

const RUN_TONE = { running: ['muted', '◔'], succeeded: ['good', '●'], attention: ['warning', '◔'], failed: ['critical', '▲'], stopped: ['muted', '○'] };

function consolePanel() {
  const run = app.run;
  const [tone, glyph] = RUN_TONE[run?.status] ?? RUN_TONE.running;
  return h('div', { class: 'console' },
    h('header', {},
      h('span', { class: 'title', text: run ? run.label : 'Output' }),
      run ? badge(tone, glyph, run.status + (run.exitCode != null ? ` (exit ${run.exitCode})` : '')) : null,
      h('span', { class: 'spacer', style: 'flex:1' }),
      run?.status === 'running'
        ? h('button', { class: 'btn', onclick: () => api('/api/stop', { method: 'POST', body: JSON.stringify({ id: run.id }) }).catch(error => toast(error.message, true)) }, 'Stop')
        : null),
    run
      ? h('pre', { id: 'console-out' }, ...run.lines.map(line =>
        h('span', { class: line.stream === 'err' ? 'err' : '', text: `${line.text}\n` })))
      : h('div', { class: 'empty', text: 'Pick a command to see its output here. Exit 2 means a human is needed, not a crash.' }),
    run?.argv?.length ? h('div', { class: 'empty', style: 'padding:8px 14px;border-top:1px solid var(--grid)' },
      h('code', { text: run.argv.join(' ') })) : null);
}

function runHistory() {
  const runs = app.data.runs ?? [];
  if (!runs.length) return h('div', {});
  return h('div', { class: 'console runs', style: 'position:static' },
    h('header', {}, h('span', { class: 'title', text: 'Recent runs' })),
    ...runs.map(run => {
      const [tone, glyph] = RUN_TONE[run.status] ?? RUN_TONE.running;
      return h('div', {
        class: 'run', onclick: async () => {
          app.run = { ...run, lines: [] };
          render();
          listen(run.id);
        },
      }, badge(tone, glyph, run.status), h('span', { text: run.label }),
        h('span', { class: 'when', text: relative(run.startedAt) }));
    }));
}

/* --------------------------------------------------------------------- docs */
async function loadDoc(path) {
  try {
    const body = await api(`/api/doc?path=${encodeURIComponent(path)}`);
    app.doc = path;
    app.docText = body.text;
    render();
  } catch (error) { toast(error.message, true); }
}

function renderDocs() {
  const { data } = app;
  const section = document.getElementById('tab-docs');
  if (!app.doc && data.docs.length) { loadDoc(data.docs[0].path); return; }
  const rendered = app.docText ? renderMarkdown(app.docText) : h('div', { class: 'markdown' },
    h('p', {}, 'Pick a document. Links between documents work here.'));
  rendered.addEventListener('click', event => {
    const target = event.target.closest('a[data-doc]');
    if (!target) return;
    event.preventDefault();
    const wanted = target.dataset.doc.replace(/^\.\//, '');
    const match = data.docs.find(doc => doc.path === wanted || doc.path.endsWith(`/${wanted}`));
    if (match) loadDoc(match.path);
    else toast(`${wanted} is not an indexed document`, true);
  });
  section.replaceChildren(h('div', { class: 'docs' },
    h('div', { class: 'doclist' }, ...data.docs.map(doc => h('button', {
      type: 'button', 'aria-current': String(doc.path === app.doc), onclick: () => loadDoc(doc.path),
    }, doc.title, h('span', { class: 'p', text: doc.path })))),
    rendered));
}

/* ------------------------------------------------------------------- render */
function render() {
  renderShell();
  ({ flow: renderFlow, checklist: renderChecklist, configure: renderConfigure, operate: renderOperate, docs: renderDocs }[app.tab] ?? renderFlow)();
}

async function refresh() {
  try {
    app.data = await api(`/api/state?network=${encodeURIComponent(app.network)}`);
    render();
  } catch (error) {
    // After the first successful load there is still a page on screen; say so rather than
    // failing silently into the browser console.
    if (!app.data) throw error;
    toast(`could not refresh: ${error.message}`, true);
  }
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  for (const button of document.querySelectorAll('[data-theme-set]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeSet === theme));
  }
}

for (const button of document.querySelectorAll('[data-theme-set]')) {
  button.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === button.dataset.themeSet ? null : button.dataset.themeSet;
    if (next) localStorage.setItem('theme', next); else localStorage.removeItem('theme');
    applyTheme(next);
  });
}
applyTheme(localStorage.getItem('theme'));

function setHash() {
  const selected = app.tab === 'flow' ? app.node : app.tab === 'operate' ? app.command : null;
  const next = selected ? `${app.tab}/${selected}` : app.tab;
  if (location.hash.slice(1) !== next) { app.suppressHash = true; location.hash = next; }
}

window.addEventListener('hashchange', () => {
  if (app.suppressHash) { app.suppressHash = false; return; }
  const { tab, selection } = readHash();
  app.tab = tab;
  if (tab === 'flow') app.node = selection;
  if (tab === 'operate') app.command = selection;
  render();
});

(async () => {
  // The token is minted at startup and handed to the same-origin page; every later call carries it.
  const url = new URL(location.href);
  const session = await (await fetch('/api/session')).json();
  app.token = url.searchParams.get('token') ?? session.token;
  app.allowExecute = session.allowExecute;
  await refresh();
})().catch(error => {
  document.querySelector('main').replaceChildren(h('div', { class: 'detail' },
    h('h3', {}, 'Could not reach the console server'), h('p', { text: error.message })));
});
