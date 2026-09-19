import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JOBS } from '../../operations/schedule.js';
import { renderCron, renderSystemd, parseScheduleArgs } from '../../script/render-schedule.mjs';

// Execute the rendered scheduler command, using inert local executables rather than RPC or keys.
// The calculator probe reuses the actual CLI's data-directory selection expression verbatim.
const calculatorSource = fs.readFileSync(new URL('../../calculate-rewards.js', import.meta.url), 'utf8');
const dirSelection = calculatorSource.match(/const dir=path\.resolve\([^\n;]+\);/)[0];

function scheduledProposer(t, { journal = './data', inheritedDirectory, calculator = 'calculator.json' } = {}) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'audit schedule ')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'calculate-rewards.js'), `const fs=require('node:fs'),path=require('node:path');\n${dirSelection}\nfs.writeFileSync('calculator-observation.json',JSON.stringify({dir,args:process.argv.slice(2)}));\n`);
  fs.writeFileSync(path.join(cwd, 'keeper-probe.cjs'), `const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);fs.writeFileSync('keeper-observation.json',JSON.stringify({dir:path.resolve(args[args.indexOf('--journal')+1]),args}));\n`);
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({scripts:{keeper:'node keeper-probe.cjs'}}));
  const job = JOBS.find(j => j.name === 'calculate-and-propose');
  const rendered = renderCron([job], {workdir:cwd,manifest:'manifest.json',calculator,journal});
  // Remove only cron's timing fields and its external log redirect; all rendered command text runs.
  const command = rendered.split('\n').find(line => /^0 \*\/6 /.test(line)).replace(/^0 \*\/6 \* \* \* /,'').replace(/ >> \/var\/log\/dickbutt\/calculate-and-propose\.log 2>&1$/,'');
  const env = {PATH:process.env.PATH,HOME:process.env.HOME};
  if(inheritedDirectory!==undefined) env.CALCULATOR_DATA_DIR=inheritedDirectory;
  const child = spawnSync('/bin/sh',['-c',command],{cwd,env,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr || child.stdout);
  return {writer:JSON.parse(fs.readFileSync(path.join(cwd,'calculator-observation.json'))), reader:JSON.parse(fs.readFileSync(path.join(cwd,'keeper-observation.json'))), expected:path.resolve(cwd,journal)};
}

test('OPS-M-01: default rendered proposer writes the exact journal it subsequently reads', t => {
  const f=scheduledProposer(t);
  assert.equal(f.writer.dir,f.expected,'the selected scheduler journal must bind the calculator writer');
  assert.equal(f.reader.dir,f.expected);
});

test('OPS-M-01: selected journal overrides stale inherited calculator directory', t => {
  const f=scheduledProposer(t,{journal:'./selected-journal',inheritedDirectory:'./old-journal'});
  assert.equal(f.writer.dir,f.expected,'an inherited legacy data directory must not split the pipeline');
  assert.equal(f.reader.dir,f.expected);
});

test('OPS-M-01: renderer retains spaces in journal and calculator filenames', t => {
  const f=scheduledProposer(t,{journal:'./selected journal',calculator:'reviewed calculator.json'});
  assert.equal(f.writer.dir,f.expected);
  assert.equal(f.reader.dir,f.expected);
  assert.equal(f.writer.args[f.writer.args.indexOf('--config')+1],'reviewed calculator.json');
  assert.equal(f.reader.args[f.reader.args.indexOf('--config')+1],'reviewed calculator.json');
});

test('OPS-M-01: scheduler paths are literal arguments, never shell source', t => {
  const f=scheduledProposer(t,{journal:'./journal $(echo substituted) ; literal',calculator:"reviewed 'quotes' $HOME.json"});
  assert.equal(f.writer.dir,f.expected);
  assert.equal(f.reader.dir,f.expected);
  assert.equal(f.writer.args[f.writer.args.indexOf('--config')+1],"reviewed 'quotes' $HOME.json");
  assert.equal(f.reader.args[f.reader.args.indexOf('--config')+1],"reviewed 'quotes' $HOME.json");
});

test('OPS-M-01: systemd preserves shell positional dollars and percent filename characters', () => {
  const rendered=renderSystemd([JOBS.find(j=>j.name==='calculate-and-propose')],
    {workdir:'/srv/dickbutt',manifest:'manifest.json',calculator:'reviewed calculator.json',journal:'./100% journal'});
  const exec=rendered.split('\n').find(line=>line.startsWith('ExecStart='));
  assert.ok(exec.includes('$$1')&&exec.includes('$$2'),'systemd must not consume shell argument references');
  assert.ok(exec.includes('100%% journal'),'systemd must not interpret a filename percent as a specifier');
  assert.ok(!exec.includes('${JOURNAL}'));
});

test('scheduler rejects newlines in every path rather than rendering extra commands', () => {
  const jobs=[JOBS.find(j=>j.name==='calculate-and-propose')];
  const options={workdir:'/srv/dickbutt',manifest:'manifest.json',calculator:'calculator.json',journal:'./data'};
  for (const key of Object.keys(options)) {
    const bad={...options,[key]:options[key]+'\ninvalid'};
    assert.throws(()=>renderCron(jobs,bad),/control characters/);
    assert.throws(()=>renderSystemd(jobs,bad),/control characters/);
    assert.throws(()=>parseScheduleArgs([`--${key}`,bad[key]]),/control characters/);
  }
});

test('systemd working directory and environment path preserve spaces, dollars and percent signs',()=>{
  const text=renderSystemd([JOBS.find(j=>j.name==='calculate-and-propose')],
    {workdir:'/srv/selected work $HOME%q',manifest:'manifest.json',calculator:'calculator.json',journal:'./data'});
  assert.ok(text.includes('WorkingDirectory="/srv/selected work $HOME%%q"'));
  assert.ok(text.includes('EnvironmentFile="/srv/selected work $HOME%%q/env/proposer.env"'));
  assert.ok(!text.includes('WorkingDirectory="/srv/selected work $$HOME'),'dollar expansion is specific to ExecStart');
});

test('cron rejects ambiguous backslash paths while systemd retains literal support',()=>{
  const jobs=[JOBS.find(j=>j.name==='calculate-and-propose')];
  const options={workdir:'/srv/dickbutt',manifest:'manifest.json',calculator:'calculator.json',journal:'./data'};
  for(const key of Object.keys(options)) {
    const selected={...options,[key]:options[key]+'\\%suffix'};
    assert.throws(()=>renderCron(jobs,selected),/must not contain backslashes/);
    assert.doesNotThrow(()=>renderSystemd(jobs,selected));
  }
});
