import test from 'node:test';
import assert from 'node:assert/strict';
import { ITEMS, buildReadiness, applyOverride } from '../readiness.js';

const configured = {
  mainnet: {
    deployment: { owner: '0x1', proposer: '0x2', guardian: null, keeper: '0x3', kcGreen: '0x4', cdbVault: '0x5' },
    rewardsPool: { pool: '0x6', tokenId: '123' },
    aerodrome: { usdcSpcxcPool: '0x7' },
  },
  sepolia: { contracts: { distributor: '0x8' } },
  rehearsalRuns: 2,
};

test('a null address in the config reads as blocked', () => {
  const { items } = buildReadiness({ mainnet: { deployment: {} }, sepolia: null });
  assert.equal(items.find(item => item.id === 'cfg.owner').state, 'blocked');
  assert.equal(items.find(item => item.id === 'pool.create').state, 'blocked');
});

test('a configured address reads as done without anyone ticking a box', () => {
  const { items } = buildReadiness(configured);
  assert.equal(items.find(item => item.id === 'cfg.owner').state, 'done');
  assert.equal(items.find(item => item.id === 'pool.tokenId').state, 'done');
});

test('an absent guardian blocks: preflight requires the address written out', () => {
  const { items } = buildReadiness(configured);
  assert.equal(items.find(item => item.id === 'cfg.guardian').state, 'blocked');
});

test('n/a items are excluded from the score rather than counted as done', () => {
  const overrides = applyOverride({}, 'custody.lpNft', 'n/a', 'no LP NFT in this configuration');
  const { summary } = buildReadiness({ ...configured, overrides });
  assert.equal(summary.total, ITEMS.length - 3); // manual NFT exclusion + two vAMM-only items
  assert.ok(summary.percent < 100);
});

// The whole point of splitting derived from manual: a tick box must not outrank the config.
test('a derived item cannot be overridden by hand', () => {
  assert.throws(() => applyOverride({}, 'cfg.owner', 'done'), /derived from configuration/);
  const { items } = buildReadiness({ ...configured, overrides: { 'cfg.owner': { state: 'done' } }, mainnet: { deployment: {} } });
  assert.equal(items.find(item => item.id === 'cfg.owner').state, 'blocked');
});

test('a manual item records state, note and time', () => {
  const overrides = applyOverride({}, 'custody.locker', 'done', 'signed by the multisig');
  assert.equal(overrides['custody.locker'].state, 'done');
  assert.equal(overrides['custody.locker'].note, 'signed by the multisig');
  assert.ok(Date.parse(overrides['custody.locker'].updatedAt) > 0);
  const { items } = buildReadiness({ ...configured, overrides });
  assert.equal(items.find(item => item.id === 'custody.locker').state, 'done');
});

test('unknown items and states are rejected', () => {
  assert.throws(() => applyOverride({}, 'nope', 'done'), /unknown checklist item/);
  assert.throws(() => applyOverride({}, 'custody.locker', 'shipped'), /state must be one of/);
});

test('every item names an owner and every derived item returns a known state', () => {
  const context = { mainnet: {}, sepolia: {}, rehearsalRuns: 0 };
  for (const item of ITEMS) {
    assert.ok(['Kevin', 'Jack', 'external'].includes(item.owner), `${item.id} has no owner`);
    if (item.derive) assert.ok(['done', 'pending', 'blocked', 'n/a'].includes(item.derive(context)), `${item.id} derived an unknown state`);
  }
});

test('vAMM requires an LP wallet and cannot inherit a completed NFT custody checkbox',()=>{
  const ctx={...configured,mainnet:{...configured.mainnet,rewardsPool:{kind:'vamm',pool:'0x6',lpOwner:null}},
    overrides:{'custody.lpNft':{state:'done'}}};
  const {items}=buildReadiness(ctx),state=id=>items.find(i=>i.id===id).state;
  assert.equal(state('pool.tokenId'),'n/a');assert.equal(state('pool.lpOwner'),'blocked');
  assert.equal(state('custody.lpNft'),'n/a');assert.equal(state('custody.lpTokens'),'pending');
});
