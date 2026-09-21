import fs from 'node:fs';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
const require=createRequire(`${process.cwd()}/package.json`);
const { keccak256, zeroPadValue, toBeHex }=require('ethers');
const base='audit/2026-09-20-final';
const buildFile=process.argv[2] || `${base}/compiler-build-info.json.gz`;
const input=fs.readFileSync(buildFile);
const raw=buildFile.endsWith('.gz') ? gunzipSync(input) : input;
const build=JSON.parse(raw);
const selected=['AerodromeVammHarvester','DickbuttRewardsDistributor','LegacyFeeHarvester','LockerHarvester','SpcxcSwapExecutor','SplitsFeeRouter'];
const nodes=new Map(), functionList=[], assembly=[];
function walk(v, visit) { if (!v || typeof v!=='object') return; if(v.nodeType)visit(v); for(const [key,x] of Object.entries(v))if(key!=='scope'&&x&&typeof x==='object')Array.isArray(x)?x.forEach(y=>walk(y,visit)):walk(x,visit); }
for (const [file,data] of Object.entries(build.output.sources)) {
 walk(data.ast,n=>{ if(n.id)nodes.set(n.id,{...n,file}); if(['FunctionDefinition','ModifierDefinition'].includes(n.nodeType)&&n.body)functionList.push({...n,file}); if(n.nodeType==='InlineAssembly')assembly.push({file,src:n.src,externalReferences:n.externalReferences,flags:n.flags,yulFunctions:n.AST?.statements?.filter(x=>x.nodeType==='YulFunctionDefinition').map(x=>x.name)||[]}); });
}
const funcs=new Map(functionList.map(n=>[n.id,n])); const graph=new Map(),external=[];
for(const fn of functionList){const edges=new Set();walk(fn.body,n=>{
 if(n.nodeType!=='FunctionCall')return; let e=n.expression; while(e?.nodeType==='FunctionCallOptions')e=e.expression;
 if(!e || !funcs.has(e.referencedDeclaration))return;
 if((e.typeDescriptions?.typeIdentifier||'').includes('t_function_external')) {external.push({caller:fn.id,target:e.referencedDeclaration});return;}
 edges.add(e.referencedDeclaration);
});for(const mod of fn.modifiers||[])if(funcs.has(mod.modifierName?.referencedDeclaration))edges.add(mod.modifierName.referencedDeclaration);graph.set(fn.id,[...edges]);}
const components=[];let index=0;const ix=new Map(),low=new Map(),stack=[],on=new Set();
function strong(v){ix.set(v,index);low.set(v,index++);stack.push(v);on.add(v);for(const w of graph.get(v)||[]){if(!ix.has(w)){strong(w);low.set(v,Math.min(low.get(v),low.get(w)));}else if(on.has(w))low.set(v,Math.min(low.get(v),ix.get(w)));}if(low.get(v)===ix.get(v)){let x;const c=[];do{x=stack.pop();on.delete(x);c.push(x);}while(x!==v);if(c.length>1||(graph.get(v)||[]).includes(v))components.push(c.map(id=>({id,name:funcs.get(id).name,file:funcs.get(id).file})));}}
for(const id of funcs.keys())if(!ix.has(id))strong(id);
const layouts={},opcodes={},dynamicBases=[];
for(const name of selected){const c=build.output.contracts[`src/${name}.sol`][name];layouts[name]=c.storageLayout;
 for(const e of c.storageLayout.storage){const type=c.storageLayout.types[e.type];if(['dynamic_array','bytes'].includes(type.encoding)){const hashed=keccak256(zeroPadValue(toBeHex(BigInt(e.slot)),32));dynamicBases.push({contract:name,label:e.label,slot:e.slot,base:hashed,distanceToWrap:((1n<<256n)-BigInt(hashed)).toString()});}}
 const bytes=Buffer.from(c.evm.deployedBytecode.object,'hex');const tail=bytes.readUInt16BE(bytes.length-2);const code=bytes.subarray(0,bytes.length-tail-2);let delegatecall=0,callcode=0,selfdestruct=0;for(let pc=0;pc<code.length;pc++){const op=code[pc];if(op===0xf4)delegatecall++;if(op===0xf2)callcode++;if(op===0xff)selfdestruct++;if(op>=0x60&&op<=0x7f)pc+=op-0x5f;}opcodes[name]={runtimeBytes:bytes.length,metadataBytes:tail+2,delegatecall,callcode,selfdestruct};
}
const textPatterns={};for(const [file,{content}]of Object.entries(build.input.sources)){if(!file.startsWith('src/'))continue;const stripped=content.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');textPatterns[file]={assembly:/\bassembly\b/.test(stripped),delegatecall:/\bdelegatecall\b/.test(stripped),transient:/\btransient\b|\btstore\b|\btload\b/.test(stripped),customLayout:/\blayout\s+at\b/.test(stripped)};}
const report={buildFile,buildSha256:crypto.createHash('sha256').update(raw).digest('hex'),compiler:build.solcVersion,settings:build.input.settings,sourceCount:Object.keys(build.input.sources).length,implementedFunctionsAndModifiers:functionList.length,directInternalGraphCycles:components,externalCallsExcludedFromInternalGraph:external.length,note:'AST declaration-reference graph is an adjunct to manual virtual/super dispatch analysis, not a proof about compiler-generated Yul. External calls use separate EVM frames and are deliberately excluded.',applicationTextPatterns:textPatterns,assembly,layouts,dynamicBases,runtimeOpcodeChecks:opcodes};
fs.writeFileSync(`${base}/compiler-structure-evidence.json`,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({compiler:report.compiler,sourceCount:report.sourceCount,implementedFunctionsAndModifiers:report.implementedFunctionsAndModifiers,cycles:components,assembly:assembly.map(x=>({file:x.file,src:x.src,yulFunctions:x.yulFunctions})),dynamicBases,opcodes},null,2));
