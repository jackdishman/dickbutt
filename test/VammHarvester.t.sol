// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./Support.sol";
import "../src/AerodromeVammHarvester.sol";

contract VammPoolMock is RewardMock {
    address public factory; address public token0; address public token1; bool public stable;
    bool public failClaim; bool public consumePrincipal;
    bool public attemptReentry; bool public blockedReentry;
    mapping(address=>uint256) public claimable0; mapping(address=>uint256) public claimable1;
    constructor(address f,address a,address b) {factory=f;token0=a;token1=b;}
    function setStable(bool s) external {stable=s;}
    function setPair(address a,address b) external {token0=a;token1=b;}
    function setFault(bool fail,bool consume) external {failClaim=fail;consumePrincipal=consume;}
    function setReentry(bool attempt) external {attemptReentry=attempt;}
    function accrue(address recipient,uint256 a,uint256 b) external {
        RewardMock(token0).mint(address(this),a);RewardMock(token1).mint(address(this),b);
        claimable0[recipient]+=a;claimable1[recipient]+=b;
    }
    function claimFees() external returns(uint256 a,uint256 b) {
        require(!failClaim,"claim failed");
        if(attemptReentry) {
            (bool ok,bytes memory result)=msg.sender.call(abi.encodeWithSignature("harvest()"));
            blockedReentry=!ok&&bytes4(result)==bytes4(keccak256("ReentrancyGuardReentrantCall()"));
            require(blockedReentry,"reentry guard did not reject callback");
        }
        a=claimable0[msg.sender];b=claimable1[msg.sender];
        claimable0[msg.sender]=0;claimable1[msg.sender]=0;
        if(consumePrincipal)_burn(msg.sender,1);
        if(a>0)require(IERC20(token0).transfer(msg.sender,a));
        if(b>0)require(IERC20(token1).transfer(msg.sender,b));
    }
}
contract VammFactoryMock {
    address public configured;
    bool public registered=true;
    function configure(address p,bool yes) external {configured=p;registered=yes;}
    function isPool(address p) external view returns(bool){return registered&&p==configured;}
    function getPool(address,address,bool) external view returns(address){return configured;}
}
contract VammHarvesterTest is Support {
    RewardMock d;RewardMock s;VammFactoryMock factory;VammPoolMock pool;AerodromeVammHarvester h;
    address constant BURN=address(0xDEAD);address constant DEST=address(0xA11CE);address constant OTHER=address(0xB0B);
    function setUp() public {
        vm.warp(100000);d=new RewardMock();s=new RewardMock();factory=new VammFactoryMock();
        pool=new VammPoolMock(address(factory),address(d),address(s));factory.configure(address(pool),true);
        h=deploy();
    }
    function deploy() internal returns(AerodromeVammHarvester){
        return new AerodromeVammHarvester(address(factory),address(pool),address(d),address(s),BURN,DEST,block.timestamp+365 days,3600,address(this));
    }
    function testFuzzClaimRoutesBothSidesWithoutConsumingLP(uint96 a,uint96 b) public {
        pool.mint(address(h),1000);pool.accrue(address(h),a,b);
        vm.prank(OTHER);h.harvest();
        eq(d.balanceOf(BURN),a);eq(s.balanceOf(DEST),b);eq(pool.balanceOf(address(h)),1000);
        eq(d.balanceOf(OTHER),0);eq(s.balanceOf(OTHER),0);
        vm.warp(h.lastHarvestAt()+3600);h.harvest();eq(d.balanceOf(BURN),a);eq(s.balanceOf(DEST),b);
    }
    function testRejectsWrongFactoryPairAndStablePool() public {
        factory.configure(address(pool),false);vm.expectRevert(bytes("wrong factory pool"));deploy();
        factory.configure(address(pool),true);pool.setStable(true);vm.expectRevert(bytes("requires volatile pool"));deploy();
        pool.setStable(false);pool.setPair(address(d),address(factory));vm.expectRevert(bytes("wrong pool tokens"));deploy();
        pool.setPair(address(s),address(d));AerodromeVammHarvester reversed=deploy();
        pool.accrue(address(reversed),31,72);reversed.harvest();eq(d.balanceOf(BURN),72);eq(s.balanceOf(DEST),31);
    }
    function testRescueCannotBypassLPLockAndOnlyOwnerCanWithdraw() public {
        pool.mint(address(h),1000);
        vm.expectRevert(bytes("protected token"));h.rescueToken(address(pool),OTHER,1);
        vm.expectRevert(bytes("protected token"));h.rescueToken(address(d),OTHER,1);
        vm.expectRevert(bytes("protected token"));h.rescueToken(address(s),OTHER,1);
        vm.expectRevert(bytes("still locked"));h.withdrawLiquidity(OTHER,1);
        vm.warp(h.unlockTime()-1);vm.expectRevert(bytes("still locked"));h.withdrawLiquidity(OTHER,1);
        vm.warp(h.unlockTime());vm.expectRevert();vm.prank(OTHER);h.withdrawLiquidity(OTHER,1);
        h.withdrawLiquidity(OTHER,400);eq(pool.balanceOf(OTHER),400);eq(pool.balanceOf(address(h)),600);
        vm.warp(h.unlockTime()+1);h.withdrawLiquidity(OTHER,600);eq(pool.balanceOf(OTHER),1000);
    }
    function testPermanentLockProtectsLaterContributionsButClaimsContinue() public {
        pool.mint(address(h),1000);h.lockForever();pool.mint(address(h),500);
        vm.warp(h.unlockTime()+1);vm.expectRevert(bytes("locked forever"));h.withdrawLiquidity(OTHER,1);
        vm.expectRevert(bytes("protected token"));h.rescueToken(address(pool),OTHER,1500);
        pool.accrue(address(h),10,20);h.harvest();eq(s.balanceOf(DEST),20);eq(pool.balanceOf(address(h)),1500);
    }
    function testClaimAndForwardFailuresRollBackAccounting() public {
        pool.mint(address(h),100);pool.accrue(address(h),10,20);s.setBlocked(DEST,true);
        vm.expectRevert();h.harvest();eq(h.lastHarvestAt(),0);eq(pool.claimable0(address(h)),10);
        eq(d.balanceOf(BURN),0);eq(s.balanceOf(DEST),0);
        s.setBlocked(DEST,false);pool.setFault(true,false);vm.expectRevert();h.harvest();eq(h.lastHarvestAt(),0);
        pool.setFault(false,true);vm.expectRevert(bytes("LP principal changed"));h.harvest();eq(pool.balanceOf(address(h)),100);
        pool.setFault(false,false);h.harvest();eq(d.balanceOf(BURN),10);eq(s.balanceOf(DEST),20);
    }
    function testDelayFreezeAndTwoStepOwnerHandoff() public {
        h.transferOwnership(OTHER);require(h.owner()==address(this));vm.prank(OTHER);h.acceptOwnership();
        vm.expectRevert();h.proposeDestination(OTHER);
        vm.prank(OTHER);h.proposeDestination(OTHER);uint256 ready=h.pendingDestinationReadyAt();
        vm.warp(ready-1);vm.expectRevert(bytes("still timelocked"));h.applyDestination();
        vm.warp(ready);h.applyDestination();require(h.spcxcDestination()==OTHER);
        vm.prank(OTHER);h.lockDestinationForever();
        vm.expectRevert(bytes("destination locked forever"));vm.prank(OTHER);h.proposeDestination(DEST);
    }
    function testCooldownBoundariesAndEmptyHarvestAreSafe() public {
        require(!h.holdsPosition());h.harvest();uint256 next=h.lastHarvestAt()+3600;
        pool.accrue(address(h),1,1);require(h.holdsPosition());
        vm.warp(next-1);vm.expectRevert(bytes("too soon"));h.harvest();
        vm.warp(next);h.harvest();eq(s.balanceOf(DEST),1);
        vm.warp(h.lastHarvestAt()+3601);h.harvest();eq(s.balanceOf(DEST),1);
    }
    function testNoLPRequiredToFlushPreviouslyBookedFeesOrDonations() public {
        pool.accrue(address(h),5,7);require(h.holdsPosition());h.harvest();require(!h.holdsPosition());
        d.mint(address(h),2);s.mint(address(h),3);require(h.holdsPosition());
        vm.warp(h.lastHarvestAt()+3600);h.harvest();eq(d.balanceOf(BURN),7);eq(s.balanceOf(DEST),10);
    }
    function testLockCanOnlyExtendAndBadRecipientsAreRejected() public {
        uint256 earlier=h.unlockTime()-1;
        vm.expectRevert(bytes("can only extend"));h.extendLock(earlier);
        uint256 next=h.unlockTime()+1 days;h.extendLock(next);eq(h.unlockTime(),next);
        vm.expectRevert(bytes("bad destination"));h.proposeDestination(address(pool));
        vm.expectRevert(bytes("bad destination"));h.proposeDestination(address(h));
        vm.expectRevert(bytes("bad destination"));h.proposeDestination(BURN);
        vm.expectRevert(bytes("bad destination"));h.proposeDestination(address(s));
        vm.expectRevert(bytes("bad destination"));h.proposeDestination(address(0));
        vm.expectRevert(bytes("bad destination"));
        new AerodromeVammHarvester(address(factory),address(pool),address(d),address(s),BURN,address(0),block.timestamp+365 days,3600,address(this));
    }

    function testPoolCallbackCannotReenterHarvest() public {
        pool.mint(address(h),100);pool.accrue(address(h),10,20);pool.setReentry(true);
        h.harvest();require(pool.blockedReentry());eq(pool.balanceOf(address(h)),100);
        eq(d.balanceOf(BURN),10);eq(s.balanceOf(DEST),20);
    }
}
