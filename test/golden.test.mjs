import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { AbiCoder, keccak256, solidityPacked } from 'ethers';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/merkle-42.json',import.meta.url),'utf8'));
test('hardcoded JS Solidity golden vectors and negative encodings',()=>{
 const tree=StandardMerkleTree.of(fixture.entries.map(e=>e.value),fixture.types);
 assert.equal(tree.root,'0x9e81f6914730ecd3c3caa0cf91c1108ea2ac95b8dbd270f15affd3575bf3238c');
 assert.equal(tree.root,fixture.root);
 for(const entry of fixture.entries){
  assert.equal(keccak256(keccak256(AbiCoder.defaultAbiCoder().encode(fixture.types,entry.value))),entry.leaf);
  assert(StandardMerkleTree.verify(fixture.root,fixture.types,entry.value,entry.proof));
  for(const index of [0,1,2]){const wrong=[...entry.value];wrong[index]=index===1?'0x4444444444444444444444444444444444444444':(BigInt(wrong[index])+1n).toString();assert(!StandardMerkleTree.verify(fixture.root,fixture.types,wrong,entry.proof));}
  assert.notEqual(keccak256(keccak256(solidityPacked(fixture.types,entry.value))),entry.leaf);
 }
});
