/**
 * The launch checklist, derived where it can be and recorded where it cannot.
 *
 * Anything a file can answer is answered by the file — a null address in `config/base-mainnet.json`
 * is a blocker whether or not anyone ticked a box. The rest (a handoff performed on a multisig, an
 * external review, a key funded) has no local evidence, so it is an explicit manual entry stored in
 * a gitignored overrides file. Mixing the two would let a tick-box outrank the config, which is
 * exactly the drift this console exists to prevent.
 */

const get = (object, path) => path.split('.').reduce((value, key) => (value == null ? value : value[key]), object);
const set = (value) => (value ? 'done' : 'blocked');

export const STATES = ['done', 'pending', 'blocked', 'n/a'];

/** `derive` returns a state from the repository; items without one are manual. */
export const ITEMS = [
  // --- addresses -------------------------------------------------------------
  { id: 'cfg.owner', group: 'Addresses', owner: 'Kevin', label: 'Owner multisig',
    detail: 'Owns the distributor, both harvesters and the swap executor: roles, limits, timelocked destinations, LP NFT custody, the floor lower bound. Also the default guardian.',
    doc: 'docs/GOVERNANCE.md', derive: c => set(get(c.mainnet, 'deployment.owner')) },
  { id: 'cfg.proposer', group: 'Addresses', owner: 'Kevin', label: 'Proposer bot key',
    detail: 'Calls proposeRound. Cannot move tokens: payment is keeper-gated and the keeper rejects any root its own journal did not produce.',
    doc: 'docs/GOVERNANCE.md', derive: c => set(get(c.mainnet, 'deployment.proposer')) },
  { id: 'cfg.guardian', group: 'Addresses', owner: 'Kevin', label: 'Guardian (optional)',
    detail: 'Cancels a pending round and pauses proposals. Null means it inherits the owner multisig, which is the intended default.',
    derive: c => (get(c.mainnet, 'deployment.guardian') ? 'done' : 'n/a') },
  { id: 'cfg.keeper', group: 'Addresses', owner: 'Kevin', label: 'Keeper hot key',
    detail: 'Signs processWeth and distributeBatch only. Treat the key as disposable; worst case for a compromise is griefing, not theft.',
    doc: 'docs/KEEPER.md', derive: c => set(get(c.mainnet, 'deployment.keeper')) },
  { id: 'cfg.floorSetter', group: 'Addresses', owner: 'Kevin', label: 'Floor setter (ops) key',
    detail: 'Signs setPriceFloor only, above the owner lower bound. The executor refuses it as a keeper and refuses the keeper as a setter. Separate host from the keeper.',
    doc: 'docs/PRICE-FLOOR.md', derive: c => set(get(c.mainnet, 'deployment.floorSetter')) },
  { id: 'cfg.kcGreen', group: 'Addresses', owner: 'Kevin', label: 'KC Green recipient',
    detail: 'Verified on-chain, holds 1,000,000 DICKBUTT, and is already in the required calculator exclusion set.',
    derive: c => set(get(c.mainnet, 'deployment.kcGreen')) },
  { id: 'cfg.cdbVault', group: 'Addresses', owner: 'Kevin', label: 'CDB treasury recipient',
    detail: 'Verified on-chain but completely unused: nonce 0 on Base and Ethereum, no ETH on either.',
    derive: c => set(get(c.mainnet, 'deployment.cdbVault')) },
  { id: 'custody.cdbProof', group: 'Addresses', owner: 'Kevin', label: 'Prove CDB key control',
    detail: 'A signed message or dust transaction from the CDB vault, before SplitsFeeRouter is deployed. The Split is immutable and has no recipient setter: a wrong address means redeploying the router and re-pointing every harvester.',
    doc: 'docs/SPLITS-INTEGRATION.md' },

  // --- the pool --------------------------------------------------------------
  { id: 'pool.create', group: 'Rewards pool', owner: 'Kevin', label: 'Create the 0.3% DICKBUTT/SPCXc pool',
    detail: 'Concentrated, full-range, unstaked, tick spacing 200, ~$30k TVL target. Chosen over 1% to stay competitive for USDC → SPCXc → DICKBUTT aggregator routing.',
    doc: 'AERODROME-SETUP.md', derive: c => set(get(c.mainnet, 'rewardsPool.pool')) },
  { id: 'pool.tokenId', group: 'Rewards pool', owner: 'Kevin', label: 'Record the position NFT id',
    detail: 'Unblocks testForkOptionalAeroCollect, which is the only coverage of real Aerodrome fee collection anywhere in this repository.',
    doc: 'AERODROME-SETUP.md', derive: c => set(get(c.mainnet, 'rewardsPool.tokenId')) },
  { id: 'pool.route', group: 'Rewards pool', owner: 'Jack', label: 'Pin the two-hop swap route',
    detail: 'WETH → USDC → SPCXc, enforced by preflight against factory discovery. The direct WETH/SPCXc pool is shallow and quotes worse; it is recorded as an explicitly rejected alternative.',
    doc: 'docs/REHEARSAL.md', derive: c => set(get(c.mainnet, 'aerodrome.usdcSpcxcPool')) },

  // --- custody ---------------------------------------------------------------
  { id: 'custody.legacyClaim', group: 'Custody handoffs', owner: 'Kevin', label: 'Claim the outstanding legacy fees',
    detail: 'Clanker returns the token side of historical fees to the creator. Claim before changing creator authority.',
    doc: 'docs/LEGACY-FEES.md' },
  { id: 'custody.locker', group: 'Custody handoffs', owner: 'Kevin', label: 'Hand locker ownership to LockerHarvester',
    detail: 'Makes fee collection permissionless. Separate from creator authority and from LP NFT custody — rehearse the three independently.',
    doc: 'AUDITOR-BRIEF.md' },
  { id: 'custody.creator', group: 'Custody handoffs', owner: 'Kevin', label: 'Assign legacy tokenCreator authority',
    detail: 'PERMANENT. The adapter has no relay to update the creator, so settle migration and recovery policy before assigning it. Rehearsal does not imply approval of this choice.',
    doc: 'docs/LEGACY-FEES.md' },
  { id: 'custody.lpNft', group: 'Custody handoffs', owner: 'Kevin', label: 'Transfer the LP NFT to AerodromeFeeHarvester',
    detail: 'Do this only after the pool exists and its real fee collection has been tested.',
    doc: 'AERODROME-SETUP.md' },

  // --- rehearsal -------------------------------------------------------------
  { id: 'rehearse.local', group: 'Rehearsal', owner: 'Jack', label: 'Local Base-fork rehearsal',
    detail: 'Disposable Anvil fork, genuine Splits factory, mocked fee sources. Harvest, route, swap, calculate, propose, timelock, retry, close, reconcile.',
    doc: 'docs/REHEARSAL.md', derive: c => (c.rehearsalRuns > 0 ? 'done' : 'pending') },
  { id: 'rehearse.sepolia', group: 'Rehearsal', owner: 'Jack', label: 'Live Base Sepolia deployment',
    detail: 'The whole architecture on the public testnet with genuine immutable PushSplit clones, redeployed with the floor-setter role; every role verified live. Aerodrome, tokens and fee sources are stand-ins.',
    doc: 'docs/SEPOLIA.md', derive: c => set(get(c.sepolia, 'contracts.distributor')) },
  { id: 'rehearse.soak', group: 'Rehearsal', owner: 'Jack', label: 'Unattended multi-day soak',
    detail: 'Scheduling and alerting are scaffolding until something has actually run unattended. Base Sepolia finalises ~22 minutes behind head, so fee-to-payout latency is finality + a period + the timelock: budget a day per cycle.',
    doc: 'docs/RUNBOOK.md' },
  { id: 'rehearse.guardian', group: 'Rehearsal', owner: 'Kevin', label: 'Rehearse the guardian path',
    detail: 'Pause, cancel, unpause — with the multisig, before anything depends on it. A guardian only helps if someone is alerted and acts inside the window.',
    doc: 'docs/RUNBOOK.md' },

  // --- operations ------------------------------------------------------------
  { id: 'ops.fundKeeper', group: 'Operations', owner: 'Kevin', label: 'Fund the keeper key with ETH',
    detail: 'An unfunded bot fails exactly like a dead one: silently. The keyless monitor watches gas balances for this reason.',
    doc: 'docs/RUNBOOK.md' },
  { id: 'ops.fundBots', group: 'Operations', owner: 'Kevin', label: 'Fund the proposer and ops keys',
    detail: 'Four roles on four hosts, never sharing a key: keeper, ops, proposer and a keyless monitor.',
    doc: 'docs/RUNBOOK.md' },
  { id: 'ops.schedule', group: 'Operations', owner: 'Jack', label: 'Install the rendered schedule',
    detail: 'npm run schedule renders systemd units or a crontab from one validated definition, so no scheduler can disagree about which key runs where.',
    doc: 'docs/RUNBOOK.md' },
  { id: 'ops.alerts', group: 'Operations', owner: 'Jack', label: 'Wire alerts to the exit codes',
    detail: 'Exit 2 means a human is needed, not a crash — set SuccessExitStatus=0 2 so the unit does not loop. The alert that matters is unknown-commitment: a root the calculator journal never produced.',
    doc: 'docs/RUNBOOK.md' },

  // --- gates -----------------------------------------------------------------
  { id: 'gate.review', group: 'Gates', owner: 'external', label: 'Independent contract review',
    detail: 'Self-review found real bugs but the author wrote them. AUDITOR-BRIEF.md has the scope, trust boundaries and evidence limits ready.',
    doc: 'AUDITOR-BRIEF.md' },
  { id: 'gate.mainnetWrites', group: 'Gates', owner: 'Jack', label: 'Lift the mainnet execution gate',
    detail: 'The operating CLIs hard-refuse chain 8453. Lifting that is a deliberate production-operating decision and should be its own reviewed change, after a testnet soak — not a config edit.',
    doc: 'AUDITOR-BRIEF.md' },
];

export const GROUPS = [...new Set(ITEMS.map(i => i.group))];

/**
 * @param context.mainnet   config/base-mainnet.json
 * @param context.sepolia   config/deployment-sepolia.json
 * @param context.overrides manual states, keyed by item id
 */
export function buildReadiness(context = {}) {
  const overrides = context.overrides ?? {};
  const items = ITEMS.map(item => {
    const derived = item.derive ? item.derive(context) : null;
    const override = overrides[item.id];
    return {
      id: item.id, group: item.group, owner: item.owner, label: item.label, detail: item.detail,
      doc: item.doc ?? null,
      // Derived items are not overridable: a tick box must never outrank the config it describes.
      source: derived ? 'derived' : 'manual',
      state: derived ?? override?.state ?? 'pending',
      note: override?.note ?? null,
      updatedAt: override?.updatedAt ?? null,
    };
  });
  const count = state => items.filter(i => i.state === state).length;
  const scored = items.filter(i => i.state !== 'n/a');
  return {
    items,
    groups: GROUPS.map(group => ({ group, items: items.filter(i => i.group === group) })),
    summary: {
      done: count('done'), pending: count('pending'), blocked: count('blocked'), na: count('n/a'),
      total: scored.length,
      percent: scored.length ? Math.round((count('done') / scored.length) * 100) : 0,
      blockers: items.filter(i => i.state === 'blocked'),
      waitingOn: [...new Set(items.filter(i => i.state !== 'done' && i.state !== 'n/a').map(i => i.owner))],
    },
  };
}

/** Manual items only; derived state is a property of the repository, not of anyone's opinion. */
export function applyOverride(overrides, id, state, note) {
  const item = ITEMS.find(i => i.id === id);
  if (!item) throw Error(`unknown checklist item: ${id}`);
  if (item.derive) throw Error(`${id} is derived from configuration and cannot be set by hand`);
  if (!STATES.includes(state)) throw Error(`state must be one of ${STATES.join(', ')}`);
  return { ...overrides, [id]: { state, note: note || null, updatedAt: new Date().toISOString() } };
}
