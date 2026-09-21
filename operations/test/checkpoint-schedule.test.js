import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {JOBS} from '../schedule.js';
import {renderCron,renderSystemd,parseScheduleArgs} from '../../script/render-schedule.mjs';

const base={workdir:'/srv/d',manifest:'m.json',calculator:'c.json',journal:'./data'};
const names=['calculate-and-propose','propose-pending','payout'];
const digest=value=>createHash('sha256').update(value).digest('hex');
function temporary(t) {
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'checkpoint schedule ')));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;
}

test('default renderer bytes are unchanged and never enable verification caching',()=>{
 // Captured from the parent revision before introducing the optional cache argument.
 assert.equal(digest(renderCron(JOBS,base)),'6c3284e01ac3cae2860674957fa643b44ec6f0de461b0d03d3be25664e7a79d0');
 assert.equal(digest(renderSystemd(JOBS,base)),'609355b50f81551f1b3a0d4e8fa59678b402748ac765fe31e48fa9cb2681913c');
 assert.equal(parseScheduleArgs([]).verificationCacheDir,undefined);
 assert.equal(parseScheduleArgs(['--verification-cache','../private/history']).verificationCacheDir,'../private/history');
});

test('only payout and the two proposer jobs receive an explicitly selected cache',()=>{
 for(const render of [renderCron,renderSystemd])for(const job of JOBS) {
  const output=render([job],{...base,verificationCacheDir:'../private/verified'});
  assert.equal(output.includes('--verification-cache'),names.includes(job.name),job.name);
  assert.equal(output.includes('../private/verified'),names.includes(job.name),job.name);
  assert.equal(output.includes('--allow-mainnet'),false);
 }
 const proposer=renderSystemd(JOBS.filter(j=>j.name==='calculate-and-propose'),{...base,verificationCacheDir:'../private/verified'});
 assert.ok(proposer.includes('--verification-cache \\"$$3\\"'),'cache must be a quoted third shell argument');
 assert.equal(JOBS.find(j=>j.name==='calculate-and-propose').command.length,6,'renderer must not mutate shared job definitions');
});

test('rendered commands pass malicious-looking cache paths literally to keeper alone',t=>{
 const literal="../private 'quotes' $HOME $(touch PWNED) `touch PWNED` ; ${MANIFEST} ${JOURNAL} $& %q";
 for(const name of names) {
  const dir=temporary(t),bin=path.join(dir,'bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir,'calculate-rewards.js'),"require('node:fs').writeFileSync('calculator.json',JSON.stringify(process.argv.slice(2)));\n");
  fs.writeFileSync(path.join(bin,'npm'),`#!${process.execPath}\nrequire('node:fs').writeFileSync('keeper.json',JSON.stringify(process.argv.slice(2)));\n`,{mode:0o700});
  const output=renderCron(JOBS.filter(j=>j.name===name),{...base,workdir:dir,verificationCacheDir:literal});
  const line=output.split('\n').find(value=>value.includes(' cd '));
  // Cron removes escaped percent signs before passing its command to the shell.
  const command=line.replace(/^\S+(?: \S+){4} /,'').replace(/ >> \/var\/log\/dickbutt\/[^ ]+ 2>&1$/,'').replaceAll('\\%','%');
  const result=spawnSync('/bin/sh',['-c',command],{cwd:dir,env:{PATH:`${bin}:${process.env.PATH}`},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
  const args=JSON.parse(fs.readFileSync(path.join(dir,'keeper.json')));
  assert.equal(args[args.indexOf('--verification-cache')+1],literal);
  assert.equal(args.filter(value=>value==='--verification-cache').length,1);
  assert.equal(fs.existsSync(path.join(dir,'PWNED')),false);
  if(name==='calculate-and-propose')assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'calculator.json'))),['--config','c.json']);
 }
});

test('systemd preserves literal dollars, percent signs, quotes and backslashes in the cache argument',()=>{
 const output=renderSystemd(JOBS.filter(j=>j.name==='calculate-and-propose'),{...base,verificationCacheDir:'../private $HOME%q "quoted"\\tail'});
 const exec=output.split('\n').find(line=>line.startsWith('ExecStart='));
 assert.ok(exec.includes('$$3'));assert.ok(exec.includes('$$HOME%%q'));
 assert.ok(exec.includes('\\"quoted\\"\\\\tail'));
});

test('cache path controls match other scheduler paths and cron rejects ambiguous backslashes',()=>{
 for(const value of ['',null,1,'private\0cache','private\rcache','private\ncache']) {
  for(const render of [renderCron,renderSystemd])assert.throws(()=>render(JOBS,{...base,verificationCacheDir:value}),/nonempty path without control characters/);
 }
 for(const value of ['private\0cache','private\rcache','private\ncache'])assert.throws(()=>parseScheduleArgs(['--verification-cache',value]),/control characters/);
 for(const args of [['--verification-cache'],['--verification-cache',''],['--verification-cache','--allow-mainnet']])assert.throws(()=>parseScheduleArgs(args),/missing value/);
 assert.throws(()=>renderCron(JOBS,{...base,verificationCacheDir:'../private\\%cache'}),/backslashes/);
 assert.doesNotThrow(()=>renderSystemd(JOBS,{...base,verificationCacheDir:'../private\\%cache'}));
});

test('verification-cache opt-in coexists with mainnet validation without extending its scope',t=>{
 const dir=temporary(t),address=i=>'0x'+i.toString(16).padStart(40,'0');
 const contracts=Object.fromEntries(['weth','usdc','dickbutt','spcxc','distributor','executor','feeRouter','clanker','aero','legacy'].map((key,i)=>[key,address(i+1)]));
 const roles=Object.fromEntries(['owner','keeper','proposer','guardian','ops','kcGreen','cdbVault','burnAddress'].map((key,i)=>[key,address(i+20)]));
 const manifest={chainId:8453,network:'base-mainnet',contracts,roles,quoter:address(50),sources:{aerodromeKind:'vamm',rewardsPool:address(51),rewardsFactory:address(52)}};
 const config={chainId:'8453',token:contracts.dickbutt,distributor:contracts.distributor,deployBlock:1,holderThresholdRaw:'6900000000000000000000000',payoutThresholdRaw:'1',curve:'linear',excluded:[...Object.values(contracts),...Object.values(roles),address(51)],batchSize:200,chunkSize:1000,finalityTag:'finalized'};
 fs.writeFileSync(path.join(dir,'m.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(dir,'c.json'),JSON.stringify(config));
 const options=parseScheduleArgs(['--workdir',dir,'--manifest','m.json','--calculator','c.json','--verification-cache','../private/history','--allow-mainnet']);
 for(const render of [renderCron,renderSystemd]) {
  const output=render(JOBS,options);
  assert.equal(output.match(/--allow-mainnet/g).length,5);assert.equal(output.match(/--verification-cache/g).length,3);
 }
 fs.writeFileSync(path.join(dir,'c.json'),JSON.stringify({...config,chainId:'84532'}));
 assert.throws(()=>renderSystemd(JOBS,options),/configuration chain|only on Base|chain/);
});
