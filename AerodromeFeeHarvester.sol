// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Slipstream's position manager is a Uniswap V3 fork and is EXPECTED
/// to match this interface. NOT verified against the live contract.
interface INonfungiblePositionManager is IERC721 {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
}

/// @title AerodromeFeeHarvester
/// @notice Holds the DICKBUTT/SPCXc Slipstream LP position NFT, claims its
/// trading fees permissionlessly, and routes each token to where the
/// tokenomics say it goes.
///
/// WHY THIS EXISTS
/// Aerodrome does not push LP fees anywhere. They sit unclaimed in the
/// position until the position's owner (or an approved operator) calls
/// collect() -- and collect() lets the caller choose the recipient. That is
/// the same shape of problem as the Clanker locker: a bot wallet holding
/// that authority could be compromised and silently redirect the fees.
///
/// Same fix as LockerHarvester: this contract OWNS the position NFT, and
/// exposes one function with no recipient parameter. Destinations are fixed
/// in storage. harvest() is therefore safe to leave open to anyone -- a
/// caller has no influence over where the money goes and nothing to gain.
///
/// THE SPLIT
/// collect() returns BOTH tokens in one call. Per the tokenomics:
///   - the DICKBUTT side goes to the burn address
///   - the SPCXc side goes to the rewards distributor
/// So this contract collects to itself first, then sweeps each token to its
/// own destination. It never holds a balance between calls.
///
/// THE LP LOCK
/// This contract is also the lock. It has no function that can transfer the
/// NFT out before `unlockTime`, so the liquidity is provably stuck until
/// then. Choose unlockTime at deployment:
///   - a far-future timestamp for an effectively permanent lock
///   - a year or two out if you want the option to migrate later
///   - or call lockForever() at any point to give up that option for good
/// Fee collection keeps working regardless -- locking the liquidity does not
/// lock the fees.
contract AerodromeFeeHarvester is Ownable2Step, IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    INonfungiblePositionManager public immutable positionManager;
    uint256 public immutable tokenId;

    IERC20 public immutable dickbutt;
    IERC20 public immutable spcxc;

    /// @notice Where the DICKBUTT fee side goes. Immutable: it is the burn
    /// address and there is no legitimate reason to ever change it.
    address public immutable burnAddress;

    /// @notice Where the SPCXc fee side goes (the rewards distributor).
    /// Changeable behind a timelock so a distributor bug does not strand the
    /// position forever, then freezable.
    address public spcxcDestination;
    bool public destinationLocked;

    address public pendingDestination;
    uint256 public pendingDestinationReadyAt;
    uint256 public destinationDelay = 7 days;

    uint256 public unlockTime;
    bool public lockedForever;

    uint256 public immutable minInterval;
    uint256 public lastHarvestAt;

    event Harvested(address indexed caller, uint256 dickbuttBurned, uint256 spcxcForwarded);
    event DestinationChangeProposed(address indexed newDestination, uint256 readyAt);
    event DestinationChanged(address indexed oldDestination, address indexed newDestination);
    event DestinationChangeCancelled(address indexed cancelled);
    event DestinationLockedForever(address indexed finalDestination);
    event LiquidityLockedForever(uint256 tokenId);
    event PositionWithdrawn(address indexed to, uint256 tokenId);

    constructor(
        address positionManager_,
        uint256 tokenId_,
        address dickbutt_,
        address spcxc_,
        address burnAddress_,
        address spcxcDestination_,
        uint256 unlockTime_,
        uint256 minInterval_,
        address owner_
    ) Ownable(owner_) {
        require(
            positionManager_ != address(0) && dickbutt_ != address(0) && spcxc_ != address(0)
                && burnAddress_ != address(0) && spcxcDestination_ != address(0),
            "bad address"
        );
        require(positionManager_.code.length > 0 && dickbutt_.code.length > 0 && spcxc_.code.length > 0, "not contract");
        require(dickbutt_ != spcxc_, "same token");
        require(unlockTime_ > block.timestamp && unlockTime_ <= block.timestamp + 100 * 365 days, "invalid unlock time");
        require(minInterval_ <= 30 days, "interval too long");
        positionManager = INonfungiblePositionManager(positionManager_);
        tokenId = tokenId_;
        dickbutt = IERC20(dickbutt_);
        spcxc = IERC20(spcxc_);
        burnAddress = burnAddress_;
        spcxcDestination = spcxcDestination_;
        unlockTime = unlockTime_;
        minInterval = minInterval_;
    }

    // ---------------------------------------------------------------
    // The only operational function
    // ---------------------------------------------------------------

    /// @notice Claim accumulated LP fees and route them. Permissionless: the
    /// caller picks nothing and gains nothing, so anyone can keep the system
    /// running if our bot is down.
    /// @dev minInterval only prevents someone spamming this every block and
    /// fragmenting accounting into dust. It is not a security control.
    function harvest() external nonReentrant returns (uint256 dickbuttBurned, uint256 spcxcForwarded) {
        require(lastHarvestAt == 0 || block.timestamp >= lastHarvestAt + minInterval, "too soon");
        lastHarvestAt = block.timestamp;

        // Collect both sides to this contract, then split by token. Doing it
        // this way means we never depend on knowing which side is token0.
        positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId, recipient: address(this), amount0Max: type(uint128).max, amount1Max: type(uint128).max
            })
        );

        dickbuttBurned = dickbutt.balanceOf(address(this));
        if (dickbuttBurned > 0) dickbutt.safeTransfer(burnAddress, dickbuttBurned);

        spcxcForwarded = spcxc.balanceOf(address(this));
        if (spcxcForwarded > 0) spcxc.safeTransfer(spcxcDestination, spcxcForwarded);

        emit Harvested(msg.sender, dickbuttBurned, spcxcForwarded);
    }

    /// @notice Sanity check that this contract really holds the position.
    function holdsPosition() external view returns (bool) {
        return positionManager.ownerOf(tokenId) == address(this);
    }

    // ---------------------------------------------------------------
    // SPCXc destination (timelocked, freezable)
    // ---------------------------------------------------------------

    function proposeDestination(address newDestination) external onlyOwner {
        require(!destinationLocked, "destination locked forever");
        require(newDestination != address(0), "bad destination");
        pendingDestination = newDestination;
        pendingDestinationReadyAt = block.timestamp + destinationDelay;
        emit DestinationChangeProposed(newDestination, pendingDestinationReadyAt);
    }

    function applyDestination() external {
        require(!destinationLocked, "destination locked forever");
        require(pendingDestination != address(0), "nothing pending");
        require(block.timestamp >= pendingDestinationReadyAt, "still timelocked");

        address old = spcxcDestination;
        spcxcDestination = pendingDestination;
        pendingDestination = address(0);
        pendingDestinationReadyAt = 0;
        emit DestinationChanged(old, spcxcDestination);
    }

    function cancelDestinationChange() external onlyOwner {
        require(!destinationLocked, "destination locked forever");
        emit DestinationChangeCancelled(pendingDestination);
        pendingDestination = address(0);
        pendingDestinationReadyAt = 0;
    }

    /// @notice ONE-WAY. After this no key can change where fees go.
    function lockDestinationForever() external onlyOwner {
        require(!destinationLocked, "already locked");
        require(pendingDestination == address(0), "cancel pending change first");
        destinationLocked = true;
        emit DestinationLockedForever(spcxcDestination);
    }

    // ---------------------------------------------------------------
    // The liquidity lock
    // ---------------------------------------------------------------

    /// @notice ONE-WAY. Gives up the ability to ever withdraw the LP
    /// position. Fee harvesting continues to work normally. Call this if you
    /// want a provably permanent lock that holders can verify on-chain.
    function lockForever() external onlyOwner {
        require(!lockedForever, "already locked forever");
        lockedForever = true;
        emit LiquidityLockedForever(tokenId);
    }

    /// @notice Extend the lock. Can only ever move unlockTime later, never
    /// earlier -- otherwise the lock would be meaningless.
    function extendLock(uint256 newUnlockTime) external onlyOwner {
        require(!lockedForever, "locked forever");
        require(newUnlockTime > unlockTime, "can only extend");
        require(
            newUnlockTime > block.timestamp && newUnlockTime <= block.timestamp + 100 * 365 days, "invalid unlock time"
        );
        unlockTime = newUnlockTime;
    }

    /// @notice Withdraw the LP position after the lock expires. Reverts
    /// forever if lockForever() was called.
    function withdrawPosition(address to) external onlyOwner nonReentrant {
        require(!lockedForever, "locked forever");
        require(block.timestamp >= unlockTime, "still locked");
        require(to != address(0), "bad recipient");
        positionManager.safeTransferFrom(address(this), to, tokenId);
        emit PositionWithdrawn(to, tokenId);
    }

    // ---------------------------------------------------------------
    // Misc
    // ---------------------------------------------------------------

    /// @notice Rescue tokens that are not part of the fee flow. Cannot touch
    /// DICKBUTT or SPCXc -- those only ever leave via harvest(), to their
    /// fixed destinations.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(dickbutt) && token != address(spcxc), "use harvest()");
        require(to != address(0), "bad recipient");
        IERC20(token).safeTransfer(to, amount);
    }

    function onERC721Received(address, address, uint256 receivedId, bytes calldata)
        external
        view
        override
        returns (bytes4)
    {
        require(msg.sender == address(positionManager) && receivedId == tokenId, "unexpected NFT");
        return IERC721Receiver.onERC721Received.selector;
    }
}
