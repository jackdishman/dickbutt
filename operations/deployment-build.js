import fs from 'node:fs';
import path from 'node:path';
import { keccak256, toUtf8Bytes } from 'ethers';

/** Load the complete build before signing, and refuse artifacts compiled from different sources. */
export function loadDeploymentBuild(root, names) {
  const artifacts = {};
  for (const name of names) {
    const file = path.join(root, 'out', `${name}.sol`, `${name}.json`);
    if (!fs.existsSync(file)) throw Error(`artifact not found for ${name}; run forge build`);
    const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
    const metadata = artifact.metadata;
    if (!Array.isArray(artifact.abi) || !/^0x(?:[a-fA-F0-9]{2})+$/.test(artifact.bytecode?.object ?? '')
      || !metadata?.sources || !Object.keys(metadata.sources).length
      || metadata.settings?.compilationTarget?.[`src/${name}.sol`] !== name) {
      throw Error(`invalid deployment artifact for ${name}; rebuild the reviewed source`);
    }
    for (const [relative, source] of Object.entries(metadata.sources)) {
      const sourcePath = path.resolve(root, relative);
      if (!sourcePath.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(sourcePath)
        || keccak256(fs.readFileSync(sourcePath)) !== source.keccak256) {
        throw Error(`stale deployment artifact for ${name}: ${relative}; run forge build`);
      }
    }
    artifacts[name] = artifact;
  }
  const buildHash = keccak256(toUtf8Bytes(JSON.stringify(names.map(name => [name,
    artifacts[name].abi, artifacts[name].bytecode.object, artifacts[name].metadata]))));
  return { artifacts, buildHash };
}

/** Hash decoded deployment inputs, including off-chain eligibility and exclusions. */
export function hashDeploymentInputs(inputs) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
      : value;
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(inputs))));
}

export function verifyResumeBuild(progress, buildHash, inputHash) {
  if (!progress.buildHash || progress.buildHash !== buildHash) {
    throw Error('deployment build changed or was not recorded; inspect the partial deployment before continuing');
  }
  if (inputHash !== undefined && (!progress.inputHash || progress.inputHash !== inputHash)) {
    throw Error('deployment inputs changed or were not recorded; inspect the partial deployment before continuing');
  }
}
