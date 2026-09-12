// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./Support.sol";
import "../src/DickbuttRewardsDistributor.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
interface JsonVm {
    function readFile(string calldata) external view returns(string memory);
    function parseJsonBytes32(string calldata,string calldata) external pure returns(bytes32);
    function parseJsonStringArray(string calldata,string calldata) external pure returns(string[] memory);
    function parseJsonBytes32Array(string calldata,string calldata) external pure returns(bytes32[] memory);
    function parseAddress(string calldata) external pure returns(address);
    function parseUint(string calldata) external pure returns(uint256);
    function toString(uint256) external pure returns(string memory);
}
contract GoldenMerkleTest is Support {
    JsonVm constant jvm=JsonVm(address(vm));
    bytes32 constant ROOT=0x9e81f6914730ecd3c3caa0cf91c1108ea2ac95b8dbd270f15affd3575bf3238c;
    function testCommittedGoldenVectorsExecuteInActualDistributor() public {
        string memory json=jvm.readFile("test/fixtures/merkle-42.json");
        require(jvm.parseJsonBytes32(json,".root")==ROOT,"golden root changed");
        RewardMock token=new RewardMock();
        DickbuttRewardsDistributor d=new DickbuttRewardsDistributor(address(token),0,address(this));
        token.mint(address(d),6000000); d.setKeeper(address(this),true);
        for(uint256 i=1;i<42;i++){ d.proposeRound(bytes32(i),1); d.cancelPendingRound(i); }
        eq(d.proposeRound(ROOT,6000000),42); vm.warp(block.timestamp+6 hours); d.activateRound(42);
        address[] memory a=new address[](3); uint256[] memory n=new uint256[](3); bytes32[][] memory p=new bytes32[][](3);
        for(uint256 i;i<3;i++){
            string memory base=string.concat(".entries[",jvm.toString(i),"]");
            string[] memory value=jvm.parseJsonStringArray(json,string.concat(base,".value"));
            a[i]=jvm.parseAddress(value[1]); n[i]=jvm.parseUint(value[2]);
            p[i]=jvm.parseJsonBytes32Array(json,string.concat(base,".proof"));
            bytes32 leaf=keccak256(bytes.concat(keccak256(abi.encode(uint256(42),a[i],n[i]))));
            require(leaf==jvm.parseJsonBytes32(json,string.concat(base,".leaf")),"leaf mismatch");
            require(MerkleProof.verify(p[i],ROOT,leaf));
            require(!MerkleProof.verify(p[i],ROOT,keccak256(bytes.concat(keccak256(abi.encode(uint256(43),a[i],n[i]))))));
            require(!MerkleProof.verify(p[i],ROOT,keccak256(bytes.concat(keccak256(abi.encode(uint256(42),address(4),n[i]))))));
            require(!MerkleProof.verify(p[i],ROOT,keccak256(bytes.concat(keccak256(abi.encode(uint256(42),a[i],n[i]+1))))));
            require(!MerkleProof.verify(p[i],ROOT,keccak256(bytes.concat(keccak256(abi.encodePacked(uint256(42),a[i],n[i]))))));
        }
        d.distributeBatch(42,a,n,p); d.distributeBatch(42,a,n,p);
        for(uint256 i;i<3;i++)eq(token.balanceOf(a[i]),n[i]);
        eq(d.totalReserved(),0); d.closeRound(42);
    }
    function testFuzzMerkleSingleLeaf(uint256 id,address account,uint96 amount) public pure {
        bytes32 root=keccak256(bytes.concat(keccak256(abi.encode(id,account,uint256(amount)))));
        bytes32[] memory proof=new bytes32[](0);
        require(MerkleProof.verify(proof,root,root));
        bytes32 packedLeaf = keccak256(bytes.concat(keccak256(abi.encodePacked(id, account, uint256(amount)))));
        require(!MerkleProof.verify(proof, root, packedLeaf));
    }
}
