// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../Support.sol";
import "../../src/DickbuttRewardsDistributor.sol";

contract AtomicProposer {
    function reserveAndActivate(DickbuttRewardsDistributor d, bytes32 root, uint256 amount) external {
        uint256 id = d.proposeRound(root, amount);
        d.activateRound(id);
    }
}

contract CallbackReward is ERC20 {
    constructor() ERC20("Audit callback", "ACB") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    DickbuttRewardsDistributor public target;
    bool public attempted;
    bool public escaped;
    function setTarget(DickbuttRewardsDistributor d) external { target = d; }
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from == address(target) && !attempted) {
            attempted = true;
            (bool close,) = address(target).call(abi.encodeCall(target.closeRound, (1)));
            (bool transfer,) = address(target).call(abi.encodeCall(target.executeTransfer, (address(this), 1)));
            (bool propose,) = address(target).call(abi.encodeCall(target.proposeRound, (bytes32(uint256(99)), 1)));
            address[] memory a = new address[](0);
            uint256[] memory n = new uint256[](0);
            bytes32[][] memory p = new bytes32[][](0);
            (bool reenter,) = address(target).call(abi.encodeCall(target.distributeBatch, (1, a, n, p)));
            escaped = close || transfer || propose || reenter;
        }
    }
}

contract TaxedAuditReward is ERC20 {
    constructor() ERC20("Audit taxed", "ATX") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value >= 10) {
            super._update(from, address(0), value / 10);
            super._update(from, to, value - value / 10);
        } else super._update(from, to, value);
    }
}

contract DistributorSecurityAuditTest is Support {
    RewardMock internal token;
    DickbuttRewardsDistributor internal d;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant STRANGER = address(0xBAD);
    address internal constant GUARDIAN = address(0xCAFE);

    function setUp() public {
        vm.warp(100000);
        token = new RewardMock();
        d = new DickbuttRewardsDistributor(address(token), 0, address(this));
        d.setKeeper(address(this), true);
        d.setGuardian(GUARDIAN);
        d.setRoundDelay(0);
        token.mint(address(d), 1000);
    }
    function leaf(uint256 id, address a, uint256 n) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(id, a, n))));
    }
    function pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a,b)) : keccak256(abi.encodePacked(b,a));
    }
    function payOne(DickbuttRewardsDistributor target, uint256 id, address a, uint256 n) internal {
        address[] memory accounts = new address[](1); accounts[0] = a;
        uint256[] memory amounts = new uint256[](1); amounts[0] = n;
        bytes32[][] memory proofs = new bytes32[][](1); proofs[0] = new bytes32[](0);
        target.distributeBatch(id, accounts, amounts, proofs);
    }

    // M-03: proposer alone cannot steal, but can remove the guardian's cancellation path atomically.
    function testAtomicRogueProposalRequiresOwnerToReleaseReserve() public {
        AtomicProposer bad = new AtomicProposer();
        d.setProposer(address(bad), true);
        bad.reserveAndActivate(d, leaf(1, STRANGER, 500), 500);
        eq(d.totalReserved(), 500);
        vm.prank(GUARDIAN); d.pauseProposals(true);
        vm.expectRevert(bytes("nothing pending")); vm.prank(GUARDIAN); d.cancelPendingRound(1);
        vm.expectRevert(bytes("only owner can close early")); vm.prank(GUARDIAN); d.closeRound(1);
        vm.expectRevert(bytes("not a keeper")); vm.prank(address(bad)); payOne(d, 1, STRANGER, 500);
        eq(token.balanceOf(STRANGER), 0);
        d.setProposer(address(bad), false);
        d.closeRound(1);
        eq(d.totalReserved(), 0);
    }

    // Governance trust observation: protected-token rescue prohibition is not a ban on owner redistribution.
    function testOwnerCanAuthorizeAnArbitraryRewardRecipient() public {
        d.setRoundLimits(10000, 0);
        d.proposeRound(leaf(1, STRANGER, 1000), 1000); d.activateRound(1);
        payOne(d, 1, STRANGER, 1000);
        eq(token.balanceOf(STRANGER), 1000);
        eq(d.totalReserved(), 0);
    }

    function testCallbackCannotCloseStealOrReenterDuringPayment() public {
        CallbackReward callback = new CallbackReward();
        DickbuttRewardsDistributor target = new DickbuttRewardsDistributor(address(callback),0,address(this));
        target.setKeeper(address(this),true); target.setKeeper(address(callback),true);
        target.setRoundDelay(0); callback.setTarget(target); callback.mint(address(target),1000);
        target.proposeRound(leaf(1,ALICE,400),400); target.activateRound(1);
        payOne(target,1,ALICE,400);
        require(callback.attempted() && !callback.escaped(), "callback escaped");
        eq(callback.balanceOf(ALICE),400); eq(target.totalReserved(),0);
    }

    function testInvalidSecondProofRollsBackFirstTransferAndPaidFlag() public {
        bytes32 la=leaf(1,ALICE,100); bytes32 lb=leaf(1,BOB,100);
        d.proposeRound(pair(la,lb),200); d.activateRound(1);
        address[] memory a=new address[](2);a[0]=ALICE;a[1]=BOB;
        uint256[] memory n=new uint256[](2);n[0]=100;n[1]=101;
        bytes32[][] memory p=new bytes32[][](2);p[0]=new bytes32[](1);p[0][0]=lb;p[1]=new bytes32[](1);p[1][0]=la;
        vm.expectRevert(bytes("invalid proof"));d.distributeBatch(1,a,n,p);
        eq(token.balanceOf(ALICE),0);require(!d.paid(1,ALICE),"partial flag");eq(d.totalReserved(),200);
    }

    function testSupportedTokenFailurePreservesEntitlementAndRetryPaysOnce() public {
        d.proposeRound(leaf(1,ALICE,300),300);d.activateRound(1);
        token.setBlocked(ALICE,true);payOne(d,1,ALICE,300);
        eq(d.totalReserved(),300);require(!d.paid(1,ALICE),"failed paid");
        token.setBlocked(ALICE,false);payOne(d,1,ALICE,300);payOne(d,1,ALICE,300);
        eq(token.balanceOf(ALICE),300);eq(d.totalReserved(),0);
    }

    // Compatibility observation only: the production asset is not this malicious/taxed mock.
    function testTaxedRewardWouldBeRecordedPaidDespiteUnderDelivery() public {
        TaxedAuditReward taxed=new TaxedAuditReward();
        DickbuttRewardsDistributor target=new DickbuttRewardsDistributor(address(taxed),0,address(this));
        target.setKeeper(address(this),true);target.setRoundDelay(0);taxed.mint(address(target),1000);
        target.proposeRound(leaf(1,ALICE,100),100);target.activateRound(1);payOne(target,1,ALICE,100);
        eq(taxed.balanceOf(ALICE),90);require(target.paid(1,ALICE),"ledger");
        (, ,uint256 distributed,,)=target.roundInfo(1);eq(distributed,100);
    }

    function testFuzzUnprivilegedCannotAdministerOrExecute(uint160 callerSeed, uint96 n) public {
        address stranger=address(callerSeed);
        if(stranger==address(this)||stranger==GUARDIAN||stranger==address(0))return;
        vm.expectRevert();vm.prank(stranger);d.setKeeper(stranger,true);
        vm.expectRevert();vm.prank(stranger);d.proposeRound(bytes32(uint256(n)+1),1);
        vm.expectRevert();vm.prank(stranger);d.executeTransfer(stranger,1);
        eq(d.totalReserved(),0);eq(token.balanceOf(address(d)),1000);
    }

    function testFuzzTimeBoundaries(uint32 intervalSeed, uint32 delaySeed) public {
        uint256 interval=uint256(intervalSeed)%7 days+1;
        if(interval>7 days)interval=7 days;
        uint256 delay=uint256(delaySeed)%3 days+1;
        if(delay>3 days)delay=3 days;
        d.setRoundLimits(5000,interval);d.setRoundDelay(delay);
        d.proposeRound(leaf(1,ALICE,100),100);
        (,,uint256 ready)=d.pending(1);
        vm.warp(ready-1);vm.expectRevert(bytes("still timelocked"));d.activateRound(1);
        vm.warp(ready);d.activateRound(1);
        uint256 allowed=d.nextProposalAllowedAt();
        vm.warp(allowed-1);vm.expectRevert(bytes("round interval not elapsed"));d.proposeRound(leaf(2,BOB,100),100);
        vm.warp(allowed);d.proposeRound(leaf(2,BOB,100),100);
        eq(d.totalReserved(),200);
    }
}
