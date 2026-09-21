// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../RealSwapFork.t.sol";

interface MarketVm is NativeSwapVm {
    function prank(address) external;
    function expectRevert() external;
    function snapshotState() external returns(uint256);
    function revertToState(uint256) external returns(bool);
}
/// Sensitivity experiment: an attacker holds inventory while independent bots quote an already
/// moved market. Capital and order are hypothetical, not selected production parameters.
contract FinalNativeMarketBoundsTest {
    MarketVm constant vm=MarketVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant WETH=0x4200000000000000000000000000000000000006;
    address constant USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant SPCXC=0xb2000000000000000000007b9fcbd005511aCBd5;
    ISpcxcSwapRouter constant ROUTER=ISpcxcSwapRouter(0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F);
    LiveQuoter constant QUOTER=LiveQuoter(0x514c8B5f54112481E28028F1166Bd78501089259);
    address constant KEEPER=address(0x1241);address constant OPS=address(0x1242);
    event log_named_uint(string key,uint256 value);
    event log_named_int(string key,int256 value);
    function setUp() public {
        string memory rpc=vm.envOr("BASE_RPC_URL",string(""));
        if(bytes(rpc).length==0||!vm.envOr("BASE_NATIVE_TESTS",false)){vm.skip(true);return;}
        vm.createSelectFork(rpc,51223062);
    }
    function testNativeMovedMarketSensitivityAtIndependentQuotedMinimums() public {
        uint256 snapshot=vm.snapshotState();
        uint256[4] memory victimAmounts=[uint256(0.001 ether),0.01 ether,0.1 ether,1 ether];
        for(uint256 i;i<victimAmounts.length;i++){
            if(i>0)require(vm.revertToState(snapshot));
            snapshot=vm.snapshotState();experiment(victimAmounts[i],1 ether);
        }
    }
    function testNativePremanipulationMinimumRejectsLargerPriceMove() public {
        uint256 victimAmount=1 ether;uint256 capital=10 ether;
        SpcxcSwapExecutor executor=new SpcxcSwapExecutor(WETH,SPCXC,address(ROUTER),address(this),USDC,1,10,victimAmount,0,address(this));
        executor.setKeeper(KEEPER,true);
        (uint256 cleanQuote,,,)=QUOTER.quoteExactInput(executor.swapPath(),victimAmount);
        executor.setPriceFloor(cleanQuote*95/100*1e18/victimAmount,block.timestamp+1 hours);
        vm.deal(address(this),capital+victimAmount);WrappedEther(WETH).deposit{value:capital+victimAmount}();
        require(IERC20(WETH).transfer(address(executor),victimAmount));
        require(IERC20(WETH).approve(address(ROUTER),capital));
        ROUTER.exactInput(ISpcxcSwapRouter.ExactInputParams(executor.swapPath(),address(this),block.timestamp,capital,0));
        (uint256 movedQuote,,,)=QUOTER.quoteExactInput(executor.swapPath(),victimAmount);
        require(movedQuote<cleanQuote*99/100,"experiment did not exceed 1 percent movement");
        uint256 beforeReward=IERC20(SPCXC).balanceOf(address(this));
        vm.expectRevert();vm.prank(KEEPER);executor.processWeth(cleanQuote*99/100,block.timestamp);
        require(IERC20(WETH).balanceOf(address(executor))==victimAmount,"failed trade consumed victim input");
        require(IERC20(WETH).allowance(address(executor),address(ROUTER))==0,"failed trade left approval");
        require(IERC20(SPCXC).balanceOf(address(this))==beforeReward,"failed trade changed reward balance");
    }
    function experiment(uint256 victimAmount,uint256 attackerCapital) internal {
        SpcxcSwapExecutor executor=new SpcxcSwapExecutor(WETH,SPCXC,address(ROUTER),address(this),USDC,1,10,victimAmount,0,address(this));
        executor.setKeeper(KEEPER,true);
        (uint256 cleanQuote,,,)=QUOTER.quoteExactInput(executor.swapPath(),victimAmount);
        uint256 initialFloor=cleanQuote*95/100*1e18/victimAmount;
        executor.setFloorLowerBound(initialFloor/2);executor.setFloorSetter(OPS,true);
        vm.prank(OPS);executor.setPriceFloor(initialFloor,block.timestamp+1 hours);
        vm.deal(address(this),attackerCapital+victimAmount);
        WrappedEther(WETH).deposit{value:attackerCapital+victimAmount}();
        require(IERC20(WETH).transfer(address(executor),victimAmount));
        uint256 beforeSpc=IERC20(SPCXC).balanceOf(address(this));
        require(IERC20(WETH).approve(address(ROUTER),attackerCapital));
        ROUTER.exactInput(ISpcxcSwapRouter.ExactInputParams(executor.swapPath(),address(this),block.timestamp,attackerCapital,0));
        uint256 attackerSpc=IERC20(SPCXC).balanceOf(address(this))-beforeSpc;
        (uint256 movedQuote,,,)=QUOTER.quoteExactInput(executor.swapPath(),victimAmount);
        uint256 movedFloor=movedQuote*95/100*1e18/victimAmount;
        uint256 delta=initialFloor>movedFloor?initialFloor-movedFloor:movedFloor-initialFloor;
        // Apply only changes which the current floor bot accepts without force and above owner bound.
        require(movedFloor>=executor.floorLowerBound()&&delta*10000/initialFloor<=5000,"outside ordinary floor bot range");
        vm.prank(OPS);executor.setPriceFloor(movedFloor,block.timestamp+1 hours);
        vm.prank(KEEPER);uint256 received=executor.processWeth(movedQuote*99/100,block.timestamp);
        require(received>=movedQuote*99/100,"minimum bypassed");
        require(IERC20(SPCXC).approve(address(ROUTER),attackerSpc));
        ROUTER.exactInput(ISpcxcSwapRouter.ExactInputParams(abi.encodePacked(SPCXC,int24(10),USDC,int24(1),WETH),address(this),block.timestamp,attackerSpc,0));
        uint256 finalWeth=IERC20(WETH).balanceOf(address(this));
        emit log_named_uint("hypothetical victim WETH wei",victimAmount);
        emit log_named_uint("attacker starting WETH wei",attackerCapital);
        emit log_named_uint("unmoved SPCXc quote raw",cleanQuote);
        emit log_named_uint("victim received SPCXc raw",received);
        emit log_named_int("attacker WETH change excluding gas and capital carrying costs",int256(finalWeth)-int256(attackerCapital));
    }
}
