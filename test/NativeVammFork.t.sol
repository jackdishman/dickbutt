// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./BaseFork.t.sol";
import "../src/AerodromeVammHarvester.sol";

interface VammForkVm is ForkVm {function envOr(string calldata,bool) external returns(bool);}
interface VammLivePool is IAerodromeVammPool {
    function mint(address) external returns(uint256);
    function getAmountOut(uint256,address) external view returns(uint256);
    function swap(uint256,uint256,address,bytes calldata) external;
}
interface VammLiveFactory is IAerodromeVammFactory {
    function createPool(address,address,bool) external returns(address);
}

/// All transactions run inside the local Base-native EVM, never against the upstream RPC.
contract NativeVammForkTest {
    VammForkVm constant vm=VammForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant DICK=0x2D57C47BC5D2432FEEEdf2c9150162A9862D3cCf;
    address constant SPCXC=0xb2000000000000000000007b9fcbd005511aCBd5;
    address constant FACTORY=0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    address constant LOCKER=0x2Ad4DB8ba8de03834DB14454Afcd74C2393d81C4;
    address constant SOURCE=0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E;
    address constant BURN=address(0xdead);
    event log_named_uint(string key,uint256 value);
    VammLivePool pool;AerodromeVammHarvester h;DickbuttRewardsDistributor distributor;
    uint256 lp;
    function setUp() public {
        string memory rpc=vm.envOr("BASE_RPC_URL",string(""));
        if(bytes(rpc).length==0||!vm.envOr("BASE_NATIVE_TESTS",false)){vm.skip(true);return;}
        vm.createSelectFork(rpc,51223062);
        vm.prank(LiveLocker(LOCKER).owner());LiveLocker(LOCKER).collectFees(address(this),1391176);
        vm.prank(SOURCE);require(IERC20(SPCXC).transfer(address(this),110*1e8));
        address p=VammLiveFactory(FACTORY).getPool(DICK,SPCXC,false);
        if(p==address(0))p=VammLiveFactory(FACTORY).createPool(DICK,SPCXC,false);
        pool=VammLivePool(p);
        require(IERC20(DICK).transfer(p,100_000_000 ether));require(IERC20(SPCXC).transfer(p,100*1e8));
        lp=pool.mint(address(this));require(lp>0,"no real LP");
        distributor=new DickbuttRewardsDistributor(SPCXC,1,address(this));
        h=new AerodromeVammHarvester(FACTORY,p,DICK,SPCXC,BURN,address(distributor),block.timestamp+365 days,3600,address(this));
    }
    function trade(address input,uint256 amount) internal {
        uint256 output=pool.getAmountOut(amount,input);require(output>0,"zero trade output");
        require(IERC20(input).transfer(address(pool),amount));
        bool zeroIn=input==pool.token0();pool.swap(zeroIn?0:output,zeroIn?output:0,address(this),"");
    }
    function testNativeVammThreeSixHourClaimsAndAutomaticHolderPush() public {
        require(!h.holdsPosition());require(pool.transfer(address(h),lp));h.lockForever();
        distributor.setKeeper(address(this),true);distributor.setRoundDelay(0);
        uint256 totalPaid;
        for(uint256 i;i<3;i++){
            vm.warp(block.timestamp+6 hours);
            trade(DICK,1_000_000 ether);trade(SPCXC,1e8);
            uint256 beforeBurn=IERC20(DICK).balanceOf(BURN);uint256 beforeReward=IERC20(SPCXC).balanceOf(address(distributor));
            vm.prank(address(0x777));h.harvest();
            require(IERC20(DICK).balanceOf(BURN)>beforeBurn,"DICKBUTT not burned");
            require(IERC20(SPCXC).balanceOf(address(distributor))>beforeReward,"SPCXc not forwarded");
            require(pool.balanceOf(address(h))==lp,"LP principal spent");
            uint256 amount=distributor.maxProposableTotal();address holder=address(0xBEEF);
            uint256 id=distributor.nextRoundId();
            distributor.proposeRound(keccak256(bytes.concat(keccak256(abi.encode(id,holder,amount)))),amount);
            distributor.activateRound(id);
            address[] memory a=new address[](1);a[0]=holder;uint256[] memory n=new uint256[](1);n[0]=amount;
            bytes32[][] memory proofs=new bytes32[][](1);proofs[0]=new bytes32[](0);
            distributor.distributeBatch(id,a,n,proofs);distributor.closeRound(id);totalPaid+=amount;
            require(IERC20(SPCXC).balanceOf(holder)==totalPaid,"holder payout mismatch");
        }
        vm.warp(h.unlockTime()+1);vm.expectRevert();h.withdrawLiquidity(address(this),1);
        vm.expectRevert();h.rescueToken(address(pool),address(this),1);
        emit log_named_uint("three-cycle actual SPCXc holder payout raw",totalPaid);
    }
    function testNativeVammPreviousFeesStayWithPriorOwnerAndTopUpsInheritLock() public {
        trade(DICK,1_000_000 ether);trade(SPCXC,1e8);
        require(pool.transfer(address(h),lp));
        uint256 old0=pool.claimable0(address(this));uint256 old1=pool.claimable1(address(this));
        require(old0>0&&old1>0,"no original owner fees");
        h.harvest();require(IERC20(SPCXC).balanceOf(address(distributor))==0,"old fees moved with LP");
        (uint256 a,uint256 b)=pool.claimFees();require(a==old0&&b==old1,"original owner lost fees");
        // A contributor mints LP directly to the harvester. It gains no withdrawal authority.
        require(IERC20(DICK).transfer(address(pool),1_000_000 ether));require(IERC20(SPCXC).transfer(address(pool),1e8));
        uint256 extra=pool.mint(address(h));require(extra>0&&pool.balanceOf(address(h))==lp+extra);
        vm.expectRevert();vm.prank(address(0xBAD));h.withdrawLiquidity(address(0xBAD),1);
        trade(DICK,1_000_000 ether);trade(SPCXC,1e8);
        // Transfer at unlock books the harvester's old fees; readiness must retain them with zero LP.
        vm.warp(h.unlockTime());h.withdrawLiquidity(address(this),lp+extra);
        require(pool.balanceOf(address(h))==0&&h.holdsPosition(),"last fees hidden");
        h.harvest();require(IERC20(SPCXC).balanceOf(address(distributor))>0,"final claim lost");
        require(!h.holdsPosition(),"unexpected leftover position");
    }
}
