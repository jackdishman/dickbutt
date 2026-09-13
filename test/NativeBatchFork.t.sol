// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./BaseFork.t.sol";
interface BatchVm is ForkVm {function envOr(string calldata,bool) external returns(bool);}
contract NativeBatchForkTest {
    BatchVm constant vm=BatchVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant SPCXC=0xb2000000000000000000007b9fcbd005511aCBd5;
    event log_named_uint(string key,uint256 value);
    function setUp() public {
        string memory rpc=vm.envOr("BASE_RPC_URL",string(""));
        if(bytes(rpc).length==0||!vm.envOr("BASE_NATIVE_TESTS",false)){vm.skip(true);return;}
        vm.createSelectFork(rpc,51223062);
    }
    function testNative256RecipientBatchAndIdempotentRepeat() public {
        _runBatch(256,256,8);
    }
    function testNative400RecipientBatchExceedsCurrentTransactionGasCap() public {
        uint256 used=_runBatch(400,512,9);
        // A permissive local fork can execute this call, but a public Base transaction cannot
        // fit it inside the 2^24 transaction cap, even before calldata/intrinsic overhead.
        require(used>16_777_216,"expected oversized native-token batch");
    }
    function _runBatch(uint256 count,uint256 leafCount,uint256 depth) private returns(uint256 used) {
        DickbuttRewardsDistributor d=new DickbuttRewardsDistributor(SPCXC,1,address(this));d.setKeeper(address(this),true);
        vm.prank(0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E);require(IERC20(SPCXC).transfer(address(d),count*2000),"funding failed");
        bytes32[] memory nodes=new bytes32[](leafCount*2);address[] memory accounts=new address[](count);uint256[] memory amounts=new uint256[](count);
        bytes32[][] memory proofs=new bytes32[][](count);
        for(uint256 i;i<count;i++){accounts[i]=address(uint160(0xBEF00000+i));amounts[i]=1000;require(IERC20(SPCXC).balanceOf(accounts[i])==0,"recipient already funded");nodes[leafCount+i]=keccak256(bytes.concat(keccak256(abi.encode(uint256(1),accounts[i],amounts[i]))));}
        for(uint256 i=leafCount-1;i>0;i--){bytes32 a=nodes[i*2];bytes32 b=nodes[i*2+1];nodes[i]=a<b?keccak256(abi.encodePacked(a,b)):keccak256(abi.encodePacked(b,a));}
        for(uint256 i;i<count;i++){proofs[i]=new bytes32[](depth);uint256 index=leafCount+i;for(uint256 j;j<depth;j++){proofs[i][j]=nodes[index^1];index/=2;}}
        d.proposeRound(nodes[1],count*1000);vm.warp(block.timestamp+24 hours);d.activateRound(1);
        uint256 start=gasleft();d.distributeBatch(1,accounts,amounts,proofs);used=start-gasleft();
        for(uint256 i;i<count;i++)require(d.paid(1,accounts[i])&&IERC20(SPCXC).balanceOf(accounts[i])==1000,"recipient mismatch");
        d.distributeBatch(1,accounts,amounts,proofs);
        for(uint256 i;i<count;i++)require(IERC20(SPCXC).balanceOf(accounts[i])==1000,"duplicate payment");
        d.closeRound(1);require(d.totalReserved()==0&&IERC20(SPCXC).balanceOf(address(d))==count*1000,"reserve mismatch");
        emit log_named_uint("native SPCXc recipients",count);emit log_named_uint("distribution execution gas excluding transaction overhead",used);emit log_named_uint("fork block gas limit",block.gaslimit);
    }
}
