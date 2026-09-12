// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./Support.sol";
import "../src/LockerHarvester.sol";
import "../src/AerodromeFeeHarvester.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract PositionMock is ERC721 {
    constructor() ERC721("Position", "POS") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    RewardMock public token0;
    RewardMock public token1;

    function configureFees(RewardMock t0, RewardMock t1) external {
        token0 = t0;
        token1 = t1;
    }

    function collect(INonfungiblePositionManager.CollectParams calldata p) external payable returns (uint256, uint256) {
        require(ownerOf(p.tokenId) == msg.sender, "not position owner");
        require(p.amount0Max == type(uint128).max && p.amount1Max == type(uint128).max, "wrong maxima");
        if (address(token0) != address(0)) {
            token0.mint(p.recipient, 13);
            token1.mint(p.recipient, 17);
            return (13, 17);
        }
        return (0, 0);
    }
}

contract LockerMock {
    address public owner;
    PositionMock public manager;
    uint256 public duration;
    uint256 public id;

    constructor(PositionMock m, uint256 i) {
        owner = msg.sender;
        manager = m;
        id = i;
        duration = block.timestamp + 365 days;
    }

    function transferOwnership(address to) external {
        require(msg.sender == owner);
        owner = to;
    }

    function released(address m) external view returns (uint256) {
        return m == address(manager) ? id : 0;
    }

    function end() external view returns (uint256) {
        return duration;
    }

    function release() external {
        require(block.timestamp >= duration);
        manager.transferFrom(address(this), owner, id);
    }
    address public recipient;

    function collectFees(address to, uint256 i) external {
        require(msg.sender == owner && i == id);
        recipient = to;
    }
}

contract HarvestersTest is Support {
    PositionMock m;
    RewardMock d;
    RewardMock s;
    AerodromeFeeHarvester a;

    function setUp() public {
        vm.warp(100000);
        m = new PositionMock();
        d = new RewardMock();
        s = new RewardMock();
        a = deploy(block.timestamp + 365 days, 1 hours);
        m.mint(address(this), 1);
        m.safeTransferFrom(address(this), address(a), 1);
    }

    function deploy(uint256 unlock, uint256 interval) internal returns (AerodromeFeeHarvester) {
        return new AerodromeFeeHarvester(
            address(m), 1, address(d), address(s), address(0xdead), address(123), unlock, interval, address(this)
        );
    }

    function testCollectedFeesRouteByTokenNotOrder() public {
        m.configureFees(s, d);
        a.harvest();
        eq(d.balanceOf(address(0xdead)), 17);
        eq(s.balanceOf(address(123)), 13);
        eq(d.balanceOf(address(a)), 0);
        eq(s.balanceOf(address(a)), 0);
    }

    function testRejectPastLock() public {
        vm.expectRevert();
        deploy(block.timestamp, 0);
    }

    function testRejectMillisecondsLock() public {
        vm.expectRevert();
        deploy((block.timestamp + 365 days) * 1000, 0);
    }

    function testRejectExcessiveInterval() public {
        vm.expectRevert();
        deploy(block.timestamp + 365 days, type(uint256).max);
    }

    function testRejectUnexpectedNFT() public {
        m.mint(address(this), 2);
        vm.expectRevert();
        m.safeTransferFrom(address(this), address(a), 2);
    }

    function testRejectUnexpectedManager() public {
        PositionMock other = new PositionMock();
        other.mint(address(this), 1);
        vm.expectRevert();
        other.safeTransferFrom(address(this), address(a), 1);
    }

    function testFreezeAllDestinationMutations() public {
        a.lockDestinationForever();
        vm.expectRevert();
        a.proposeDestination(address(456));
        vm.expectRevert();
        a.applyDestination();
        vm.expectRevert();
        a.cancelDestinationChange();
    }

    function testHarvestRoutesStraysAndInterval() public {
        d.mint(address(a), 9);
        s.mint(address(a), 11);
        vm.prank(address(888));
        a.harvest();
        eq(d.balanceOf(address(0xdead)), 9);
        eq(s.balanceOf(address(123)), 11);
        vm.expectRevert();
        a.harvest();
        vm.warp(block.timestamp + 1 hours);
        a.harvest();
    }

    function testDestinationTimelockCancel() public {
        a.proposeDestination(address(456));
        vm.expectRevert();
        a.applyDestination();
        a.cancelDestinationChange();
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert();
        a.applyDestination();
        a.proposeDestination(address(456));
        vm.warp(a.pendingDestinationReadyAt());
        vm.prank(address(888));
        a.applyDestination();
        require(a.spcxcDestination() == address(456));
    }

    function testProtectedRescue() public {
        vm.expectRevert();
        a.rescueToken(address(d), address(this), 0);
        vm.expectRevert();
        a.rescueToken(address(s), address(this), 0);
    }

    function testLockExtensionAndWithdrawal() public {
        vm.expectRevert();
        a.withdrawPosition(address(888));
        uint256 original = a.unlockTime();
        vm.expectRevert();
        a.extendLock(original);
        uint256 later = a.unlockTime() + 1 days;
        a.extendLock(later);
        vm.warp(later);
        a.withdrawPosition(address(888));
        require(m.ownerOf(1) == address(888));
    }

    function testPermanentLock() public {
        a.lockForever();
        vm.warp(a.unlockTime() + 1);
        vm.expectRevert();
        a.withdrawPosition(address(888));
        vm.expectRevert();
        a.extendLock(block.timestamp + 1 days);
    }

    function testRejectZeroAndEOAAddresses() public {
        vm.expectRevert();
        new AerodromeFeeHarvester(
            address(0),
            1,
            address(d),
            address(s),
            address(0xdead),
            address(123),
            block.timestamp + 365 days,
            0,
            address(this)
        );
        vm.expectRevert();
        new AerodromeFeeHarvester(
            address(999),
            1,
            address(d),
            address(s),
            address(0xdead),
            address(123),
            block.timestamp + 365 days,
            0,
            address(this)
        );
    }

    function testRejectSameTokens() public {
        vm.expectRevert();
        new AerodromeFeeHarvester(
            address(m),
            1,
            address(d),
            address(d),
            address(0xdead),
            address(123),
            block.timestamp + 365 days,
            0,
            address(this)
        );
    }

    function testRejectMillisecondsExtension() public {
        uint256 bad = (a.unlockTime() + 365 days) * 1000;
        vm.expectRevert();
        a.extendLock(bad);
    }

    function testTokenTransferFailureRollsBackHarvest() public {
        d.mint(address(a), 10);
        s.mint(address(a), 20);
        s.setPaused(true);
        vm.expectRevert();
        a.harvest();
        eq(a.lastHarvestAt(), 0);
        eq(d.balanceOf(address(a)), 10);
        eq(d.balanceOf(address(0xdead)), 0);
        s.setPaused(false);
        a.harvest();
        eq(s.balanceOf(address(123)), 20);
    }

    function testRescueUnrelatedToken() public {
        RewardMock other = new RewardMock();
        other.mint(address(a), 99);
        a.rescueToken(address(other), address(888), 99);
        eq(other.balanceOf(address(888)), 99);
    }

    function testPendingChangePreventsFreeze() public {
        a.proposeDestination(address(456));
        vm.expectRevert();
        a.lockDestinationForever();
    }

    function testUnauthorizedMutation() public {
        vm.prank(address(888));
        vm.expectRevert();
        a.proposeDestination(address(456));
        vm.prank(address(888));
        vm.expectRevert();
        a.lockForever();
    }

    function testFuzzStrayRouting(uint128 x, uint128 y) public {
        d.mint(address(a), x);
        s.mint(address(a), y);
        a.harvest();
        eq(d.balanceOf(address(0xdead)), x);
        eq(s.balanceOf(address(123)), y);
    }
}

contract LockerHarvesterTest is Support {
    PositionMock m;
    LockerMock l;
    LockerHarvester h;

    function setUp() public {
        vm.warp(100000);
        m = new PositionMock();
        l = new LockerMock(m, 7);
        m.mint(address(l), 7);
        h = new LockerHarvester(address(l), address(m), 7, address(123), 1 hours, address(this));
        l.transferOwnership(address(h));
    }

    function testHarvestPermissionlessFixedAndInterval() public {
        vm.prank(address(888));
        h.harvest();
        require(l.recipient() == address(123));
        vm.expectRevert();
        h.harvest();
        vm.warp(h.lastHarvestAt() + 1 hours);
        h.harvest();
    }

    function testDestinationFreezeAllPaths() public {
        h.lockDestinationForever();
        vm.expectRevert();
        h.proposeDestination(address(456));
        vm.expectRevert();
        h.applyDestination();
        vm.expectRevert();
        h.cancelDestinationChange();
        vm.expectRevert();
        h.setDestinationDelay(1 days);
    }

    function testTimelockAndCancellation() public {
        h.proposeDestination(address(456));
        vm.expectRevert();
        h.applyDestination();
        h.cancelDestinationChange();
        vm.expectRevert();
        h.applyDestination();
        h.proposeDestination(address(456));
        vm.warp(h.pendingDestinationReadyAt());
        vm.prank(address(888));
        h.applyDestination();
        require(h.destination() == address(456));
    }

    function testRecoveryOnlyAfterUnlock() public {
        vm.expectRevert();
        h.recoverReleasedPosition(address(888));
        vm.warp(l.end());
        h.recoverReleasedPosition(address(888));
        require(m.ownerOf(7) == address(888));
    }

    function testRecoveryAfterPermissionlessRelease() public {
        vm.warp(l.end());
        vm.prank(address(888));
        l.release();
        h.recoverReleasedPosition(address(999));
        require(m.ownerOf(7) == address(999));
    }

    function testRecoveryOwnerOnly() public {
        vm.warp(l.end());
        vm.prank(address(888));
        vm.expectRevert();
        h.recoverReleasedPosition(address(888));
    }

    function testRecoveryRejectsMissingLockerOwnership() public {
        PositionMock other = new PositionMock();
        LockerMock lock = new LockerMock(other, 9);
        other.mint(address(lock), 9);
        LockerHarvester harvester =
            new LockerHarvester(address(lock), address(other), 9, address(123), 0, address(this));
        vm.warp(lock.end());
        vm.expectRevert();
        harvester.recoverReleasedPosition(address(888));
    }

    function testRecoveryRejectsZeroRecipientAndSecondRecovery() public {
        vm.warp(l.end());
        vm.expectRevert();
        h.recoverReleasedPosition(address(0));
        h.recoverReleasedPosition(address(888));
        vm.expectRevert();
        h.recoverReleasedPosition(address(999));
    }

    function testDelayChangeDoesNotAcceleratePending() public {
        h.proposeDestination(address(456));
        uint256 ready = h.pendingDestinationReadyAt();
        h.setDestinationDelay(1 days);
        eq(h.pendingDestinationReadyAt(), ready);
        vm.warp(ready - 1);
        vm.expectRevert();
        h.applyDestination();
        vm.warp(ready);
        h.applyDestination();
    }

    function testRejectLockerWithoutPosition() public {
        m.mint(address(this), 9);
        LockerMock other = new LockerMock(m, 9);
        vm.expectRevert();
        new LockerHarvester(address(other), address(m), 9, address(123), 0, address(this));
    }

    function testRejectWrongConfiguredId() public {
        vm.expectRevert();
        new LockerHarvester(address(l), address(m), 8, address(123), 0, address(this));
    }

    function testRejectExcessiveInterval() public {
        vm.expectRevert();
        new LockerHarvester(address(l), address(m), 7, address(123), type(uint256).max, address(this));
    }
}
