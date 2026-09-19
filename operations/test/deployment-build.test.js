import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keccak256 } from 'ethers';
import { loadDeploymentBuild, verifyResumeBuild, hashDeploymentInputs } from '../deployment-build.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'src/Example.sol'), artifactFile = path.join(root, 'out/Example.sol/Example.json');
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.mkdirSync(path.dirname(artifactFile), { recursive: true });
  fs.writeFileSync(source, 'contract Example {}');
  const artifact = { abi: [], bytecode: { object: '0x6000' }, metadata: {
    sources: { 'src/Example.sol': { keccak256: keccak256(fs.readFileSync(source)) } },
    settings: { compilationTarget: { 'src/Example.sol': 'Example' } },
  } };
  fs.writeFileSync(artifactFile, JSON.stringify(artifact));
  return { root, source, artifactFile, artifact };
}

test('source edits invalidate stale compiled deployment artifacts before signing', t => {
  const f = fixture(t);
  const initial = loadDeploymentBuild(f.root, ['Example']);
  verifyResumeBuild({ buildHash: initial.buildHash }, initial.buildHash);
  fs.appendFileSync(f.source, '\n// newly reviewed source');
  assert.throws(() => loadDeploymentBuild(f.root, ['Example']), /stale deployment artifact/);
});

test('resuming with changed bytecode or no pinned build is refused', t => {
  const f = fixture(t), before = loadDeploymentBuild(f.root, ['Example']);
  f.artifact.bytecode.object = '0x6001'; fs.writeFileSync(f.artifactFile, JSON.stringify(f.artifact));
  const after = loadDeploymentBuild(f.root, ['Example']);
  assert.throws(() => verifyResumeBuild({ buildHash: before.buildHash }, after.buildHash), /build changed/);
  assert.throws(() => verifyResumeBuild({}, after.buildHash), /not recorded/);
});

test('every planned artifact must exist and have deployable linked bytecode', t => {
  const f = fixture(t);
  assert.throws(() => loadDeploymentBuild(f.root, ['Example', 'Missing']), /artifact not found/);
  f.artifact.bytecode.object = '0x'; fs.writeFileSync(f.artifactFile, JSON.stringify(f.artifact));
  assert.throws(() => loadDeploymentBuild(f.root, ['Example']), /invalid deployment artifact/);
});

test('recovery refuses changed calculator inputs even when contract bytecode is identical', t => {
  const f = fixture(t), { buildHash } = loadDeploymentBuild(f.root, ['Example']);
  const original = '0x' + 'aa'.repeat(32), changed = '0x' + 'bb'.repeat(32);
  assert.throws(() => verifyResumeBuild({ buildHash, inputHash: original }, buildHash, changed), /inputs changed/);
  assert.throws(() => verifyResumeBuild({ buildHash }, buildHash, original), /inputs.*not recorded/);
  verifyResumeBuild({ buildHash, inputHash: original }, buildHash, original);
});

test('input identity ignores JSON key order but pins exclusions, thresholds and array order', () => {
  const config = { excluded: ['pool-a', 'pool-b'], curve: 'linear' };
  const params = { holderThresholdRaw: '6900000', batchSize: 200 };
  const original = hashDeploymentInputs({ config, params });
  assert.equal(original, hashDeploymentInputs({ params: { batchSize: 200, holderThresholdRaw: '6900000' }, config }));
  for (const changed of [
    { config: { ...config, excluded: ['pool-a'] }, params },
    { config: { ...config, excluded: ['pool-b', 'pool-a'] }, params },
    { config, params: { ...params, holderThresholdRaw: '1' } },
  ]) assert.notEqual(original, hashDeploymentInputs(changed));
});
