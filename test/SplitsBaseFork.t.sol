// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./Support.sol";
import "../src/SplitsFeeRouter.sol";
import "../src/SpcxcSwapExecutor.sol";

interface SplitsForkVm {
    function envOr(string calldata,string calldata) external returns(string memory);
    function createSelectFork(string calldata,uint256) external returns(uint256);
    function skip(bool) external;
}
interface WarehouseForTest {
    function deposit(address,address,uint256) external payable;
    function balanceOf(address,uint256) external view returns(uint256);
}

/// @notice Genuine deployed PushSplit V2.2 factory, clones, and Warehouse on a pinned Base fork.
/// ERC20s are local mocks. This proves Splits integration, not real DICK/SPCXc policy or live swaps.
contract SplitsBaseForkTest is Support {
    address constant FACTORY=0x8E8eB0cC6AE34A38B67D5Cf91ACa38f60bc3Ecf4;
    address constant WAREHOUSE=0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8;
    address constant KC=address(101); address constant BURN=address(0xdead); address constant CDB=address(103);
    RewardMock w; RewardMock d; RewardMock s; RewardMock u; SplitsFeeRouter f; SpcxcSwapExecutor executor;
    function setUp() public {
        SplitsForkVm fv=SplitsForkVm(address(vm));
        string memory rpc=fv.envOr("BASE_RPC_URL",string(""));
        if(bytes(rpc).length==0) { fv.skip(true); return; }
        fv.createSelectFork(rpc,51218068);
        w=new RewardMock(); d=new RewardMock(); s=new RewardMock(); u=new RewardMock();
        executor=new SpcxcSwapExecutor(address(w),address(s),address(u),address(104),address(u),100,200,1000,0,address(this));
        f=new SplitsFeeRouter(FACTORY,address(w),address(d),KC,BURN,CDB,address(executor));
    }
    function testProtocolFactoryOwnerConfigAndTokenSpecificRouting() public {
        require(IPushSplitV2(f.dickSplit()).FACTORY()==FACTORY,"factory");
        require(IPushSplitV2(f.wethSplit()).SPLITS_WAREHOUSE()==WAREHOUSE,"warehouse");
        require(IPushSplitV2(f.dickSplit()).owner()==address(0),"mutable");
        require(IPushSplitV2(f.wethSplit()).owner()==address(0),"mutable");
        SplitsV2.Split memory cfg=f.dickSplitConfig();
        require(IPushSplitV2(f.dickSplit()).splitHash()==keccak256(abi.encode(cfg)),"config hash");
        address dickSplit=f.dickSplit();
        vm.expectRevert(); IPushSplitV2(dickSplit).updateSplit(cfg);
        d.mint(address(f),1001); w.mint(address(f),1001);
        vm.prank(address(999)); f.splitDickbutt();
        eq(d.balanceOf(KC),100); eq(d.balanceOf(BURN),900); eq(d.balanceOf(f.dickSplit()),1);
        eq(w.balanceOf(address(f)),1001);
        vm.prank(address(999)); f.splitWeth();
        eq(w.balanceOf(KC),100); eq(w.balanceOf(CDB),100); eq(w.balanceOf(address(executor)),800);
        eq(w.balanceOf(f.wethSplit()),1); eq(w.balanceOf(address(f)),0);
    }
    function testDustAndWarehouseBalancesRemainAtProtocolDestinations() public {
        w.mint(address(f),12); f.splitWeth();
        eq(w.balanceOf(KC),1); eq(w.balanceOf(CDB),1); eq(w.balanceOf(address(executor)),8); eq(w.balanceOf(f.wethSplit()),2);
        w.mint(address(this),101); w.approve(WAREHOUSE,101); WarehouseForTest(WAREHOUSE).deposit(f.wethSplit(),address(w),101);
        f.splitWeth();
        eq(w.balanceOf(KC),11); eq(w.balanceOf(CDB),11); eq(w.balanceOf(address(executor)),88);
        eq(WarehouseForTest(WAREHOUSE).balanceOf(f.wethSplit(),uint256(uint160(address(w)))),1);
        eq(w.balanceOf(f.wethSplit()),2);
    }
    function testWarehouseOnlyFundsStillDistributeAndRetainOneRawUnit() public {
        w.mint(address(this),101); w.approve(WAREHOUSE,101);
        WarehouseForTest(WAREHOUSE).deposit(f.wethSplit(),address(w),101);
        f.splitWeth();
        eq(w.balanceOf(KC),10); eq(w.balanceOf(CDB),10); eq(w.balanceOf(address(executor)),80);
        eq(w.balanceOf(f.wethSplit()),0);
        eq(WarehouseForTest(WAREHOUSE).balanceOf(f.wethSplit(),uint256(uint160(address(w)))),1);
        w.setPaused(true); f.splitWeth();
    }
    function testUpstreamRecipientFailureRollsBackTheWholeRoute() public {
        w.mint(address(f),1001); w.setBlocked(CDB,true);
        vm.expectRevert(); f.splitWeth();
        eq(w.balanceOf(address(f)),1001); eq(w.balanceOf(f.wethSplit()),0);
        eq(w.balanceOf(KC),0); eq(w.balanceOf(CDB),0); eq(w.balanceOf(address(executor)),0);
        w.setBlocked(CDB,false); f.splitWeth();
        eq(w.balanceOf(KC),100); eq(w.balanceOf(CDB),100); eq(w.balanceOf(address(executor)),800);
    }
    function testRejectsModifiedDistributionAndAdapterHasNoArbitraryTokenRoute() public {
        SplitsV2.Split memory cfg=f.wethSplitConfig(); cfg.recipients[2]=address(999);
        address wethSplit=f.wethSplit();
        vm.expectRevert(); IPushSplitV2(wethSplit).distribute(cfg,address(w),address(999));
        (bool ok,)=address(f).call(abi.encodeWithSignature("route(address,address)",address(d),f.wethSplit()));
        require(!ok,"arbitrary route exposed");
        s.mint(address(f),5); f.splitDickbutt(); f.splitWeth(); eq(s.balanceOf(address(f)),5);
    }
    function testEmptyAndProtocolReserveOnlyDoNotAttemptTokenTransfers() public {
        d.setPaused(true); w.setPaused(true);
        f.splitDickbutt(); f.splitWeth();
        d.setPaused(false); w.setPaused(false);
        d.mint(f.dickSplit(),1); w.mint(f.wethSplit(),1);
        d.setPaused(true); w.setPaused(true);
        f.splitDickbutt(); f.splitWeth();
        eq(d.balanceOf(f.dickSplit()),1); eq(w.balanceOf(f.wethSplit()),1);
    }
    function testRejectsZeroDuplicateAndNonContractConfiguration() public {
        vm.expectRevert(); new SplitsFeeRouter(address(1),address(w),address(d),KC,BURN,CDB,address(executor));
        vm.expectRevert(); new SplitsFeeRouter(FACTORY,address(w),address(w),KC,BURN,CDB,address(executor));
        vm.expectRevert(); new SplitsFeeRouter(FACTORY,address(w),address(d),address(0),BURN,CDB,address(executor));
        vm.expectRevert(); new SplitsFeeRouter(FACTORY,address(w),address(d),KC,BURN,KC,address(executor));
        vm.expectRevert(); new SplitsFeeRouter(FACTORY,address(w),address(d),KC,BURN,CDB,address(999));
    }
    function testFuzzProtocolRoundingAndConservation(uint128 raw) public {
        uint256 amount=uint256(raw)+1; w.mint(address(f),amount); f.splitWeth();
        uint256 distributable=amount-1;
        eq(w.balanceOf(KC),distributable/10); eq(w.balanceOf(CDB),distributable/10);
        eq(w.balanceOf(address(executor)),distributable*8/10);
        eq(w.balanceOf(KC)+w.balanceOf(CDB)+w.balanceOf(address(executor))+w.balanceOf(f.wethSplit()),amount);
    }
}
