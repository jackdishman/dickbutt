/**
 * The flywheel diagram.
 *
 * Edge colour carries token identity (three categorical slots that clear the all-pairs CVD and
 * normal-vision floors in both modes) and every edge is directly labelled, so the picture reads
 * without the legend and without colour vision. Node state uses the reserved status palette and
 * always pairs the colour with a distinct glyph and a word.
 */
const SVG = 'http://www.w3.org/2000/svg';

const STATUS_GLYPH = { live: '●', deployed: '●', undeployed: '◔', missing: '▲', standin: '◌', external: '○' };
const LANE_VAR = { dickbutt: 'var(--lane-dickbutt)', weth: 'var(--lane-weth)', spcxc: 'var(--lane-spcxc)', mixed: 'var(--lane-mixed)' };

const el = (name, attributes = {}, text) => {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text != null) node.textContent = text;
  return node;
};

export const shortAddress = address => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null);

const clip = (text, budget) => (text.length > budget ? `${text.slice(0, budget - 1)}…` : text);

/** Greedy wrap at a character budget; node widths are fixed so a budget beats measuring text. */
function wrap(text, budget) {
  const lines = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (!current.length) current = word;
    else if (current.length + 1 + word.length <= budget) current += ` ${word}`;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines.length > 2 ? [lines[0], `${lines.slice(1).join(' ').slice(0, budget - 1)}…`] : lines;
}

export function renderDiagram(flow, { selected, onSelect }) {
  const svg = el('svg', {
    class: 'flow', viewBox: `0 0 ${flow.viewBox.width} ${flow.viewBox.height}`,
    role: 'img', 'aria-label': 'DICKBUTT fee flow',
  });

  const defs = el('defs');
  for (const [lane, color] of Object.entries(LANE_VAR)) {
    const marker = el('marker', { id: `arrow-${lane}`, viewBox: '0 0 8 8', refX: '7', refY: '4',
      markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    marker.append(el('path', { d: 'M 0 1 L 7 4 L 0 7 z', fill: color }));
    defs.append(marker);
  }
  svg.append(defs);

  const edgeLayer = el('g');
  const labelLayer = el('g');
  for (const edge of flow.edges) {
    const color = LANE_VAR[edge.lane] ?? LANE_VAR.mixed;
    edgeLayer.append(el('path', {
      d: edge.d, class: `edge${edge.muted ? ' muted' : ''}`, stroke: color,
      'marker-end': `url(#arrow-${edge.lane})`,
    }));
    if (edge.label) {
      // Label text stays in muted ink; a small mark beside it carries the token identity. Five
      // edges leave the two Splits through one channel band, and that dot is what tells the
      // stacked percentages apart. The surface halo keeps both readable over crossing edges.
      const width = edge.label.length * 5.6;
      labelLayer.append(el('circle', {
        cx: edge.labelX - width / 2 - 5, cy: edge.labelY - 3.5, r: 2.6, fill: color,
        stroke: 'var(--surface)', 'stroke-width': '1.5',
      }));
      labelLayer.append(el('text', {
        x: edge.labelX + 3, y: edge.labelY, class: 'edge-label', 'text-anchor': 'middle',
        stroke: 'var(--surface)', 'stroke-width': '3.5', 'paint-order': 'stroke',
      }, edge.label));
    }
  }
  svg.append(edgeLayer);

  const nodeLayer = el('g');
  for (const node of flow.nodes) {
    const group = el('g', { class: 'node', tabindex: '0', role: 'button',
      'aria-label': `${node.label}: ${node.statusLabel}` });
    group.append(el('rect', {
      x: node.x, y: node.y, width: node.w, height: node.h, rx: 9,
      class: `node-box${selected === node.id ? ' sel' : ''}`,
    }));

    let y = node.y + 21;
    for (const line of wrap(node.label, 16)) {
      nodeText(group, node.x + 11, y, 'node-title', line);
      y += 14;
    }
    if (node.sub) { nodeText(group, node.x + 11, y + 2, 'node-sub', clip(node.sub, 21)); y += 16; }
    nodeText(group, node.x + 11, y + 2, 'node-addr', shortAddress(node.address) ?? '—');
    y += 17;

    const status = el('text', { x: node.x + 11, y: y + 2, class: `node-status tone-${node.tone}`, fill: 'currentColor' });
    status.append(el('tspan', {}, `${STATUS_GLYPH[node.status]} `));
    status.append(el('tspan', {}, clip(node.statusLabel, 19)));
    group.append(status);

    group.addEventListener('click', () => onSelect(node.id));
    group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node.id); } });
    nodeLayer.append(group);
  }
  // Labels last: a short edge label sits in a 56px channel and would otherwise be painted over by
  // the node it points at. The surface halo keeps it readable where it does overlap.
  svg.append(nodeLayer, labelLayer);
  return svg;
}

function nodeText(group, x, y, className, text) {
  group.append(el('text', { x, y, class: className }, text));
}

export function renderLegend(flow) {
  const legend = document.createElement('div');
  legend.className = 'legend';
  for (const [id, lane] of Object.entries(flow.lanes)) {
    const item = document.createElement('span');
    item.className = 'sw';
    const swatch = document.createElement('i');
    swatch.style.background = LANE_VAR[id];
    item.append(swatch, document.createTextNode(lane.label));
    legend.append(item);
  }
  const states = [['deployed', 'on this network'], ['undeployed', 'not deployed here'],
    ['missing', 'address not set'], ['standin', 'stand-in / off-chain']];
  for (const [status, label] of states) {
    const tone = { deployed: 'good', undeployed: 'warning', missing: 'critical', standin: 'muted' }[status];
    const item = document.createElement('span');
    item.className = `badge tone-${tone}`;
    item.append(Object.assign(document.createElement('span'), { className: 'dot', textContent: STATUS_GLYPH[status] }),
      document.createTextNode(label));
    legend.append(item);
  }
  return legend;
}

export { STATUS_GLYPH };
