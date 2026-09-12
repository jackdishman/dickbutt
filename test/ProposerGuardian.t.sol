// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Support.sol";
import "../src/DickbuttRewardsDistributor.sol";

/// Bounds on a bot-held proposer key: share cap, rate limit, guardian pause and cancel.
/// Defaults are left in place here on purpose -- this suite tests the limits themselves.
contract ProposerGuardianTest is Support {
    RewardMock token;
    DickbuttRewardsDistributor d;
    address constant PROPOSER = address(0xB07);
    address constant GUARDIAN = address(0x6A12);
    address constant ALICE = address(0x1111);
    address constant STRANGER = address(0xDEAD1);

    function setUp() public {
        token = new RewardMock();
        d = new DickbuttRewardsDistributor(address(token), 0, address(this));
        d.setProposer(PROPOSER, true);
        d.setGuardian(GUARDIAN);
        d.setKeeper(address(this), true);
        token.mint(address(d), 10000);
    }

    function leaf(uint256 id, address a, uint256 n) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(id, a, n))));
    }

    function testDefaultsAreTheAgreedPolicy() public view {
        eq(d.roundDelay(), 24 hours);
        eq(d.maxRoundBps(), 5000);
        eq(d.minRoundInterval(), 12 hours);
        require(d.guardian() == GUARDIAN, "guardian");
        // Owner is implicitly a proposer so the multisig never depends on a bot.
        require(!d.isProposer(address(this)), "owner is not listed");
        eq(d.maxProposableTotal(), 5000);
        eq(d.nextProposalAllowedAt(), 0);
    }

    function testShareCapBoundsASingleRound() public {
        vm.prank(PROPOSER);
        vm.expectRevert(bytes("round exceeds share cap"));
        d.proposeRound(leaf(1, ALICE, 5001), 5001);

        vm.prank(PROPOSER);
        d.proposeRound(leaf(1, ALICE, 5000), 5000);
        eq(d.totalReserved(), 5000);
        // The cap applies to what is left unreserved, so a queued round shrinks the next.
        eq(d.maxProposableTotal(), 2500);
    }

    function testCapIsRecomputedAgainstUnreservedBalanceNotRawBalance() public {
        vm.prank(PROPOSER);
        d.proposeRound(leaf(1, ALICE, 2000), 2000);
        d.setRoundLimits(2500, 0);
        // 8000 unreserved, so 2000 is exactly the cap and 2001 is not.
        vm.prank(PROPOSER);
        vm.expectRevert(bytes("round exceeds share cap"));
        d.proposeRound(leaf(2, ALICE, 2001), 2001);
        vm.prank(PROPOSER);
        d.proposeRound(leaf(2, ALICE, 2000), 2000);
        eq(d.totalReserved(), 4000);
    }

    function testRateLimitSpacesProposalsAndCancelDoesNotRefundTheSlot() public {
        vm.prank(PROPOSER);
        d.proposeRound(leaf(1, ALICE, 100), 100);
        eq(d.nextProposalAllowedAt(), block.timestamp + 12 hours);

        vm.prank(PROPOSER);
        vm.expectRevert(bytes("round interval not elapsed"));
        d.proposeRound(leaf(2, ALICE, 100), 100);

        // A compromised proposer must not get a fresh slot when its plan is cancelled.
        vm.prank(GUARDIAN);
        d.cancelPendingRound(1);
        vm.prank(PROPOSER);
        vm.expectRevert(bytes("round interval not elapsed"));
        d.proposeRound(leaf(2, ALICE, 100), 100);

        vm.warp(block.timestamp + 12 hours);
        vm.prank(PROPOSER);
        d.proposeRound(leaf(2, ALICE, 100), 100);
    }

    function testGuardianPauseEndsTheCancelRace() public {
        vm.prank(GUARDIAN);
        d.pauseProposals(true);
        require(d.proposalsPaused(), "paused");

        d.setRoundLimits(2500, 0);
        vm.prank(PROPOSER);
        vm.expectRevert(bytes("proposals paused"));
        d.proposeRound(leaf(1, ALICE, 100), 100);
        // The owner is not an escape hatch around a pause.
        vm.expectRevert(bytes("proposals paused"));
        d.proposeRound(leaf(1, ALICE, 100), 100);

        vm.prank(GUARDIAN);
        d.pauseProposals(false);
        vm.prank(PROPOSER);
        d.proposeRound(leaf(1, ALICE, 100), 100);
    }

    function testPauseNeverStrandsAlreadyCommittedRewards() public {
        vm.prank(PROPOSER);
        d.proposeRound(leaf(1, ALICE, 100), 100);
        vm.prank(GUARDIAN);
        d.pauseProposals(true);

        // Activation is permissionless and payment is keeper-gated; neither depends on proposals.
        vm.warp(block.timestamp + d.roundDelay());
        vm.prank(STRANGER);
        d.activateRound(1);
        address[] memory accounts = new address[](1); accounts[0] = ALICE;
        uint256[] memory amounts = new uint256[](1); amounts[0] = 100;
        bytes32[][] memory proofs = new bytes32[][](1); proofs[0] = new bytes32[](0);
        d.distributeBatch(1, accounts, amounts, proofs);
        eq(token.balanceOf(ALICE), 100);
    }

    function testRoleAuthorisation() public {
        vm.prank(STRANGER);
        vm.expectRevert(bytes("not a proposer"));
        d.proposeRound(leaf(1, ALICE, 100), 100);

        vm.prank(STRANGER);
        vm.expectRevert(bytes("not guardian or owner"));
        d.pauseProposals(true);

        vm.prank(PROPOSER);
        vm.expectRevert(bytes("not guardian or owner"));
        d.pauseProposals(true);

        vm.prank(PROPOSER);
        d.proposeRound(leaf(1, ALICE, 100), 100);
        vm.prank(PROPOSER);
        vm.expectRevert(bytes("not guardian or owner"));
        d.cancelPendingRound(1);

        // Only the owner administers roles and limits.
        vm.prank(GUARDIAN);
        vm.expectRevert();
        d.setProposer(STRANGER, true);
        vm.prank(GUARDIAN);
        vm.expectRevert();
        d.setRoundLimits(10000, 0);

        // Revoking a proposer takes effect immediately.
        d.setProposer(PROPOSER, false);
        vm.warp(block.timestamp + 12 hours);
        vm.prank(PROPOSER);
        vm.expectRevert(bytes("not a proposer"));
        d.proposeRound(leaf(2, ALICE, 100), 100);
    }

    function testLimitSettersRejectUnreasonableValues() public {
        vm.expectRevert(bytes("bad share cap"));
        d.setRoundLimits(0, 0);
        vm.expectRevert(bytes("bad share cap"));
        d.setRoundLimits(10001, 0);
        vm.expectRevert(bytes("unreasonable interval"));
        d.setRoundLimits(2500, 8 days);
        vm.expectRevert(bytes("bad guardian"));
        d.setGuardian(address(0));
        vm.expectRevert(bytes("bad proposer"));
        d.setProposer(address(0), true);
    }

    /// Handing the contract to the multisig must hand it the guardian role too, unless the
    /// guardian was deliberately split out beforehand.
    function testGuardianFollowsOwnershipUnlessSplit() public {
        RewardMock t = new RewardMock();
        DickbuttRewardsDistributor f = new DickbuttRewardsDistributor(address(t), 0, address(this));
        require(f.guardian() == address(this), "defaults to owner");
        address multisig = address(0x5A7E);
        f.transferOwnership(multisig);
        // Two-step: nothing moves until the multisig accepts.
        require(f.owner() == address(this) && f.guardian() == address(this), "pending transfer changes nothing");
        vm.prank(multisig);
        f.acceptOwnership();
        require(f.owner() == multisig && f.guardian() == multisig, "guardian follows the owner");
        // Once split, the guardian stays put through later transfers.
        vm.prank(multisig);
        f.setGuardian(GUARDIAN);
        address next = address(0x5A7F);
        vm.prank(multisig);
        f.transferOwnership(next);
        vm.prank(next);
        f.acceptOwnership();
        require(f.owner() == next && f.guardian() == GUARDIAN, "split guardian does not follow");
    }

    /// A share cap that floors to zero blocks proposals entirely. Surfaced by a view so
    /// operators see it before a revert, and cleared by raising the cap.
    function testDustBalanceFloorsTheCapToZero() public {
        RewardMock dust = new RewardMock();
        DickbuttRewardsDistributor small = new DickbuttRewardsDistributor(address(dust), 0, address(this));
        // At 50% a single raw unit floors to zero, so nothing is proposable.
        dust.mint(address(small), 1);
        eq(small.maxProposableTotal(), 0);
        vm.expectRevert(bytes("round exceeds share cap"));
        small.proposeRound(leaf(1, ALICE, 1), 1);
        small.setRoundLimits(10000, 0);
        eq(small.maxProposableTotal(), 1);
        small.proposeRound(leaf(1, ALICE, 1), 1);
    }

    function testFuzzCapNeverAdmitsMoreThanItsShare(uint96 balance, uint16 bps, uint96 total) public {
        // This harness has no forge-std bound/assume; normalise directly.
        bps = uint16(1 + (uint256(bps) % 10000));
        if (balance == 0) balance = 1;
        if (total == 0) total = 1;
        RewardMock t = new RewardMock();
        DickbuttRewardsDistributor f = new DickbuttRewardsDistributor(address(t), 0, address(this));
        t.mint(address(f), balance);
        f.setRoundLimits(bps, 0);
        uint256 allowed = f.maxProposableTotal();
        eq(allowed, (uint256(balance) * bps) / 10000);
        if (total <= allowed) {
            f.proposeRound(leaf(1, ALICE, total), total);
            eq(f.totalReserved(), total);
            // Never reserve more than the configured share of the starting balance.
            require(f.totalReserved() <= (uint256(balance) * bps) / 10000, "cap exceeded");
        } else {
            vm.expectRevert();
            f.proposeRound(leaf(1, ALICE, total), total);
        }
    }
}
