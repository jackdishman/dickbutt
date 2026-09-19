// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../VammHarvester.t.sol";
import "../../src/DickbuttRewardsDistributor.sol";
import "../../src/SpcxcSwapExecutor.sol";

/// Standard accounting with configurable ABI return behavior, not a taxed token.
contract FinalReturnToken is ERC20 {
    uint256 public returnMode;
    constructor() ERC20("Final return token", "FRT") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setReturnMode(uint256 mode) external { returnMode = mode; }
    function transfer(address to, uint256 amount) public override returns (bool) {
        if (returnMode == 1) return false;
        bool ok = super.transfer(to, amount);
        if (returnMode == 2) assembly ("memory-safe") { return(0, 0) }
        return ok;
    }
}

contract FinalActivationToken is ERC20 {
    DickbuttRewardsDistributor public distributor;
    bool public attempted;
    bool public activated;
    constructor() ERC20("Final activation", "FAT") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function configure(DickbuttRewardsDistributor target) external { distributor = target; }
    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (from == address(distributor) && !attempted) {
            attempted = true;
            (activated,) = address(distributor).call(abi.encodeCall(distributor.activateRound, (2)));
        }
    }
}

/// Adversarial dependency fixture: authenticity remains a deployment trust boundary.
contract FinalAdversarialRouter {
    RewardMock public input;
    RewardMock public output;
    SpcxcSwapExecutor public executor;
    uint256 public mode;
    bool public escaped;
    bool public attempted;
    constructor(RewardMock w, RewardMock s) { input = w; output = s; }
    function configure(SpcxcSwapExecutor target, uint256 mode_) external { executor = target; mode = mode_; }
    function exactInput(ISpcxcSwapRouter.ExactInputParams calldata p) external payable returns (uint256) {
        if (mode == 1) {
            input.transferFrom(msg.sender, address(this), p.amountIn + 1);
        } else {
            input.transferFrom(msg.sender, address(this), p.amountIn);
        }
        if (mode == 2) {
            output.mint(p.recipient, p.amountOutMinimum - 1);
            return type(uint256).max;
        }
        if (mode == 3) input.mint(msg.sender, 1);
        if (mode == 4) {
            attempted = true;
            (bool swap,) = address(executor).call(abi.encodeCall(executor.processWeth, (0, p.deadline)));
            (bool forward,) = address(executor).call(abi.encodeCall(executor.forwardSpcxc, ()));
            (bool administer,) = address(executor).call(abi.encodeCall(executor.setKeeper, (address(this), true)));
            (bool lowerFloor,) = address(executor).call(abi.encodeCall(executor.setPriceFloor, (1, p.deadline)));
            escaped = swap || forward || administer || lowerFloor;
        }
        output.mint(p.recipient, p.amountOutMinimum);
        if (mode == 5) revert("after transfer");
        return p.amountOutMinimum;
    }
}

contract FinalContractBoundaryAuditTest is Support {
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant STRANGER = address(0xBAD);
    address constant BURN = address(0xDEAD);
    function setUp() public { vm.warp(100000); }
    function leaf(uint256 id, address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(id, account, amount))));
    }
    function pay(DickbuttRewardsDistributor d, uint256 id, address account, uint256 amount) internal {
        address[] memory a = new address[](1); a[0] = account;
        uint256[] memory n = new uint256[](1); n[0] = amount;
        bytes32[][] memory p = new bytes32[][](1); p[0] = new bytes32[](0);
        d.distributeBatch(id, a, n, p);
    }
    function distributor(address token) internal returns (DickbuttRewardsDistributor d) {
        d = new DickbuttRewardsDistributor(token, 0, address(this));
        d.setRoundDelay(0); d.setRoundLimits(10000, 0); d.setKeeper(address(this), true);
    }
    function vamm() internal returns (AerodromeVammHarvester h, VammPoolMock pool, RewardMock dick, RewardMock spcx) {
        dick = new RewardMock(); spcx = new RewardMock();
        VammFactoryMock factory = new VammFactoryMock();
        pool = new VammPoolMock(address(factory), address(dick), address(spcx));
        factory.configure(address(pool), true);
        h = new AerodromeVammHarvester(address(factory), address(pool), address(dick), address(spcx),
            BURN, ALICE, block.timestamp + 1 days, 0, address(this));
        pool.mint(address(h), 1000);
    }

    function testVammCancellationClearsMatureProposalAndPreservesOriginalRouting() public {
        (AerodromeVammHarvester h, VammPoolMock pool, RewardMock dick, RewardMock spcx) = vamm();
        h.proposeDestination(BOB); vm.warp(h.pendingDestinationReadyAt());
        h.cancelDestinationChange();
        require(h.pendingDestination() == address(0)); eq(h.pendingDestinationReadyAt(), 0);
        vm.expectRevert(bytes("nothing pending")); vm.prank(STRANGER); h.applyDestination();
        h.lockDestinationForever(); pool.accrue(address(h), 13, 17);
        vm.prank(STRANGER); h.harvest();
        eq(dick.balanceOf(BURN), 13); eq(spcx.balanceOf(ALICE), 17); eq(spcx.balanceOf(BOB), 0);
        eq(pool.balanceOf(address(h)), 1000);
    }

    function testVammFreezeRequiresCancellationAndUnrelatedRescueCannotTouchLP() public {
        (AerodromeVammHarvester h, VammPoolMock pool,,) = vamm();
        h.proposeDestination(BOB);
        vm.expectRevert(bytes("cancel pending change first")); h.lockDestinationForever();
        h.cancelDestinationChange(); h.lockDestinationForever(); h.lockForever();
        RewardMock unrelated = new RewardMock(); unrelated.mint(address(h), 91);
        vm.expectRevert(); vm.prank(STRANGER); h.rescueToken(address(unrelated), STRANGER, 91);
        h.rescueToken(address(unrelated), BOB, 91); eq(unrelated.balanceOf(BOB), 91);
        vm.expectRevert(bytes("protected token")); h.rescueToken(address(pool), BOB, 1000);
        vm.warp(block.timestamp + 100 days);
        vm.expectRevert(bytes("locked forever")); h.withdrawLiquidity(BOB, 1000);
        eq(pool.balanceOf(address(h)), 1000); eq(pool.allowance(address(h), STRANGER), 0);
    }

    // Governance-state observation: accepting ownership does not silently cancel existing proposals.
    function testVammNewOwnerCanCancelInheritedPendingDestination() public {
        (AerodromeVammHarvester h, VammPoolMock pool,, RewardMock spcx) = vamm();
        h.proposeDestination(STRANGER); uint256 ready = h.pendingDestinationReadyAt();
        h.transferOwnership(BOB); vm.prank(BOB); h.acceptOwnership();
        require(h.pendingDestination() == STRANGER); eq(h.pendingDestinationReadyAt(), ready);
        vm.expectRevert(); h.cancelDestinationChange();
        vm.expectRevert(); h.proposeDestination(STRANGER);
        vm.prank(BOB); h.cancelDestinationChange();
        vm.warp(ready); vm.expectRevert(bytes("nothing pending")); h.applyDestination();
        pool.accrue(address(h), 0, 99); h.harvest(); eq(spcx.balanceOf(ALICE), 99);
    }

    function testFalseReturnThenNoReturnTransferKeepsExactRetryAccounting() public {
        FinalReturnToken token = new FinalReturnToken(); DickbuttRewardsDistributor d = distributor(address(token));
        token.mint(address(d), 1000); d.proposeRound(leaf(1, ALICE, 400), 400); d.activateRound(1);
        token.setReturnMode(1); pay(d, 1, ALICE, 400);
        require(!d.paid(1, ALICE)); eq(d.totalReserved(), 400); eq(token.balanceOf(ALICE), 0);
        token.setReturnMode(2); pay(d, 1, ALICE, 400); pay(d, 1, ALICE, 400);
        require(d.paid(1, ALICE)); eq(d.totalReserved(), 0); eq(token.balanceOf(ALICE), 400);
        eq(token.balanceOf(address(d)), 600);
    }

    function testPermissionlessActivationDuringCallbackPreservesBothRoundReserves() public {
        FinalActivationToken token = new FinalActivationToken(); DickbuttRewardsDistributor d = distributor(address(token));
        token.configure(d); token.mint(address(d), 1000);
        d.proposeRound(leaf(1, ALICE, 400), 400); d.proposeRound(leaf(2, BOB, 300), 300); d.activateRound(1);
        pay(d, 1, ALICE, 400);
        require(token.attempted() && token.activated()); eq(d.totalReserved(), 300);
        eq(token.balanceOf(address(d)), 600); (,,,bool active,) = d.roundInfo(2); require(active);
        pay(d, 2, BOB, 300); eq(d.totalReserved(), 0); eq(token.balanceOf(BOB), 300);
        vm.prank(STRANGER); d.closeRound(1); vm.prank(STRANGER); d.closeRound(2);
        eq(d.totalReserved(), 0); eq(token.balanceOf(address(d)), 300);
    }

    function testRoundDomainPreventsProofReplayEvenWithSameRecipientAndAmount() public {
        RewardMock token = new RewardMock(); DickbuttRewardsDistributor d = distributor(address(token));
        token.mint(address(d), 1000); bytes32 firstRoot = leaf(1, ALICE, 100);
        d.proposeRound(firstRoot, 100); d.activateRound(1); pay(d, 1, ALICE, 100);
        d.proposeRound(firstRoot, 100); d.activateRound(2);
        vm.expectRevert(bytes("invalid proof")); pay(d, 2, ALICE, 100);
        require(!d.paid(2, ALICE)); eq(token.balanceOf(ALICE), 100); eq(d.totalReserved(), 100);
        d.closeRound(2); eq(d.totalReserved(), 0);
    }

    function executor() internal returns (SpcxcSwapExecutor e, FinalAdversarialRouter r, RewardMock w, RewardMock s, address dest) {
        w = new RewardMock(); s = new RewardMock(); RewardMock u = new RewardMock();
        dest = address(distributor(address(s))); r = new FinalAdversarialRouter(w, s);
        e = new SpcxcSwapExecutor(address(w), address(s), address(r), dest, address(u), 1, 10, 1000, 60, address(this));
        e.setKeeper(address(this), true); e.setPriceFloor(1e18, block.timestamp + 1 days);
        w.mint(address(e), 2000); s.mint(dest, 1000000);
    }

    function testSwapMaliciousOutputInputAndRevertCannotLeaveApprovalsOrPartialState() public {
        (SpcxcSwapExecutor e, FinalAdversarialRouter r, RewardMock w, RewardMock s, address dest) = executor();
        uint256[4] memory modes = [uint256(1), 2, 3, 5];
        for (uint256 i; i < modes.length; ++i) {
            r.configure(e, modes[i]); vm.expectRevert(); e.processWeth(0, block.timestamp + 60);
            eq(w.balanceOf(address(e)), 2000); eq(w.balanceOf(address(r)), 0);
            eq(s.balanceOf(dest), 1000000); eq(w.allowance(address(e), address(r)), 0); eq(e.lastSwapAt(), 0);
        }
        r.configure(e, 0); eq(e.processWeth(0, block.timestamp + 60), 1000);
        eq(w.balanceOf(address(e)), 1000); eq(s.balanceOf(dest), 1001000); eq(w.allowance(address(e), address(r)), 0);
    }

    function testAuthorizedRouterCallbackCannotReenterOrEscalateRoles() public {
        (SpcxcSwapExecutor e, FinalAdversarialRouter r, RewardMock w, RewardMock s, address dest) = executor();
        // Give the callback keeper permission so failure must additionally depend on the reentry guard.
        e.setKeeper(address(r), true); r.configure(e, 4);
        eq(e.processWeth(0, block.timestamp + 60), 1000);
        require(r.attempted() && !r.escaped()); eq(w.balanceOf(address(e)), 1000);
        eq(s.balanceOf(dest), 1001000); eq(w.allowance(address(e), address(r)), 0);
    }

    function testFuzzSwapCeilingNeverRoundsProtocolMinimumDown(uint96 rawAmount, uint64 rawFloor) public {
        (SpcxcSwapExecutor e, FinalAdversarialRouter r, RewardMock w, RewardMock s, address dest) = executor();
        uint256 amount = uint256(rawAmount) + 1; uint256 floor = uint256(rawFloor) + 1;
        uint256 oldBalance = w.balanceOf(address(e)); w.mint(address(e), amount);
        e.setSwapLimits(amount, 0); e.setPriceFloor(floor, block.timestamp + 60); r.configure(e, 0);
        uint256 numerator = amount * floor; uint256 expected = numerator / 1e18 + (numerator % 1e18 == 0 ? 0 : 1);
        eq(e.processWeth(0, block.timestamp + 60), expected);
        eq(s.balanceOf(dest), 1000000 + expected); eq(w.balanceOf(address(e)), oldBalance);
        eq(w.allowance(address(e), address(r)), 0);
    }
}
