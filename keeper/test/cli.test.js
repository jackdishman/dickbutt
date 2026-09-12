import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeeperArgs } from '../../script/run-keeper.mjs';
test('CLI defaults to read-only and requires reviewed config and journal paths',()=>{const options=parseKeeperArgs(['--config','config.json','--journal','data']);assert.equal(options.execute,false);assert.equal(options.propose,false);assert.equal(options.configPath,'config.json');assert.equal(options.dir,'data');assert.throws(()=>parseKeeperArgs([]),/config/);});
test('CLI requires separate explicit transaction and proposal flags',()=>{const base=['--config','config.json','--journal','data'];assert.throws(()=>parseKeeperArgs([...base,'--propose']),/execute/);assert.equal(parseKeeperArgs([...base,'--execute']).propose,false);assert.equal(parseKeeperArgs([...base,'--execute','--propose']).propose,true);assert.throws(()=>parseKeeperArgs([...base,'--private-key','secret']),/unknown/);});

test('CLI waits for a peer on the same signer by default and accepts an explicit bound',()=>{const base=['--config','config.json','--journal','data'];assert.equal(parseKeeperArgs(base).lockWaitSeconds,300);assert.equal(parseKeeperArgs([...base,'--lock-wait','0']).lockWaitSeconds,0);assert.throws(()=>parseKeeperArgs([...base,'--lock-wait','-1']),/lock wait/);assert.throws(()=>parseKeeperArgs([...base,'--lock-wait']),/missing value/);});
