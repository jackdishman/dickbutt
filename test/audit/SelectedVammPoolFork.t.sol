// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../NativeVammFork.t.sol";

interface SelectedLivePool is VammLivePool {
    function getReserves() external view returns(uint256,uint256,uint256);
}
interface SelectedFactory is VammLiveFactory {
    function getFee(address,bool) external view returns(uint256);
    function isPaused() external view returns(bool);
}
/// Actual user-selected public pool at a pinned state. All deployments, signatures,
/// impersonation, trades and time advances are LOCAL ONLY. No live LP is transferred.
contract SelectedVammPoolForkTest {
    VammForkVm constant vm=VammForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant PINNED=51612143;
    address constant POOL=0xA044B7dD71993F47171A402dB8853c30A822f8D5;
    address constant LP_OWNER=0xDF3eFAfdA19D2dF229eF3fbEC73d2EE6C5fB6d7c;
    address constant SAFE=0xA15BDE99c19E908db4fa07abe4220De13CFbcF7b;
    address constant FACTORY=0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    address constant DICK=0x2D57C47BC5D2432FEEEdf2c9150162A9862D3cCf;
    address constant SPCXC=0xb2000000000000000000007b9fcbd005511aCBd5;
    address constant DICK_SOURCE=0x92d90f7f8413749Bd4BeA26ddE4e29efC9e9A0B6;
    address constant SPCXC_SOURCE=0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E;
    address constant BURN=address(0xdead);
    address constant KEEPER=address(0x501);
    address constant PROPOSER=address(0x502);
    address constant HOLDER=address(0x503);
    SelectedLivePool pool=SelectedLivePool(POOL);
    AerodromeVammHarvester h;
    DickbuttRewardsDistributor distributor;
    uint256 lp;
    event log_named_uint(string key,uint256 value);
    function setUp() public {
        string memory rpc=vm.envOr("BASE_RPC_URL",string(""));
        if(bytes(rpc).length==0||!vm.envOr("BASE_NATIVE_TESTS",false)){vm.skip(true);return;}
        vm.createSelectFork(rpc,PINNED);
        require(block.chainid==8453&&block.number==PINNED,"wrong pinned chain");
        require(pool.factory()==FACTORY&&SelectedFactory(FACTORY).isPool(POOL),"wrong factory");
        require(SelectedFactory(FACTORY).getPool(DICK,SPCXC,false)==POOL&&!pool.stable(),"wrong volatile pair");
        require(pool.token0()==DICK&&pool.token1()==SPCXC,"wrong tokens");
        require(SelectedFactory(FACTORY).getFee(POOL,false)==30&&!SelectedFactory(FACTORY).isPaused(),"fee/factory changed");
        lp=pool.balanceOf(LP_OWNER);
        require(lp==4286236718263509712,"LP snapshot mismatch");
        distributor=new DickbuttRewardsDistributor(SPCXC,1,address(this));
        distributor.setRoundDelay(0);distributor.setRoundLimits(5000,6 hours);
        distributor.setKeeper(KEEPER,true);distributor.setProposer(PROPOSER,true);
        // One-year unlock is only a TEST parameter, not a selected production lock decision.
        h=new AerodromeVammHarvester(FACTORY,POOL,DICK,SPCXC,BURN,address(distributor),block.timestamp+365 days,6 hours,address(this));
        h.transferOwnership(SAFE);vm.prank(SAFE);h.acceptOwnership();
        distributor.transferOwnership(SAFE);vm.prank(SAFE);distributor.acceptOwnership();
        require(h.owner()==SAFE&&distributor.owner()==SAFE,"local owner acceptance");
    }
    function handoff() internal {
        require(!h.holdsPosition(),"unfunded harvester has position");
        vm.prank(LP_OWNER);require(pool.transfer(address(h),lp),"local LP transfer");
        require(pool.balanceOf(LP_OWNER)==0&&pool.balanceOf(address(h))==lp&&h.holdsPosition(),"custody mismatch");
    }
    function trade(address token,uint256 amount) internal {
        uint256 output=pool.getAmountOut(amount,token);require(output>0,"zero quote");
        require(IERC20(token).transfer(POOL,amount),"input transfer");
        bool zeroIn=token==DICK;pool.swap(zeroIn?0:output,zeroIn?output:0,address(this),"");
    }
    function testSelectedPoolPriorFeesRemainClaimableByWallet() public {
        handoff();
        uint256 a=pool.claimable0(LP_OWNER);uint256 b=pool.claimable1(LP_OWNER);
        require(a>0&&b>0,"expected accumulated owner fees");
        vm.prank(address(0x777));(uint256 x,uint256 y)=h.harvest();
        require(x==0&&y==0,"old fees incorrectly moved with LP");
        uint256 before0=IERC20(DICK).balanceOf(LP_OWNER);uint256 before1=IERC20(SPCXC).balanceOf(LP_OWNER);
        vm.prank(LP_OWNER);(uint256 got0,uint256 got1)=pool.claimFees();
        require(got0==a&&got1==b,"past claim mismatch");
        require(IERC20(DICK).balanceOf(LP_OWNER)-before0==a&&IERC20(SPCXC).balanceOf(LP_OWNER)-before1==b,"past fees lost");
        require(pool.balanceOf(address(h))==lp,"claim consumed LP");
        emit log_named_uint("prior wallet DICKBUTT fees raw",a);emit log_named_uint("prior wallet SPCXc fees raw",b);
    }
    function testSelectedPoolThreeSixHourHarvestsAndHolderPayouts() public {
        handoff();
        // Existing real token balances moved only inside local state; no mock token code or minting.
        vm.prank(DICK_SOURCE);require(IERC20(DICK).transfer(address(this),3_000_000 ether));
        vm.prank(SPCXC_SOURCE);require(IERC20(SPCXC).transfer(address(this),3*1e8));
        uint256 totalBurned;uint256 totalFees;uint256 totalPaid;
        for(uint256 i;i<3;i++){
            vm.warp(block.timestamp+6 hours);
            trade(DICK,1_000_000 ether);trade(SPCXC,1e8);
            uint256 beforeBurn=IERC20(DICK).balanceOf(BURN);uint256 beforeReward=IERC20(SPCXC).balanceOf(address(distributor));
            vm.prank(address(0x777));(uint256 burned,uint256 reward)=h.harvest();
            require(burned>0&&reward>0,"missing fee side");
            require(IERC20(DICK).balanceOf(BURN)-beforeBurn==burned,"burn destination mismatch");
            require(IERC20(SPCXC).balanceOf(address(distributor))-beforeReward==reward,"reward destination mismatch");
            require(pool.balanceOf(address(h))==lp&&pool.balanceOf(LP_OWNER)==0,"LP principal changed");
            totalBurned+=burned;totalFees+=reward;
            uint256 id=distributor.nextRoundId();uint256 amount=distributor.maxProposableTotal();require(amount>0,"no payout");
            vm.prank(PROPOSER);distributor.proposeRound(keccak256(bytes.concat(keccak256(abi.encode(id,HOLDER,amount)))),amount);
            distributor.activateRound(id);
            address[] memory accounts=new address[](1);accounts[0]=HOLDER;
            uint256[] memory amounts=new uint256[](1);amounts[0]=amount;
            bytes32[][] memory proofs=new bytes32[][](1);proofs[0]=new bytes32[](0);
            vm.prank(KEEPER);distributor.distributeBatch(id,accounts,amounts,proofs);
            vm.prank(KEEPER);distributor.distributeBatch(id,accounts,amounts,proofs);
            distributor.closeRound(id);totalPaid+=amount;
            require(IERC20(SPCXC).balanceOf(HOLDER)==totalPaid,"duplicate or missing payout");
            require(distributor.totalReserved()==0,"reservation left over");
        }
        emit log_named_uint("three cycles DICKBUTT burned raw",totalBurned);
        emit log_named_uint("three cycles SPCXc collected raw",totalFees);
        emit log_named_uint("three cycles SPCXc holder paid raw",totalPaid);
        emit log_named_uint("preserved original LP raw",pool.balanceOf(address(h)));
    }
    function testSelectedPoolLockAndRecoveryAuthority() public {
        handoff();
        vm.expectRevert();vm.prank(LP_OWNER);h.withdrawLiquidity(LP_OWNER,1);
        vm.expectRevert();vm.prank(SAFE);h.withdrawLiquidity(LP_OWNER,1);
        vm.expectRevert();vm.prank(SAFE);h.rescueToken(POOL,LP_OWNER,1);
        vm.warp(h.unlockTime());
        vm.prank(SAFE);h.withdrawLiquidity(LP_OWNER,lp);
        require(pool.balanceOf(LP_OWNER)==lp&&pool.balanceOf(address(h))==0,"unlock transfer failed");
        vm.prank(LP_OWNER);require(pool.transfer(address(h),lp));
        vm.prank(SAFE);h.lockForever();
        vm.warp(block.timestamp+1 days);
        vm.expectRevert();vm.prank(SAFE);h.withdrawLiquidity(LP_OWNER,1);
        require(pool.balanceOf(address(h))==lp,"permanent lock lost LP");
    }
}
