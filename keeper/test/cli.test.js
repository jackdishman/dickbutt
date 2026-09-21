import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeeperArgs } from '../../script/run-keeper.mjs';
test('CLI defaults to read-only and requires reviewed config and journal paths',()=>{const options=parseKeeperArgs(['--config','config.json','--journal','data']);assert.equal(options.execute,false);assert.equal(options.propose,false);assert.equal(options.configPath,'config.json');assert.equal(options.dir,'data');assert.throws(()=>parseKeeperArgs([]),/config/);});
test('CLI requires separate explicit transaction and proposal flags',()=>{const base=['--config','config.json','--journal','data'];assert.throws(()=>parseKeeperArgs([...base,'--propose']),/execute/);assert.equal(parseKeeperArgs([...base,'--execute']).propose,false);assert.equal(parseKeeperArgs([...base,'--execute','--propose']).propose,true);assert.throws(()=>parseKeeperArgs([...base,'--private-key','secret']),/unknown/);});

test('CLI waits for a peer on the same signer by default and accepts an explicit bound',()=>{const base=['--config','config.json','--journal','data'];assert.equal(parseKeeperArgs(base).lockWaitSeconds,300);assert.equal(parseKeeperArgs([...base,'--lock-wait','0']).lockWaitSeconds,0);assert.throws(()=>parseKeeperArgs([...base,'--lock-wait','-1']),/lock wait/);assert.throws(()=>parseKeeperArgs([...base,'--lock-wait']),/missing value/);});

test('verification cache is opt-in and can be selected for a keyless dry run',()=>{
 const base=['--config','config.json','--journal','data'];
 assert.equal(parseKeeperArgs(base).verificationCacheDir,undefined);
 const options=parseKeeperArgs([...base,'--verification-cache','../private/verified']);
 assert.equal(options.verificationCacheDir,'../private/verified');
 assert.equal(options.execute,false);assert.equal(options.propose,false);assert.equal(options.allowMainnet,false);
 const live=parseKeeperArgs([...base,'--execute','--propose-only','--allow-mainnet','--verification-cache','../private/verified']);
 assert.equal(live.verificationCacheDir,'../private/verified');assert.equal(live.allowMainnet,true);assert.equal(live.proposeOnly,true);
});

test('verification cache paths remain literal and reject missing or control-character values',()=>{
 const base=['--config','config.json','--journal','data'];
 const literal="../private 'quotes' $HOME $(echo inert) ; ${JOURNAL} $& %q";
 assert.equal(parseKeeperArgs([...base,'--verification-cache',literal]).verificationCacheDir,literal);
 for(const value of ['','--execute'])assert.throws(()=>parseKeeperArgs([...base,'--verification-cache',value]),/missing value/);
 assert.throws(()=>parseKeeperArgs([...base,'--verification-cache']),/missing value/);
 for(const value of ['private\0cache','private\rcache','private\ncache'])assert.throws(()=>parseKeeperArgs([...base,'--verification-cache',value]),/control characters/);
});
