// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ILpLocker {
    function collectFees(address _recipient, uint256 _tokenId) external;
    function end() external view returns (uint256);
    function released(address manager) external view returns (uint256);
    function release() external;
    function owner() external view returns (address);
}

/// @title LockerHarvester
/// @notice Removes the last manual step from the system.
///
/// THE PROBLEM THIS SOLVES
/// Dickbutt's Clanker LpLocker gates fee collection on:
///     require(owner() == msg.sender, "only owner can call");
/// There is no delegate role, no additional-collector slot, no
/// permissionless variant. So *something* holding the owner role must sign
/// every collection. Two bad options:
///   (a) a human does it by hand forever, or
///   (b) a bot holds the owner key -- and since collectFees() lets the
///       caller choose the recipient, a leaked bot key means an attacker
///       can quietly redirect every future fee collection to themselves.
///       That doesn't just steal once, it kills the reward stream while
///       still looking like it works.
///
/// THE FIX
/// Transfer locker ownership to THIS contract. It exposes exactly one
/// operational function, harvest(), which anyone may call, and which can
/// only ever send fees to `destination`. There is no "choose the
/// recipient" parameter to abuse. A bot key is no longer privileged --
/// it's just whoever happens to pay the gas. Nothing to leak.
///
/// WHAT THIS CONTRACT DELIBERATELY CANNOT DO
/// - It cannot move the LP position before the locker unlocks. Afterwards,
///   the owner can recover only the configured NFT using the narrow recovery path.
/// - It cannot send fees anywhere except `destination`.
/// - It cannot be used to call arbitrary functions on the locker.
///
/// THE ONE PRIVILEGED THING, AND HOW IT'S CONTAINED
/// `destination` is changeable, because otherwise a bug in the forwarder,
/// a router migration, or an SPCXc contract change would strand the
/// locker's ownership permanently with fees flowing into a dead address.
/// That flexibility is contained three ways:
///   1. Changes are timelocked (default 7 days) and emit an event, so a
///      hostile change is visible on-chain for a week before it can take
///      effect.
///   2. The owner can cancel a pending change at any time.
///   3. `lockDestinationForever()` permanently disables changes. Once
///      you're confident in the setup, call it. After that this contract
///      is functionally immutable and there is no privileged role left
///      that can touch the fee stream at all.
/// Use a multisig as owner until you call lockDestinationForever().
contract LockerHarvester is Ownable2Step, ReentrancyGuard {
    IERC721 public immutable positionManager;
    event PositionRecovered(address indexed to, uint256 tokenId);
    ILpLocker public immutable locker;
    uint256 public immutable tokenId;
    uint256 public immutable minInterval;

    address public destination;
    bool public destinationLocked;

    address public pendingDestination;
    uint256 public pendingDestinationReadyAt;
    uint256 public destinationDelay = 7 days;

    uint256 public lastHarvestAt;

    event Harvested(address indexed caller, address indexed destination, uint256 timestamp);
    event DestinationChangeProposed(address indexed newDestination, uint256 readyAt);
    event DestinationChanged(address indexed oldDestination, address indexed newDestination);
    event DestinationChangeCancelled(address indexed cancelled);
    event DestinationLockedForever(address indexed finalDestination);

    constructor(
        address locker_,
        address positionManager_,
        uint256 tokenId_,
        address destination_,
        uint256 minInterval_,
        address owner_
    ) Ownable(owner_) {
        require(locker_ != address(0) && destination_ != address(0), "bad address");
        require(locker_.code.length > 0 && positionManager_.code.length > 0, "not contract");
        require(minInterval_ <= 30 days, "interval too long");
        require(ILpLocker(locker_).released(positionManager_) == tokenId_, "wrong position");
        require(IERC721(positionManager_).ownerOf(tokenId_) == locker_, "locker lacks position");
        positionManager = IERC721(positionManager_);
        locker = ILpLocker(locker_);
        tokenId = tokenId_;
        destination = destination_;
        minInterval = minInterval_;
    }

    // ---------------------------------------------------------------
    // The only operational function
    // ---------------------------------------------------------------

    /// @notice Collect accumulated LP fees and send them to `destination`.
    /// Permissionless on purpose: the caller has no influence over where
    /// the money goes, so there is nothing to gain by calling it and
    /// nothing lost if our own bot goes down -- anyone can keep the system
    /// running, including an impatient holder.
    /// @dev minInterval exists only to stop someone spamming this every
    /// block and fragmenting the accounting into thousands of dust
    /// collections. It is not a security control.
    function harvest() external nonReentrant {
        require(lastHarvestAt == 0 || block.timestamp >= lastHarvestAt + minInterval, "too soon");
        lastHarvestAt = block.timestamp;
        locker.collectFees(destination, tokenId);
        emit Harvested(msg.sender, destination, block.timestamp);
    }

    /// @notice Recover only the configured position after the verified locker unlocks.
    /// The locker's release is permissionless and uses transferFrom, not safeTransferFrom.
    function recoverReleasedPosition(address to) external onlyOwner nonReentrant {
        require(to != address(0) && to != address(this), "bad recipient");
        require(locker.owner() == address(this), "not locker owner");
        require(block.timestamp >= locker.end(), "still locked");
        if (positionManager.ownerOf(tokenId) == address(locker)) locker.release();
        require(positionManager.ownerOf(tokenId) == address(this), "position not released");
        positionManager.safeTransferFrom(address(this), to, tokenId);
        emit PositionRecovered(to, tokenId);
    }

    /// @notice Sanity check for before/after transferring locker ownership.
    function ownsLocker() external view returns (bool) {
        return locker.owner() == address(this);
    }

    // ---------------------------------------------------------------
    // Destination management (timelocked, and permanently disableable)
    // ---------------------------------------------------------------

    function proposeDestination(address newDestination) external onlyOwner {
        require(!destinationLocked, "destination is locked forever");
        require(newDestination != address(0), "bad destination");
        pendingDestination = newDestination;
        pendingDestinationReadyAt = block.timestamp + destinationDelay;
        emit DestinationChangeProposed(newDestination, pendingDestinationReadyAt);
    }

    /// @notice Permissionless once the timelock expires, same reasoning as
    /// the vault's activateRoot: the decision already happened publicly.
    function applyDestination() external {
        require(!destinationLocked, "destination is locked forever");
        require(pendingDestination != address(0), "nothing pending");
        require(block.timestamp >= pendingDestinationReadyAt, "still timelocked");

        address old = destination;
        destination = pendingDestination;
        pendingDestination = address(0);
        pendingDestinationReadyAt = 0;
        emit DestinationChanged(old, destination);
    }

    function cancelDestinationChange() external onlyOwner {
        require(!destinationLocked, "destination is locked forever");
        emit DestinationChangeCancelled(pendingDestination);
        pendingDestination = address(0);
        pendingDestinationReadyAt = 0;
    }

    function setDestinationDelay(uint256 newDelay) external onlyOwner {
        require(!destinationLocked, "destination is locked forever");
        require(newDelay >= 1 days && newDelay <= 30 days, "unreasonable delay");
        destinationDelay = newDelay;
    }

    /// @notice ONE-WAY DOOR. Permanently freezes `destination` and disables
    /// every setter above. After this, no key anywhere can alter where fees
    /// go -- the fee stream becomes untamperable by anyone, including you.
    /// Call it once the forwarder has been running correctly for a while.
    /// There is no undo.
    function lockDestinationForever() external onlyOwner {
        require(!destinationLocked, "already locked");
        require(pendingDestination == address(0), "cancel pending change first");
        destinationLocked = true;
        emit DestinationLockedForever(destination);
    }
}
