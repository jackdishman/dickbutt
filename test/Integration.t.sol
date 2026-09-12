// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./Harvesters.t.sol";
import "./FeeSplitter.t.sol";
import "../src/DickbuttRewardsDistributor.sol";

/// Test-only locker reproduces the verified custody and owner-gated collection ABI.
contract FeeCycleLocker {
    address public owner;
    PositionMock public manager;
    uint256 public duration;
    RewardMock public weth;
    RewardMock public dickbutt;

    constructor(PositionMock m, RewardMock w, RewardMock d, address owner_) {
        manager = m;
        weth = w;
        dickbutt = d;
        owner = owner_;
        duration = block.timestamp + 365 days;
    }

    function transferOwnership(address to) external {
        require(msg.sender == owner);
        owner = to;
    }

    function released(address m) external view returns (uint256) {
        return m == address(manager) ? 7 : 0;
    }

    function end() external view returns (uint256) {
        return duration;
    }

    function release() external {
        require(block.timestamp >= duration);
        manager.transferFrom(address(this), owner, 7);
    }

    function collectFees(address to, uint256 id) external {
        require(msg.sender == owner && id == 7);
        weth.mint(to, 1000);
        dickbutt.mint(to, 1000);
    }
}

contract IntegrationTest is Support {
    RewardMock w;
    RewardMock d;
    RewardMock s;
    RewardMock u;
    RouterMock router;
    PositionMock manager;
    FeeCycleLocker locker;
    LockerHarvester clanker;
    AerodromeFeeHarvester aero;
    FeeSplitter splitter;
    DickbuttRewardsDistributor distributor;
    address constant KC = address(101);
    address constant BURN = address(102);
    address constant CDB = address(103);
    address constant ALICE = address(201);
    address constant BOB = address(202);
    address constant CAROL = address(203);

    function setUp() public {
        vm.warp(100000);
        w = new RewardMock();
        d = new RewardMock();
        s = new RewardMock();
        u = new RewardMock();
        router = new RouterMock(w, s);
        manager = new PositionMock();
        distributor = new DickbuttRewardsDistributor(address(s), 0, address(this));
        // Lifecycle coverage predates the share cap and rate limit; disable both so these
        // tests keep exercising rounds, not the limits. Dedicated tests cover the limits.
        distributor.setRoundLimits(10000, 0);
        distributor.setKeeper(address(this), true);
        splitter = new FeeSplitter(
            address(w),
            address(d),
            address(s),
            address(router),
            KC,
            BURN,
            CDB,
            address(distributor),
            address(u),
            100,
            200,
            1000,
            0,
            address(this)
        );
        splitter.setKeeper(address(this), true);
        splitter.setPriceFloor(1e18, block.timestamp + 1 days);
        locker = new FeeCycleLocker(manager, w, d, address(this));
        manager.mint(address(locker), 7);
        clanker = new LockerHarvester(address(locker), address(manager), 7, address(splitter), 0, address(this));
        locker.transferOwnership(address(clanker));
        aero = new AerodromeFeeHarvester(
            address(manager),
            8,
            address(d),
            address(s),
            BURN,
            address(distributor),
            block.timestamp + 365 days,
            0,
            address(this)
        );
        manager.mint(address(this), 8);
        manager.safeTransferFrom(address(this), address(aero), 8);
        manager.configureFees(d, s);
    }

    function leaf(uint256 id, address recipient, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(id, recipient, amount))));
    }

    function pair(bytes32 x, bytes32 y) internal pure returns (bytes32) {
        return x < y ? keccak256(abi.encodePacked(x, y)) : keccak256(abi.encodePacked(y, x));
    }

    function batch(uint256 id, address x, address y, uint256 a, uint256 b) internal {
        address[] memory accounts = new address[](2);
        accounts[0] = x;
        accounts[1] = y;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = a;
        amounts[1] = b;
        bytes32[][] memory proofs = new bytes32[][](2);
        proofs[0] = new bytes32[](1);
        proofs[1] = new bytes32[](1);
        proofs[0][0] = leaf(id, y, b);
        proofs[1][0] = leaf(id, x, a);
        distributor.distributeBatch(id, accounts, amounts, proofs);
    }

    function testFullFeeCycleConcurrentRoundsRetryAndEarlyClose() public {
        vm.prank(address(999));
        clanker.harvest();
        splitter.splitDickbutt();
        splitter.processWeth(0, block.timestamp + 60);
        vm.prank(address(999));
        aero.harvest();
        eq(w.balanceOf(KC), 100);
        eq(w.balanceOf(CDB), 100);
        eq(w.balanceOf(address(router)), 800);
        eq(w.totalSupply(), 1000);
        eq(d.balanceOf(KC), 100);
        eq(d.balanceOf(BURN), 913);
        eq(d.totalSupply(), 1013);
        eq(s.balanceOf(address(distributor)), 1617);
        distributor.proposeRound(pair(leaf(1, ALICE, 400), leaf(1, BOB, 300)), 700);
        distributor.proposeRound(pair(leaf(2, ALICE, 200), leaf(2, CAROL, 500)), 700);
        eq(distributor.availableForNextRound(), 217);
        eq(distributor.totalReserved(), 1400);
        vm.expectRevert();
        distributor.activateRound(1);
        vm.warp(100000 + distributor.roundDelay());
        distributor.activateRound(1);
        distributor.activateRound(2);
        s.setBlocked(BOB, true);
        s.setBlocked(CAROL, true);
        batch(1, ALICE, BOB, 400, 300);
        batch(2, ALICE, CAROL, 200, 500);
        eq(s.balanceOf(ALICE), 600);
        eq(distributor.totalReserved(), 800);
        require(!distributor.paid(1, BOB));
        s.setBlocked(BOB, false);
        batch(1, ALICE, BOB, 400, 300);
        batch(1, ALICE, BOB, 400, 300);
        eq(s.balanceOf(BOB), 300);
        eq(s.balanceOf(ALICE), 600);
        vm.prank(address(999));
        distributor.closeRound(1);
        vm.prank(address(999));
        vm.expectRevert();
        distributor.closeRound(2);
        distributor.closeRound(2);
        eq(distributor.totalReserved(), 0);
        eq(distributor.availableForNextRound(), 717);
        eq(
            s.balanceOf(ALICE) + s.balanceOf(BOB) + s.balanceOf(CAROL) + s.balanceOf(address(distributor)),
            s.totalSupply()
        );
        eq(s.totalSupply(), 1617);
        eq(w.balanceOf(address(splitter)), 0);
        eq(d.balanceOf(address(splitter)), 0);
        eq(s.balanceOf(address(aero)), 0);
    }
}
