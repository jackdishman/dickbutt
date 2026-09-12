import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, describeCommands, resolveCommand, validatePath } from '../commands.js';

test('read and local commands run without the execute flag; write commands do not', () => {
  for (const command of COMMANDS.filter(c => c.kind !== 'write')) {
    assert.doesNotThrow(() => resolveCommand(command.id, {}), `${command.id} should run read-only`);
  }
  for (const command of COMMANDS.filter(c => c.kind === 'write')) {
    assert.throws(() => resolveCommand(command.id, {}), /read-only/, `${command.id} should be gated`);
  }
});

test('a write command needs both the flag and a matching confirmation', () => {
  assert.throws(() => resolveCommand('fees-execute', { allowWrite: true }), /confirmation required/);
  assert.throws(() => resolveCommand('fees-execute', { allowWrite: true, confirm: 'yes' }), /confirmation required/);
  const { argv } = resolveCommand('fees-execute', { allowWrite: true, confirm: 'fees-execute' });
  assert.deepEqual(argv, ['npm', 'run', 'fees', '--', '--config', 'config/deployment-sepolia.json', '--execute']);
});

// Nothing from the browser may reach a command line, so paths are validated, never concatenated.
test('path inputs reject traversal, absolute paths and option lookalikes', () => {
  for (const bad of ['../../etc/passwd', '/etc/passwd', '--execute', 'a/../../b', 'x;rm -rf /', 'a b']) {
    assert.throws(() => validatePath(bad, 'Config'), /must be a repository-relative path|must not traverse/, `accepted ${bad}`);
  }
  assert.equal(validatePath('config/deployment-sepolia.json', 'Config'), 'config/deployment-sepolia.json');
  assert.equal(validatePath('.context/journal', 'Journal'), '.context/journal');
});

test('a choice input only accepts its declared choices', () => {
  assert.throws(() => resolveCommand('schedule', { inputs: { format: 'yaml' } }), /must be one of/);
  assert.deepEqual(resolveCommand('schedule', { inputs: { format: 'cron' } }).argv.at(-1), 'cron');
});

test('optional inputs may be empty and then contribute no flag', () => {
  const { argv } = resolveCommand('monitor', { inputs: { config: 'config/deployment-sepolia.json', journal: '' } });
  assert.ok(!argv.includes('--journal'));
});

test('the calculator receives its data directory through the environment, not a flag', () => {
  const { argv, env } = resolveCommand('calculate', { inputs: { calculator: 'a.json', journal: '.context/journal' } });
  assert.ok(!argv.includes('--journal'));
  assert.equal(env.CALCULATOR_DATA_DIR, '.context/journal');
});

test('unknown commands are refused rather than guessed at', () => {
  assert.throws(() => resolveCommand('rm-rf', {}), /unknown command/);
});

test('describeCommands never leaks an environment value, only its presence', () => {
  const described = describeCommands({ allowWrite: false, env: { RPC_URL: 'https://secret.example/key' } });
  const serialized = JSON.stringify(described);
  assert.ok(!serialized.includes('secret.example'));
  const monitor = described.find(command => command.id === 'monitor');
  assert.deepEqual(monitor.needs, [{ name: 'RPC_URL', present: true }]);
  assert.equal(described.find(command => command.id === 'fees-execute').runnable, false);
});

test('every write command explains its blast radius before it can be run', () => {
  for (const command of COMMANDS.filter(c => c.kind === 'write')) {
    assert.ok(command.danger, `${command.id} has no danger note`);
    assert.ok(command.needs?.length, `${command.id} declares no required environment`);
  }
});
