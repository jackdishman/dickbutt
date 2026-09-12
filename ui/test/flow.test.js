import test from 'node:test';
import assert from 'node:assert/strict';
import { NODES, EDGES, VIEWBOX, route, boxes, segments } from '../flow.js';

const rectangles = () => [...boxes().values()];

test('every edge connects two declared nodes', () => {
  const ids = new Set(NODES.map(node => node.id));
  for (const edge of EDGES) {
    assert.ok(ids.has(edge.from), `unknown edge source ${edge.from}`);
    assert.ok(ids.has(edge.to), `unknown edge target ${edge.to}`);
  }
});

test('edges always run left to right, so routing never has to double back', () => {
  const column = new Map(NODES.map(node => [node.id, node.col]));
  for (const edge of EDGES) {
    assert.ok(column.get(edge.to) > column.get(edge.from), `${edge.from} -> ${edge.to} does not advance a column`);
  }
});

test('no two node boxes overlap', () => {
  const all = rectangles();
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `${a.id} overlaps ${b.id}`);
    }
  }
});

test('every node fits inside the viewBox', () => {
  for (const node of rectangles()) {
    assert.ok(node.x >= 0 && node.x + node.w <= VIEWBOX.width, `${node.id} overflows horizontally`);
    assert.ok(node.y >= 0 && node.y + node.h <= VIEWBOX.height, `${node.id} overflows vertically`);
  }
});

// The reason routing is orthogonal with allocated channels rather than beziers: this is checkable.
test('no routed edge crosses a node it does not touch', () => {
  const all = rectangles();
  for (const routed of route()) {
    for (const [[ax, ay], [bx, by]] of segments(routed)) {
      for (const node of all) {
        if (node.id === routed.from || node.id === routed.to) continue;
        const crosses = Math.max(ax, bx) + 2 > node.x && Math.min(ax, bx) - 2 < node.x + node.w
          && Math.max(ay, by) + 2 > node.y && Math.min(ay, by) - 2 < node.y + node.h;
        assert.ok(!crosses, `${routed.from} -> ${routed.to} crosses ${node.id}`);
      }
    }
  }
});

test('edges sharing a column gap get distinct vertical channels', () => {
  const byColumn = new Map();
  const column = new Map(NODES.map(node => [node.id, node.col]));
  for (const routed of route()) {
    const key = column.get(routed.from);
    byColumn.set(key, [...(byColumn.get(key) ?? []), routed.channelX]);
  }
  for (const [key, channels] of byColumn) {
    assert.equal(new Set(channels).size, channels.length, `column ${key} reuses a channel`);
  }
});

test('labels are pushed apart when they land on top of each other', () => {
  const labelled = route().filter(edge => edge.label);
  assert.ok(labelled.length >= 10, 'expected the flow to be mostly labelled');
  for (let i = 0; i < labelled.length; i++) {
    for (let j = i + 1; j < labelled.length; j++) {
      const a = labelled[i], b = labelled[j];
      const collides = Math.abs(a.labelX - b.labelX) <= 26 && Math.abs(a.labelY - b.labelY) < 13;
      assert.ok(!collides, `labels "${a.label}" and "${b.label}" overlap`);
    }
  }
});

test('every path starts at its source face and ends at its target face', () => {
  const box = boxes();
  for (const routed of route()) {
    const from = box.get(routed.from), to = box.get(routed.to);
    const points = segments(routed);
    assert.equal(points[0][0][0], from.x + from.w, `${routed.from} -> ${routed.to} does not leave the source`);
    assert.equal(points.at(-1)[1][0], to.x, `${routed.from} -> ${routed.to} does not reach the target`);
  }
});
