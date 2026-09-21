/**
 * The fee flywheel as data: nodes, edges, a fixed layout and deterministic edge routing.
 *
 * The diagram is the one artefact everyone in this project argues about, so it is derived from the
 * same config the CLIs read rather than drawn by hand. A node whose address is null renders as
 * unset; a node present in a deployment manifest renders as deployed. That way the picture cannot
 * quietly disagree with `config/base-mainnet.json`.
 *
 * Routing is orthogonal with allocated channels rather than beziers. Curves look fine until two of
 * them run through the same column gap, and "looks fine" is not checkable; channel allocation is.
 * `test/flow.test.js` asserts no edge crosses a node it does not touch, that no two edges share a
 * channel, and that no two labels land on top of each other.
 */

const W = 132; // node width; the column pitch is W + GAP
const GAP = 56; // wide enough for a short edge label to sit in the channel
const X = col => 24 + col * (W + GAP);

/** Token identity, used for edge color. Three slots validate all-pairs in both modes. */
export const LANES = {
  dickbutt: { label: 'DICKBUTT', slot: 1 },
  weth: { label: 'WETH', slot: 2 },
  spcxc: { label: 'SPCXc', slot: 3 },
  mixed: { label: 'DICKBUTT + WETH', slot: 0 },
};

/**
 * `address` is a dotted path into the resolved config for the selected network. `manifest` is the
 * matching path inside a deployment manifest, when the thing is a contract this repo deploys.
 */
export const NODES = [
  { id: 'locker', col: 0, y: 60, h: 96, kind: 'source', label: 'Clanker locker',
    sub: 'DICKBUTT/WETH LP', address: 'clankerLocker', manifest: 'sources.locker',
    detail: 'The Clanker locker holding the original DICKBUTT/WETH position. It deducts 60% of both token sides into its fee Safe before anything reaches this pipeline. Ownership must be handed to LockerHarvester for permissionless collection.',
    doc: 'docs/LEGACY-FEES.md', caveat: 'ownership handoff to LockerHarvester outstanding' },

  { id: 'legacySafes', col: 1, y: 200, h: 96, kind: 'source', label: 'Clanker fee Safes',
    sub: '60% deduction', address: 'legacy:currentFeeSink', manifest: 'sources.legacySafes',
    detail: 'Current and historical Clanker fee Safes. Their legacy module returns the DICKBUTT side to the token creator, so the pipeline can recover effectively all collected DICKBUTT — but not the WETH side.',
    doc: 'docs/LEGACY-FEES.md' },

  { id: 'lockerHarvester', col: 1, y: 60, h: 96, kind: 'contract', label: 'Locker harvester', contract: 'src/LockerHarvester.sol',
    sub: 'permissionless', manifest: 'contracts.clanker',
    detail: 'Anyone may call harvest(). Destination changes are timelocked and can be frozen permanently. Requires locker ownership — a handoff this project has not performed.',
    doc: 'AUDITOR-BRIEF.md' },

  { id: 'legacyHarvester', col: 2, y: 200, h: 96, kind: 'contract', label: 'Legacy fee harvester', contract: 'src/LegacyFeeHarvester.sol',
    sub: 'permissionless', manifest: 'contracts.legacy',
    detail: 'Recovers returned DICKBUTT from both verified Safes to a fixed receiver. Module, token, destination and Safe list are immutable. Assigning it creator authority is PERMANENT: there is no relay to update the creator afterwards.',
    doc: 'docs/LEGACY-FEES.md', caveat: 'creator authority is permanent once assigned' },

  { id: 'rewardsPool', col: 2, y: 470, h: 96, kind: 'source', label: '0.3% DICKBUTT/SPCXc',
    sub: 'full-range LP', address: 'rewardsPool.pool', manifest: null,
    detail: 'Concentrated, full-range, unstaked, tick spacing 200. The intended pool and its NFT still need verification. Production also needs completed bot roles and settings, mainnet runtime support, review and deployment.',
    doc: 'AERODROME-SETUP.md', caveat: 'pool does not exist yet' },

  { id: 'aeroHarvester', col: 3, y: 470, h: 96, kind: 'contract', label: 'Aerodrome harvester', contract: 'src/AerodromeFeeHarvester.sol',
    sub: 'holds the LP NFT', manifest: 'contracts.aero',
    detail: 'Custodies the concentrated LP NFT, burns its DICKBUTT fees and forwards its SPCXc fees straight to the distributor. Collection against the real pool is untested until the pool exists.',
    doc: 'AERODROME-SETUP.md', caveat: 'LP NFT custody handoff outstanding' },

  { id: 'feeRouter', col: 3, y: 120, h: 96, kind: 'contract', label: 'Splits fee router', contract: 'src/SplitsFeeRouter.sol',
    sub: 'token → its Split', manifest: 'contracts.feeRouter',
    detail: 'Creates two immutable upstream PushSplit V2.2 clones through the official Splits factory and forwards each token to the correct one. It does not reimplement percentage math; Splits does the splitting.',
    doc: 'docs/SPLITS-INTEGRATION.md' },

  { id: 'dickSplit', col: 4, y: 40, h: 96, kind: 'split', label: 'DICKBUTT Split', contract: 'Splits PushSplit V2.2',
    sub: '10/90 · immutable', manifest: 'splits.dickSplit',
    detail: 'Genuine PushSplit V2.2 clone, zero owner, zero incentive. Splits rounds allocations down and retains raw-unit dust, which rolls into future distributions.',
    doc: 'docs/SPLITS-INTEGRATION.md' },

  { id: 'wethSplit', col: 4, y: 190, h: 96, kind: 'split', label: 'WETH Split', contract: 'Splits PushSplit V2.2',
    sub: '10/10/80 · immutable', manifest: 'splits.wethSplit',
    detail: 'Genuine PushSplit V2.2 clone. Recipients are immutable: there is no setter, so a wrong address means redeploying the router and re-pointing every harvester.',
    doc: 'docs/SPLITS-INTEGRATION.md' },

  { id: 'executor', col: 5, y: 26, h: 96, kind: 'contract', label: 'SPCXc swap executor', contract: 'src/SpcxcSwapExecutor.sol',
    sub: 'WETH→USDC→SPCXc', manifest: 'contracts.executor',
    detail: 'Fixed two-hop Aerodrome route with a size cap, deadline, owner price floor and approved keeper. The floor expires within a day, so an ops key refreshes it on separate infrastructure from the keeper.',
    doc: 'docs/PRICE-FLOOR.md', caveat: 'price floor expires within a day and needs an ops bot' },

  { id: 'kcGreen', col: 5, y: 150, h: 96, kind: 'recipient', label: 'KC Green',
    sub: '10% of both', address: 'deployment.kcGreen', manifest: 'roles.kcGreen',
    detail: 'The artist. Already holds 1,000,000 DICKBUTT, so it must appear in the calculator exclusions or it earns SPCXc holder rewards on its own fee income.',
    doc: 'docs/GOVERNANCE.md' },

  { id: 'cdbVault', col: 5, y: 250, h: 96, kind: 'recipient', label: 'CDB treasury',
    sub: '10% of WETH', address: 'deployment.cdbVault', manifest: 'roles.cdbVault',
    detail: 'Receives WETH on Base for CryptoDickbutts floor buys. Bridging and purchasing stay manual. Prove key control before the immutable Split is deployed.',
    doc: 'docs/GOVERNANCE.md', caveat: 'key control unproven; the Split has no recipient setter' },

  { id: 'burn', col: 5, y: 350, h: 96, kind: 'recipient', label: 'Burn address',
    sub: '90% of DICKBUTT', address: 'deployment.burnAddress', manifest: 'roles.burnAddress',
    detail: 'Transferring to 0x…dEaD removes tokens from circulation but does not call the token’s supply-burn function, so total supply is unchanged.',
    doc: 'docs/SPLITS-INTEGRATION.md' },

  { id: 'distributor', col: 6, y: 460, h: 96, kind: 'contract', label: 'Rewards distributor', contract: 'src/DickbuttRewardsDistributor.sol',
    sub: 'committed rounds', manifest: 'contracts.distributor',
    detail: 'Reserves proposed and active obligations, then pushes proof-verified rewards. New rounds are scheduled every 6h with no extra review wait. The 50% per-round share cap and guardian pause for future proposals remain; payouts are checked every minute.',
    doc: 'docs/GOVERNANCE.md', caveat: 'needs the owner multisig and a proposer key' },

  { id: 'holders', col: 7, y: 460, h: 96, kind: 'terminal', label: 'Eligible holders',
    sub: 'paid, never claim', address: null, manifest: null,
    detail: 'Time-weighted balances above a 6.9M DICKBUTT threshold, linear weighting, with pools, treasuries and operational keys excluded. Holders receive payments; they never sign or claim.',
    doc: 'calculator/README.md' },
];

export const EDGES = [
  { from: 'locker', to: 'lockerHarvester', lane: 'mixed', label: '40%' },
  { from: 'locker', to: 'legacySafes', lane: 'mixed', label: '60%', muted: true },
  { from: 'legacySafes', to: 'legacyHarvester', lane: 'dickbutt', label: 'returned' },
  { from: 'lockerHarvester', to: 'feeRouter', lane: 'mixed' },
  { from: 'legacyHarvester', to: 'feeRouter', lane: 'dickbutt' },
  { from: 'feeRouter', to: 'dickSplit', lane: 'dickbutt' },
  { from: 'feeRouter', to: 'wethSplit', lane: 'weth' },
  { from: 'dickSplit', to: 'kcGreen', lane: 'dickbutt', label: '10%' },
  { from: 'dickSplit', to: 'burn', lane: 'dickbutt', label: '90%' },
  { from: 'wethSplit', to: 'executor', lane: 'weth', label: '80%' },
  { from: 'wethSplit', to: 'kcGreen', lane: 'weth', label: '10%' },
  { from: 'wethSplit', to: 'cdbVault', lane: 'weth', label: '10%' },
  { from: 'executor', to: 'distributor', lane: 'spcxc', label: 'SPCXc' },
  { from: 'rewardsPool', to: 'aeroHarvester', lane: 'mixed', label: 'LP fees' },
  { from: 'aeroHarvester', to: 'burn', lane: 'dickbutt', label: 'DICKBUTT side' },
  { from: 'aeroHarvester', to: 'distributor', lane: 'spcxc', label: 'SPCXc side' },
  { from: 'distributor', to: 'holders', lane: 'spcxc', label: 'batches' },
];

export const VIEWBOX = { width: X(7) + W + 24, height: 600 };

/** Node geometry. Kept out of NODES so the data reads as a description, not a drawing. */
export function boxes(nodes = NODES) {
  return new Map(nodes.map(n => [n.id, { ...n, x: X(n.col), w: W, cx: X(n.col) + W / 2, cy: n.y + n.h / 2 }]));
}

const round = (n, p = 1) => Number(n.toFixed(p));

/**
 * Orthogonal routing with one vertical channel per edge.
 *
 * Every edge leaves its source to the right, turns once in the gap after the source column, and
 * arrives at the target's left face. Edges sharing a gap get distinct channel positions, and edges
 * sharing a node face get distinct attachment heights, so nothing overlaps by construction.
 */
export function route(nodes = NODES, edges = EDGES) {
  const box = boxes(nodes);
  const spread = (key, list) => {
    const groups = new Map();
    for (const e of list) groups.set(key(e), [...(groups.get(key(e)) ?? []), e]);
    return groups;
  };

  // Attachment heights: fan multiple connections across a node's face instead of stacking them.
  const offsets = new Map();
  for (const side of ['from', 'to']) {
    for (const [, group] of spread(e => e[side], edges)) {
      const ordered = [...group].sort((a, b) => box.get(a[side === 'from' ? 'to' : 'from']).cy - box.get(b[side === 'from' ? 'to' : 'from']).cy);
      ordered.forEach((edge, i) => {
        const node = box.get(edge[side]);
        const span = Math.min(node.h - 24, (ordered.length - 1) * 20);
        offsets.set(`${side}:${edge.from}>${edge.to}`, ordered.length === 1 ? 0 : -span / 2 + (i * span) / (ordered.length - 1));
      });
    }
  }

  // Channels: each gap is divided among the edges that turn in it.
  const channels = new Map();
  for (const [col, group] of spread(e => box.get(e.from).col, edges)) {
    const start = X(Number(col)) + W;
    group.forEach((edge, i) => channels.set(`${edge.from}>${edge.to}`, round(start + (GAP * (i + 1)) / (group.length + 1))));
  }

  const routed = edges.map(edge => {
    const a = box.get(edge.from), b = box.get(edge.to);
    const y0 = round(a.cy + offsets.get(`from:${edge.from}>${edge.to}`));
    const y1 = round(b.cy + offsets.get(`to:${edge.from}>${edge.to}`));
    const cx = channels.get(`${edge.from}>${edge.to}`);
    const x0 = a.x + a.w, x1 = b.x;
    const r = Math.min(10, Math.abs(y1 - y0) / 2, (cx - x0) || 10);
    let d;
    if (Math.abs(y1 - y0) < 1) d = `M ${x0} ${y0} L ${x1} ${y0}`;
    else {
      const dir = y1 > y0 ? 1 : -1;
      d = `M ${x0} ${y0} L ${round(cx - r)} ${y0} Q ${cx} ${y0} ${cx} ${round(y0 + r * dir)}`
        + ` L ${cx} ${round(y1 - r * dir)} Q ${cx} ${y1} ${round(cx + r)} ${y1} L ${x1} ${y1}`;
    }
    // Anchor the label to the midpoint of the longest straight run, which is the only part of the
    // path guaranteed to have room for it.
    const runs = Math.abs(y1 - y0) < 1
      ? [[(x0 + x1) / 2, y0 - 6]]
      : [[(x0 + cx) / 2, y0 - 6], [cx, (y0 + y1) / 2], [(cx + x1) / 2, y1 - 6]];
    const lengths = Math.abs(y1 - y0) < 1 ? [x1 - x0] : [cx - x0, Math.abs(y1 - y0), x1 - cx];
    const best = lengths.indexOf(Math.max(...lengths));
    return { ...edge, d, channelX: cx, labelX: round(runs[best][0]), labelY: round(runs[best][1]), y0, y1 };
  });
  return deconflictLabels(routed);
}

/**
 * Push apart labels that landed on top of each other.
 *
 * Both Splits sit in one column, so five outgoing edges share one channel band and their midpoints
 * bunch up. Percentages are the labels that matter most here, and "10% 90% 10%" printed on top of
 * itself is worse than no label at all.
 */
function deconflictLabels(routed, minimumGap = 13, sameColumn = 26) {
  const labelled = routed.filter(edge => edge.label).sort((a, b) => a.labelY - b.labelY);
  for (let i = 0; i < labelled.length; i++) {
    for (let j = 0; j < i; j++) {
      const above = labelled[j], current = labelled[i];
      if (Math.abs(above.labelX - current.labelX) > sameColumn) continue;
      if (current.labelY - above.labelY >= minimumGap) continue;
      current.labelY = round(above.labelY + minimumGap);
    }
  }
  return routed;
}

/** Straight-line segments of a routed path, for the collision test. */
export function segments(routed) {
  const points = routed.d.trim().split(/(?=[MLQ])/).map(part => {
    const nums = part.trim().split(/\s+/).slice(1).map(Number);
    // A quadratic's on-path end is its second pair; the control point is not a vertex.
    return part.trim()[0] === 'Q' ? [nums[2], nums[3]] : [nums[0], nums[1]];
  });
  return points.slice(0, -1).map((p, i) => [p, points[i + 1]]);
}
