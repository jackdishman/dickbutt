// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../src/SpcxcSwapExecutor.sol";
interface NativeSwapVm {
    function envOr(string calldata,string calldata) external returns(string memory);
    function envOr(string calldata,bool) external returns(bool);
    function createSelectFork(string calldata,uint256) external returns(uint256);
    function skip(bool) external;
    function deal(address,uint256) external;
}
interface WrappedEther { function deposit() external payable; function transfer(address,uint256) external returns(bool); }
interface LiveQuoter { function quoteExactInput(bytes calldata,uint256) external returns(uint256,uint160[] memory,uint32[] memory,uint256); }
/// Run with Base's compatible Foundry: FOUNDRY_BASE=true BASE_NATIVE_TESTS=true BASE_RPC_URL=... base-forge test --match-contract RealSwapForkTest.
/// No token mocks, code etching, or production transactions. Native B20 requires Base precompile support.
contract RealSwapForkTest {
    NativeSwapVm constant vm=NativeSwapVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant WETH=0x4200000000000000000000000000000000000006;
    address constant USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant SPCXC=0xb2000000000000000000007b9fcbd005511aCBd5;
    function setUp() public {
        string memory rpc=vm.envOr("BASE_RPC_URL",string(""));
        if(bytes(rpc).length==0||!vm.envOr("BASE_NATIVE_TESTS",false)){vm.skip(true);return;}
        vm.createSelectFork(rpc,51218068);
    }
    function testNativeSpcxcActualTwoHopSwap() public {
        uint256 amount=0.001 ether;
        SpcxcSwapExecutor executor=new SpcxcSwapExecutor(WETH,SPCXC,0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F,address(this),USDC,1,10,amount,0,address(this));
        (uint256 quote,,,)=LiveQuoter(0x514c8B5f54112481E28028F1166Bd78501089259).quoteExactInput(executor.swapPath(),amount);
        require(quote>0,"no quote");
        executor.setKeeper(address(this),true);
        executor.setPriceFloor(quote*95/100*1e18/amount,block.timestamp+1 hours);
        vm.deal(address(this),amount);
        WrappedEther(WETH).deposit{value:amount}();
        WrappedEther(WETH).transfer(address(executor),amount);
        uint256 beforeOut=IERC20(SPCXC).balanceOf(address(this));
        uint256 received=executor.processWeth(quote*95/100,block.timestamp+60);
        require(received>=quote*95/100,"slippage");
        require(IERC20(SPCXC).balanceOf(address(this))-beforeOut==received,"receipt mismatch");
        require(IERC20(WETH).balanceOf(address(executor))==0,"input remains");
        require(IERC20(WETH).allowance(address(executor),address(executor.router()))==0,"allowance remains");
    }
}
