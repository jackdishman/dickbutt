import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeeperArgs } from '../../script/run-keeper.mjs';
test('CLI defaults to read-only and requires reviewed config and journal paths',()=>{const options=parseKeeperArgs(['--config','config.json','--journal','data']);assert.equal(options.execute,false);assert.equal(options.propose,false);assert.equal(options.configPath,'config.json');assert.equal(options.dir,'data');assert.throws(()=>parseKeeperArgs([]),/config/);});
test('CLI requires separate explicit transaction and proposal flags',()=>{const base=['--config','config.json','--journal','data'];assert.throws(()=>parseKeeperArgs([...base,'--propose']),/execute/);assert.equal(parseKeeperArgs([...base,'--execute']).propose,false);assert.equal(parseKeeperArgs([...base,'--execute','--propose']).propose,true);assert.throws(()=>parseKeeperArgs([...base,'--private-key','secret']),/unknown/);});
