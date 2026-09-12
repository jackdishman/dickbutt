import fs from 'node:fs';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { AbiCoder, keccak256 } from 'ethers';
const values = ['1','2','3'].map((digit,i)=>['42',`0x${digit.repeat(40)}`,String((i+1)*1000000)]);
const tree = StandardMerkleTree.of(values,['uint256','address','uint256']);
const fixture = {types:['uint256','address','uint256'],root:tree.root,entries:[...tree.entries()].map(([i,value])=>({value,leaf:keccak256(keccak256(AbiCoder.defaultAbiCoder().encode(['uint256','address','uint256'],value))),proof:tree.getProof(i)}))};
fs.mkdirSync('test/fixtures',{recursive:true});
fs.writeFileSync('test/fixtures/merkle-42.json',JSON.stringify(fixture,null,2)+'\n');
