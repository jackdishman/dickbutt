import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCommand,describeCommands} from '../../ui/commands.js';

test('OPS-L-01: console local rehearsal defaults to the selected vAMM model',()=>{
  const c=resolveCommand('rehearse');
  assert.deepEqual(c.argv,['npm','run','rehearse','--','--vamm']);
  assert.equal(c.command.kind,'local');
  const described=describeCommands().find(c=>c.id==='rehearse');
  assert.equal(described.inputs.find(i=>i.name==='poolKind').default,'vamm');
});

test('OPS-L-01: historical Slipstream rehearsal remains an explicit choice',()=>{
  assert.deepEqual(resolveCommand('rehearse',{inputs:{poolKind:'slipstream'}}).argv,['npm','run','rehearse']);
  assert.throws(()=>resolveCommand('rehearse',{inputs:{poolKind:'unreviewed'}}),/must be one of/);
});
