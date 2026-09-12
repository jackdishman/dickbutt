// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./Support.sol";
import "../src/SpcxcSwapExecutor.sol";

/// @dev Router and ERC20 mocks isolate our executor protections; this is not a live swap integration test.
contract ExecutorRouterMock {
    RewardMock public input;
    RewardMock public output;
    uint256 public mode;
    uint256 public minimum;
    uint256 public allowanceSeen;
    bytes public path;
    constructor(RewardMock w, RewardMock s) { input=w; output=s; }
    function setMode(uint256 m) external { mode=m; }
    function exactInput(ISpcxcSwapRouter.ExactInputParams calldata p) external payable returns(uint256) {
        minimum=p.amountOutMinimum; allowanceSeen=input.allowance(msg.sender,address(this)); path=p.path;
        input.transferFrom(msg.sender,address(this),mode==2 ? p.amountIn-1 : p.amountIn);
        if(mode!=1) output.mint(p.recipient,p.amountIn*2);
        return p.amountIn*2;
    }
}

contract SwapExecutorTest is Support {
    RewardMock w; RewardMock s; RewardMock u; ExecutorRouterMock r; SpcxcSwapExecutor e;
    address constant DIST=address(104);
    function setUp() public {
        w=new RewardMock(); s=new RewardMock(); u=new RewardMock(); r=new ExecutorRouterMock(w,s);
        e=new SpcxcSwapExecutor(address(w),address(s),address(r),DIST,address(u),100,200,1000,60,address(this));
        e.setKeeper(address(this),true); vm.warp(1000); e.setPriceFloor(1e18,2000);
    }
    function testSwapsWholeCappedAllocationToFixedDistributor() public {
        w.mint(address(e),2000); eq(e.processWeth(0,1100),2000);
        eq(w.balanceOf(address(e)),1000); eq(s.balanceOf(DIST),2000);
        eq(r.allowanceSeen(),1000); eq(w.allowance(address(e),address(r)),0); eq(r.minimum(),1000);
        require(keccak256(r.path())==keccak256(abi.encodePacked(address(w),int24(100),address(u),int24(200),address(s))),"wrong path");
        vm.expectRevert(); e.processWeth(0,1100);
        vm.warp(1060); e.processWeth(0,1100); eq(s.balanceOf(DIST),4000);
    }
    function testRejectsLyingOutputAndIncompleteInputWithAtomicRollback() public {
        w.mint(address(e),1000);
        for(uint256 mode=1;mode<=2;mode++) { r.setMode(mode); vm.expectRevert(); e.processWeth(0,1100); eq(w.balanceOf(address(e)),1000); eq(s.balanceOf(DIST),0); eq(w.allowance(address(e),address(r)),0); }
    }
    function testDeadlineExpiryFloorRoundingAndStricterKeeperMinimum() public {
        w.mint(address(e),1); vm.expectRevert(); e.processWeth(0,999);
        e.setPriceFloor(1,1100); vm.expectRevert(); e.processWeth(3,1100);
        e.processWeth(0,1100); eq(r.minimum(),1);
        vm.warp(1101); w.mint(address(e),1); vm.expectRevert(); e.processWeth(0,1200);
    }
    function testKeeperAndOwnerBoundariesAndProtectedTokens() public {
        vm.prank(address(999)); vm.expectRevert(); e.processWeth(0,1100);
        vm.prank(address(999)); vm.expectRevert(); e.setPriceFloor(1,1100);
        vm.prank(address(999)); vm.expectRevert(); e.setKeeper(address(999),true);
        vm.expectRevert(); e.setPriceFloor(0,1100);
        vm.expectRevert(); e.setPriceFloor(1,block.timestamp+1 days+1);
        vm.expectRevert(); e.setSwapLimits(0,0);
        vm.expectRevert(); e.rescueToken(address(w),DIST,1);
        vm.expectRevert(); e.rescueToken(address(s),DIST,1);
        u.mint(address(e),5); e.rescueToken(address(u),DIST,5); eq(u.balanceOf(DIST),5);
        s.mint(address(e),7); vm.prank(address(999)); e.forwardSpcxc(); eq(s.balanceOf(DIST),7);
        e.setKeeper(address(this),false); vm.expectRevert(); e.processWeth(0,1100);
    }
    function testMissingFloorFailsClosedAndInvalidRouteRejected() public {
        SpcxcSwapExecutor fresh=new SpcxcSwapExecutor(address(w),address(s),address(r),DIST,address(u),100,200,1000,0,address(this));
        fresh.setKeeper(address(this),true); w.mint(address(fresh),5); vm.expectRevert(); fresh.processWeth(0,1100);
        vm.expectRevert(); new SpcxcSwapExecutor(address(w),address(s),address(r),DIST,address(w),100,200,1000,0,address(this));
        vm.expectRevert(); new SpcxcSwapExecutor(address(w),address(s),address(r),DIST,address(u),-1,200,1000,0,address(this));
        vm.expectRevert(); new SpcxcSwapExecutor(address(w),address(s),address(r),address(0),address(u),100,200,1000,0,address(this));
    }
    function testFuzzWholeAllocation(uint128 raw) public {
        uint256 amount=uint256(raw)+1; e.setSwapLimits(amount,0); w.mint(address(e),amount);
        e.processWeth(0,1100); eq(s.balanceOf(DIST),amount*2); eq(w.balanceOf(address(e)),0);
    }
}
