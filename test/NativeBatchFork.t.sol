// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./BaseFork.t.sol";
interface BatchVm is ForkVm {
    function envOr(string calldata,bool) external returns(bool);
    function cool(address) external;
}
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
        _runBatch(256,256,8,256);
    }
    function testNative400RecipientBatchExceedsCurrentTransactionGasCap() public {
        uint256 used=_runBatch(400,512,9,400);
        // A permissive local fork can execute this call, but a public Base transaction cannot
        // fit it inside the 2^24 transaction cap, even before calldata/intrinsic overhead.
        require(used>16_777_216,"expected oversized native-token batch");
    }
    function testNative3000RecipientRoundInBatchesAndIdempotentRepeat() public {
        _runBatch(3000,4096,12,256);
    }
    function testNative3000RecipientRoundAt200PerBatch() public {
        _runBatch(3000,4096,12,200);
    }
    function testNative3000RecipientRoundAt200PerBatchWithZeroDelay() public {
        _runBatch(3000,4096,12,200,0);
    }
    function _runBatch(uint256 count,uint256 leafCount,uint256 depth,uint256 batchSize) private returns(uint256 used) {
        return _runBatch(count,leafCount,depth,batchSize,24 hours);
    }
    function _runBatch(uint256 count,uint256 leafCount,uint256 depth,uint256 batchSize,uint256 delay) private returns(uint256 used) {
        DickbuttRewardsDistributor d=new DickbuttRewardsDistributor(SPCXC,1,address(this));d.setKeeper(address(this),true);
        d.setRoundDelay(delay);
        vm.prank(0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E);require(IERC20(SPCXC).transfer(address(d),count*2000),"funding failed");
        bytes32[] memory nodes=new bytes32[](leafCount*2);address[] memory accounts=new address[](count);uint256[] memory amounts=new uint256[](count);
        bytes32[][] memory proofs=new bytes32[][](count);
        for(uint256 i;i<count;i++){accounts[i]=address(uint160(0xBEF00000+i));amounts[i]=1000;require(IERC20(SPCXC).balanceOf(accounts[i])==0,"recipient already funded");nodes[leafCount+i]=keccak256(bytes.concat(keccak256(abi.encode(uint256(1),accounts[i],amounts[i]))));}
        for(uint256 i=leafCount-1;i>0;i--){bytes32 a=nodes[i*2];bytes32 b=nodes[i*2+1];nodes[i]=a<b?keccak256(abi.encodePacked(a,b)):keccak256(abi.encodePacked(b,a));}
        for(uint256 i;i<count;i++){proofs[i]=new bytes32[](depth);uint256 index=leafCount+i;for(uint256 j;j<depth;j++){proofs[i][j]=nodes[index^1];index/=2;}}
        d.proposeRound(nodes[1],count*1000);
        // Read the stored deadline: solc may rematerialize a local block.timestamp expression
        // after the vm.warp cheatcode, although no real transaction changes its own timestamp.
        (,,uint256 readyAt)=d.pending(1);vm.warp(readyAt);d.activateRound(1);
        uint256 maxBatchGas;
        uint256 maxConservativeTransactionGas;
        uint256 batches;
        for(uint256 offset; offset<count; offset+=batchSize) {
            uint256 size=count-offset<batchSize?count-offset:batchSize;
            address[] memory batchAccounts=new address[](size);
            uint256[] memory batchAmounts=new uint256[](size);
            bytes32[][] memory batchProofs=new bytes32[][](size);
            for(uint256 i;i<size;i++) {
                batchAccounts[i]=accounts[offset+i];batchAmounts[i]=amounts[offset+i];batchProofs[i]=proofs[offset+i];
            }
            // Exclude the test caller's ABI encoding/memory growth from the timed region.
            // Reset warmed accesses from setup and earlier batches; do not alter stored values.
            bytes memory payload=abi.encodeCall(d.distributeBatch,(1,batchAccounts,batchAmounts,batchProofs));
            vm.cool(address(d));vm.cool(SPCXC);vm.cool(0x8453000000000000000000000000000000000002);
            uint256 start=gasleft();(bool success,)=address(d).call(payload);
            uint256 batchGas=start-gasleft();used+=batchGas;
            require(success,"native payout batch reverted");
            if(batchGas>maxBatchGas)maxBatchGas=batchGas;
            // Upper-bound calldata at 16 gas/byte, plus the 21,000 base transaction cost.
            // This is a fork sizing check, not an L1-data fee or production gas quote.
            uint256 conservativeTransactionGas=batchGas+21_000+payload.length*16;
            if(conservativeTransactionGas>maxConservativeTransactionGas)maxConservativeTransactionGas=conservativeTransactionGas;
            if(count==3000&&batchSize==200)require(conservativeTransactionGas<16_777_216,"200-recipient batch lacks gas headroom");
            batches++;
            // Re-submit the same completed batch, as a keeper might after losing its receipt.
            d.distributeBatch(1,batchAccounts,batchAmounts,batchProofs);
        }
        for(uint256 i;i<count;i++)require(d.paid(1,accounts[i])&&IERC20(SPCXC).balanceOf(accounts[i])==1000,"recipient mismatch");
        d.closeRound(1);require(d.totalReserved()==0&&IERC20(SPCXC).balanceOf(address(d))==count*1000,"reserve mismatch");
        require(batches==(count+batchSize-1)/batchSize,"batch count mismatch");
        require(block.timestamp==readyAt,"unexpected payment delay");
        emit log_named_uint("configured extra review seconds",delay);
        emit log_named_uint("native SPCXc recipients",count);emit log_named_uint("payout batches",batches);
        emit log_named_uint("maximum batch execution gas excluding transaction overhead",maxBatchGas);
        emit log_named_uint("maximum call gas plus conservative intrinsic gas",maxConservativeTransactionGas);
        emit log_named_uint("distribution execution gas excluding transaction overhead",used);emit log_named_uint("fork block gas limit",block.gaslimit);
    }
}
