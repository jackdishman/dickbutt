import fs from 'node:fs';
import path from 'node:path';

const defaults = {
  manifest: 'config/deployment-sepolia.json',
  calculator: 'config/deployment-sepolia-calculator.json',
  journal: '.context/journal',
};

/** One explicit selection for both the flow diagram and operation forms. */
export function deploymentPaths(root = process.cwd()) {
  const file = path.join(root, 'config/console-deployment.json');
  if (!fs.existsSync(file)) return { ...defaults };
  const selected = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const name of Object.keys(defaults)) {
    const value = selected[name];
    if (typeof value !== 'string' || value.length > 200 ||
        !/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(value) || value.split('/').includes('..')) {
      throw Error(`console deployment ${name} must be a repository-relative path`);
    }
  }
  return Object.fromEntries(Object.keys(defaults).map(name => [name, selected[name]]));
}
