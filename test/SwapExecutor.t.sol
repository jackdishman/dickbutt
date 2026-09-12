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
    // The distributor must be a contract; any contract stands in for it here.
    address DIST;
    address constant OPS=address(0x0B5);
    address constant KEEPER2=address(0x4EE9);
    function setUp() public {
        w=new RewardMock(); s=new RewardMock(); u=new RewardMock(); r=new ExecutorRouterMock(w,s); DIST=address(new RewardMock());
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
        // An EOA distributor would strand every swap's output.
        vm.expectRevert(bytes("distributor not contract")); new SpcxcSwapExecutor(address(w),address(s),address(r),address(104),address(u),100,200,1000,0,address(this));
    }
    /// The floor setter is a hot key that can set the floor and nothing else, above the owner's bound.
    function testFloorSetterIsNarrowAndBoundedAndExclusiveWithKeeper() public {
        vm.prank(OPS); vm.expectRevert(bytes("not a floor setter")); e.setPriceFloor(1e18,1500);
        vm.expectRevert(bytes("bad floor setter")); e.setFloorSetter(address(0),true);
        // No setter may be approved while the bound is zero: an unbounded hot key cannot exist by omission.
        vm.expectRevert(bytes("set floor lower bound first")); e.setFloorSetter(OPS,true);
        e.setFloorLowerBound(1); e.setFloorSetter(OPS,true);
        vm.prank(OPS); e.setPriceFloor(15e17,1500); eq(e.minSpcxcPerWeth(),15e17);
        // Nothing administrative is reachable from the floor-setter key.
        vm.prank(OPS); vm.expectRevert(); e.setKeeper(OPS,true);
        vm.prank(OPS); vm.expectRevert(); e.setSwapLimits(1e30,0);
        vm.prank(OPS); vm.expectRevert(); e.setFloorSetter(OPS,false);
        vm.prank(OPS); vm.expectRevert(); e.setFloorLowerBound(0);
        vm.prank(OPS); vm.expectRevert(); e.rescueToken(address(u),OPS,0);
        vm.prank(OPS); vm.expectRevert(); e.transferOwnership(OPS);
        // The owner bound holds the setter above a deliberate minimum; the owner itself is not bound.
        e.setFloorLowerBound(1e18);
        vm.prank(OPS); vm.expectRevert(bytes("floor below owner bound")); e.setPriceFloor(1e18-1,1500);
        vm.prank(OPS); e.setPriceFloor(1e18,1500); eq(e.minSpcxcPerWeth(),1e18);
        e.setPriceFloor(1,1500); eq(e.minSpcxcPerWeth(),1);
        // One key must never both set the price and swap at it.
        vm.expectRevert(bytes("floor setter cannot be a keeper")); e.setFloorSetter(address(this),true);
        vm.expectRevert(bytes("keeper cannot be a floor setter")); e.setKeeper(OPS,true);
        e.setFloorSetter(OPS,false); e.setKeeper(OPS,true); vm.expectRevert(bytes("floor setter cannot be a keeper")); e.setFloorSetter(OPS,true);
        e.setKeeper(OPS,false); e.setKeeper(KEEPER2,false); e.setFloorSetter(KEEPER2,true); require(e.isFloorSetter(KEEPER2),"revoked keeper may become setter");
        vm.prank(OPS); vm.expectRevert(bytes("not a floor setter")); e.setPriceFloor(1e18,1500);
    }
    function testFuzzWholeAllocation(uint128 raw) public {
        uint256 amount=uint256(raw)+1; e.setSwapLimits(amount,0); w.mint(address(e),amount);
        e.processWeth(0,1100); eq(s.balanceOf(DIST),amount*2); eq(w.balanceOf(address(e)),0);
    }
}
