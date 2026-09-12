// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./Support.sol";
import "../src/DickbuttRewardsDistributor.sol";

contract DistributorTest is Support {
    RewardMock token;
    DickbuttRewardsDistributor d;
    address constant ALICE = address(0x1111);
    function setUp() public {
        token = new RewardMock();
        d = new DickbuttRewardsDistributor(address(token), 0, address(this));
        d.setKeeper(address(this), true);
        token.mint(address(d), 100);
    }
    function leaf(uint256 id, address a, uint256 n) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(id, a, n))));
    }
    function pay(uint256 id, uint256 n) internal {
        address[] memory accounts = new address[](1); accounts[0] = ALICE;
        uint256[] memory amounts = new uint256[](1); amounts[0] = n;
        bytes32[][] memory proofs = new bytes32[][](1); proofs[0] = new bytes32[](0);
        d.distributeBatch(id, accounts, amounts, proofs);
    }
    function testPendingReservesFunds() public {
        d.proposeRound(leaf(1, ALICE, 100), 100);
        eq(d.availableForNextRound(), 0);
        vm.expectRevert(); d.proposeRound(leaf(2, ALICE, 100), 100);
    }
    function testThresholdChangeCannotStrandCommittedLeaf() public {
        d.proposeRound(leaf(1, ALICE, 10), 10);
        d.setMinPayout(20);
        vm.warp(block.timestamp + 6 hours); d.activateRound(1); pay(1, 10);
        eq(token.balanceOf(ALICE), 10);
    }
    function testBlockedTransferRetryAndDuplicate() public {
        d.proposeRound(leaf(1, ALICE, 10), 10);
        vm.warp(block.timestamp + 6 hours); d.activateRound(1);
        token.setBlocked(ALICE, true); pay(1, 10);
        require(!d.paid(1, ALICE)); eq(token.balanceOf(ALICE), 0);
        token.setBlocked(ALICE, false); pay(1, 10); pay(1, 10);
        eq(token.balanceOf(ALICE), 10); d.closeRound(1);
        eq(d.availableForNextRound(), 90);
    }
    function testCancelPendingReleasesAndRecordsPlan() public {
        bytes32 root = leaf(1, ALICE, 40);
        d.proposeRound(root, 40); eq(d.totalReserved(), 40);
        d.cancelPendingRound(1); eq(d.totalReserved(), 0);
        (bytes32 stored,uint256 total,,bool active,bool closed) = d.roundInfo(1);
        require(stored == root && total == 40 && !active && closed);
        vm.expectRevert(); d.activateRound(1);
        vm.expectRevert(); d.cancelPendingRound(1);
    }
    function testConcurrentPendingActiveEarlyClose() public {
        d.proposeRound(leaf(1, ALICE, 30), 30);
        d.proposeRound(leaf(2, ALICE, 70), 70);
        vm.expectRevert(); d.activateRound(1);
        vm.warp(block.timestamp + 6 hours); d.activateRound(1);
        eq(d.totalReserved(), 100); pay(1, 30); eq(d.totalReserved(), 70);
        d.activateRound(2); d.closeRound(2); eq(d.totalReserved(), 0);
        eq(d.availableForNextRound(), 70);
    }
    function testInvalidCrossRoundProofAndKeeperRemoval() public {
        d.proposeRound(leaf(1, ALICE, 10), 10);
        d.proposeRound(leaf(1, ALICE, 10), 10);
        vm.warp(block.timestamp + 6 hours); d.activateRound(1); d.activateRound(2);
        vm.expectRevert(); pay(2,10);
        vm.expectRevert(); pay(1,11);
        d.setKeeper(address(this),false); vm.expectRevert(); pay(1,10);
        vm.expectRevert(); d.executeTransfer(ALICE,10);
        vm.expectRevert(); d.rescueToken(address(token),ALICE,1);
    }
    function testUnauthorizedLifecycle() public {
        vm.prank(ALICE); vm.expectRevert(); d.proposeRound(leaf(1,ALICE,10),10);
        d.proposeRound(leaf(1,ALICE,10),10);
        vm.prank(ALICE); vm.expectRevert(); d.cancelPendingRound(1);
        vm.warp(block.timestamp+6 hours); vm.prank(ALICE); d.activateRound(1);
        vm.prank(ALICE); vm.expectRevert(); d.closeRound(1);
        vm.prank(ALICE); vm.expectRevert(); d.setKeeper(ALICE,true);
    }
    function testFuzzBatchOrderPartialRetry(uint96 rawA,uint96 rawB,bool reverse,bool blocked) public {
        uint256 a=uint256(rawA)+1; uint256 b=uint256(rawB)+1;
        token.mint(address(d),a+b);
        address bob=address(0x2222);
        bytes32 la=leaf(1,ALICE,a); bytes32 lb=leaf(1,bob,b);
        bytes32 root=la<lb?keccak256(abi.encodePacked(la,lb)):keccak256(abi.encodePacked(lb,la));
        d.proposeRound(root,a+b); vm.warp(block.timestamp+6 hours); d.activateRound(1);
        address[] memory accounts=new address[](2); uint256[] memory amounts=new uint256[](2);
        bytes32[][] memory proofs=new bytes32[][](2);
        uint256 ai=reverse?1:0; uint256 bi=1-ai;
        accounts[ai]=ALICE; accounts[bi]=bob; amounts[ai]=a; amounts[bi]=b;
        proofs[ai]=new bytes32[](1); proofs[ai][0]=lb; proofs[bi]=new bytes32[](1); proofs[bi][0]=la;
        token.setBlocked(ALICE,blocked); d.distributeBatch(1,accounts,amounts,proofs);
        eq(d.totalReserved(),blocked?a:0); token.setBlocked(ALICE,false);
        d.distributeBatch(1,accounts,amounts,proofs); d.distributeBatch(1,accounts,amounts,proofs);
        eq(token.balanceOf(ALICE),a); eq(token.balanceOf(bob),b); eq(d.totalReserved(),0);
        vm.prank(bob); d.closeRound(1);
    }
    function testMalformedRootOverspendRollsBackEntireBatch() public {
        address bob=address(0x2222); bytes32 la=leaf(1,ALICE,60); bytes32 lb=leaf(1,bob,60);
        bytes32 root=la<lb?keccak256(abi.encodePacked(la,lb)):keccak256(abi.encodePacked(lb,la));
        token.mint(address(d),100); d.proposeRound(root,100); d.proposeRound(leaf(2,ALICE,100),100);
        vm.warp(block.timestamp+6 hours); d.activateRound(1);
        address[] memory accounts=new address[](2); accounts[0]=ALICE; accounts[1]=bob;
        uint256[] memory amounts=new uint256[](2); amounts[0]=60; amounts[1]=60;
        bytes32[][] memory proofs=new bytes32[][](2); proofs[0]=new bytes32[](1); proofs[1]=new bytes32[](1);
        proofs[0][0]=lb; proofs[1][0]=la;
        vm.expectRevert(bytes("round overspend")); d.distributeBatch(1,accounts,amounts,proofs);
        eq(token.balanceOf(ALICE),0); eq(token.balanceOf(bob),0); eq(d.totalReserved(),200);
        require(!d.paid(1,ALICE) && !d.paid(1,bob));
    }
    function testDuplicateAccountAndPauseRetry() public {
        d.proposeRound(leaf(1,ALICE,10),10); vm.warp(block.timestamp+6 hours); d.activateRound(1);
        token.setPaused(true); pay(1,10); eq(d.totalReserved(),10);
        token.setPaused(false);
        address[] memory accounts=new address[](2); accounts[0]=ALICE; accounts[1]=ALICE;
        uint256[] memory amounts=new uint256[](2); amounts[0]=10; amounts[1]=10;
        bytes32[][] memory proofs=new bytes32[][](2); proofs[0]=new bytes32[](0); proofs[1]=new bytes32[](0);
        d.distributeBatch(1,accounts,amounts,proofs); eq(token.balanceOf(ALICE),10);
    }
}
