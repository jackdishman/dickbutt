import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deploymentPaths } from '../deployment-paths.js';
import { loadState } from '../state.js';
import { describeCommands, resolveCommand } from '../commands.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-deployment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  const repo = path.resolve(import.meta.dirname, '../..');
  fs.copyFileSync(path.join(repo, 'config/base-mainnet.json'), path.join(root, 'config/base-mainnet.json'));
  return {root, write: (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value))};
}

test('flow, displayed forms and executed defaults select the same current deployment', t => {
  const {root, write} = fixture(t);
  const selected = {manifest:'config/current.json', calculator:'config/current-calculator.json', journal:'.context/current-journal'};
  write('config/console-deployment.json', selected);
  write('config/deployment-sepolia.json', {contracts:{feeRouter:'historical'}});
  write(selected.manifest, {contracts:{feeRouter:'current'}});
  assert.equal(loadState(root).config.sepolia.contracts.feeRouter, 'current');
  const displayed = describeCommands({root}).find(c => c.id === 'fees-execute');
  assert.equal(displayed.inputs.find(i => i.name === 'config').default, selected.manifest);
  assert.equal(resolveCommand('fees-execute', {root, allowWrite:true, confirm:'fees-execute'}).inputs.config, selected.manifest);
  const keeper = resolveCommand('keeper-dry', {root});
  assert.equal(keeper.inputs.calculator, selected.calculator);
  assert.equal(keeper.inputs.journal, selected.journal);
  assert.equal(resolveCommand('preflight', {root}).inputs.config, 'config/base-mainnet.json');
  assert.equal(resolveCommand('fees-dry', {root,inputs:{config:'config/explicit.json'}}).inputs.config, 'config/explicit.json');
});

test('an installation without an explicit selector retains its historical defaults', t => {
  const {root} = fixture(t);
  assert.equal(deploymentPaths(root).manifest, 'config/deployment-sepolia.json');
  assert.equal(resolveCommand('monitor', {root}).inputs.config, 'config/deployment-sepolia.json');
});

test('an invalid selector is rejected instead of reading outside the project or falling back', t => {
  const {root, write} = fixture(t);
  write('config/console-deployment.json', {manifest:'../../private.json',calculator:'config/c.json',journal:'.context/journal'});
  assert.throws(() => loadState(root), /repository-relative/);
  assert.throws(() => resolveCommand('fees-dry', {root}), /repository-relative/);
  assert.throws(() => describeCommands({root}), /repository-relative/);
});
