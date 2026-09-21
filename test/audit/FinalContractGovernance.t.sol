// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../Harvesters.t.sol";

/// Proof of an intended administrative capability, not an unprivileged exploit.
contract FinalContractGovernanceAuditTest is Support {
    function testFrozenClankerDestinationDoesNotRemovePostUnlockRecoveryAuthority() public {
        vm.warp(100000);
        PositionMock manager = new PositionMock();
        LockerMock locker = new LockerMock(manager, 7);
        manager.mint(address(locker), 7);
        address originalDestination = address(0x1234);
        address newPositionOwner = address(0x5678);
        LockerHarvester h = new LockerHarvester(address(locker), address(manager), 7,
            originalDestination, 0, address(this));
        locker.transferOwnership(address(h)); h.lockDestinationForever();
        vm.expectRevert(bytes("destination is locked forever")); h.proposeDestination(newPositionOwner);
        vm.warp(locker.end()); h.recoverReleasedPosition(newPositionOwner);
        require(manager.ownerOf(7) == newPositionOwner);
        require(h.destination() == originalDestination && h.destinationLocked());
        RewardMock dick = new RewardMock(); RewardMock weth = new RewardMock();
        manager.configureFees(dick, weth);
        vm.prank(newPositionOwner);
        manager.collect(INonfungiblePositionManager.CollectParams(7, newPositionOwner, type(uint128).max, type(uint128).max));
        eq(dick.balanceOf(newPositionOwner), 13); eq(weth.balanceOf(newPositionOwner), 17);
        eq(dick.balanceOf(originalDestination), 0); eq(weth.balanceOf(originalDestination), 0);
    }
}
