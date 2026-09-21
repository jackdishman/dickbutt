// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAerodromeVammPool is IERC20 {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function stable() external view returns (bool);
    function claimFees() external returns (uint256 claimed0, uint256 claimed1);
    function claimable0(address) external view returns (uint256);
    function claimable1(address) external view returns (uint256);
}

interface IAerodromeVammFactory {
    function isPool(address) external view returns (bool);
    function getPool(address tokenA, address tokenB, bool stable) external view returns (address);
}

/// @notice Custodies one basic volatile pool's ERC20 LP tokens, claims the held share's
/// fees, burns DICKBUTT and forwards SPCXc to the rewards destination. No NFT is involved.
/// @dev Deploy only against the independently verified Aerodrome factory. LP tokens
/// remain unstaked: there are no approvals, gauge interactions or removeLiquidity calls.
/// Any LP tokens sent here share this contract's lock; depositors gain no withdrawal rights.
/// Fees accrued before an LP transfer stay with the prior holder under pool accounting.
contract AerodromeVammHarvester is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IAerodromeVammPool public immutable pool;
    address public immutable factory;
    IERC20 public immutable dickbutt;
    IERC20 public immutable spcxc;
    address public immutable burnAddress;
    uint256 public immutable minInterval;

    address public spcxcDestination;
    address public pendingDestination;
    uint256 public pendingDestinationReadyAt;
    uint256 public constant destinationDelay = 7 days;
    bool public destinationLocked;
    uint256 public unlockTime;
    bool public lockedForever;
    uint256 public lastHarvestAt;

    event Harvested(address indexed caller, uint256 dickbuttBurned, uint256 spcxcForwarded);
    event DestinationChangeProposed(address indexed destination, uint256 readyAt);
    event DestinationChanged(address indexed oldDestination, address indexed newDestination);
    event DestinationChangeCancelled(address indexed destination);
    event DestinationLockedForever(address indexed destination);
    event LiquidityLockedForever(address indexed pool);
    event LockExtended(uint256 unlockTime);
    event LiquidityWithdrawn(address indexed to, uint256 amount);

    constructor(
        address factory_, address pool_, address dickbutt_, address spcxc_,
        address burnAddress_, address spcxcDestination_, uint256 unlockTime_,
        uint256 minInterval_, address owner_
    ) Ownable(owner_) {
        require(factory_.code.length > 0 && pool_.code.length > 0
            && dickbutt_.code.length > 0 && spcxc_.code.length > 0, "not contract");
        require(dickbutt_ != spcxc_ && pool_ != dickbutt_ && pool_ != spcxc_, "bad token pair");
        require(burnAddress_ != address(0) && burnAddress_ != address(this)
            && burnAddress_ != pool_ && burnAddress_ != dickbutt_ && burnAddress_ != spcxc_
            && burnAddress_ != factory_, "bad burn recipient");
        IAerodromeVammPool candidate = IAerodromeVammPool(pool_);
        require(candidate.factory() == factory_ && IAerodromeVammFactory(factory_).isPool(pool_)
            && IAerodromeVammFactory(factory_).getPool(dickbutt_, spcxc_, false) == pool_, "wrong factory pool");
        require(!candidate.stable(), "requires volatile pool");
        address t0 = candidate.token0(); address t1 = candidate.token1();
        require((t0 == dickbutt_ && t1 == spcxc_) || (t0 == spcxc_ && t1 == dickbutt_), "wrong pool tokens");
        require(unlockTime_ > block.timestamp && unlockTime_ <= block.timestamp + 100 * 365 days, "invalid unlock time");
        require(minInterval_ <= 30 days, "interval too long");
        factory = factory_; pool = candidate;
        dickbutt = IERC20(dickbutt_); spcxc = IERC20(spcxc_); burnAddress = burnAddress_;
        _checkDestination(spcxcDestination_);
        spcxcDestination = spcxcDestination_; unlockTime = unlockTime_; minInterval = minInterval_;
    }

    /// @notice Anyone may pay gas; the caller cannot choose the fee recipient.
    /// Donation balances in the fee tokens are swept too; sending them here does not add liquidity.
    function harvest() external nonReentrant returns (uint256 dickbuttBurned, uint256 spcxcForwarded) {
        require(lastHarvestAt == 0 || block.timestamp >= lastHarvestAt + minInterval, "too soon");
        uint256 principal = pool.balanceOf(address(this));
        lastHarvestAt = block.timestamp;
        pool.claimFees();
        require(pool.balanceOf(address(this)) == principal, "LP principal changed");
        dickbuttBurned = dickbutt.balanceOf(address(this));
        spcxcForwarded = spcxc.balanceOf(address(this));
        if (dickbuttBurned != 0) dickbutt.safeTransfer(burnAddress, dickbuttBurned);
        if (spcxcForwarded != 0) spcxc.safeTransfer(spcxcDestination, spcxcForwarded);
        emit Harvested(msg.sender, dickbuttBurned, spcxcForwarded);
    }

    /// @notice Uniform fee-runner readiness interface. Includes booked fees left after an
    /// unlocked withdrawal, so the last earned fees can still be forwarded with zero LP balance.
    function holdsPosition() external view returns (bool) {
        return pool.balanceOf(address(this)) > 0 || pool.claimable0(address(this)) > 0
            || pool.claimable1(address(this)) > 0 || dickbutt.balanceOf(address(this)) > 0
            || spcxc.balanceOf(address(this)) > 0;
    }

    function proposeDestination(address newDestination) external onlyOwner {
        require(!destinationLocked, "destination locked forever");
        _checkDestination(newDestination);
        pendingDestination = newDestination; pendingDestinationReadyAt = block.timestamp + destinationDelay;
        emit DestinationChangeProposed(newDestination, pendingDestinationReadyAt);
    }
    function applyDestination() external {
        require(!destinationLocked, "destination locked forever");
        require(pendingDestination != address(0), "nothing pending");
        require(block.timestamp >= pendingDestinationReadyAt, "still timelocked");
        address old = spcxcDestination;
        spcxcDestination = pendingDestination; pendingDestination = address(0); pendingDestinationReadyAt = 0;
        emit DestinationChanged(old, spcxcDestination);
    }
    function cancelDestinationChange() external onlyOwner {
        require(!destinationLocked, "destination locked forever");
        emit DestinationChangeCancelled(pendingDestination);
        pendingDestination = address(0); pendingDestinationReadyAt = 0;
    }
    function lockDestinationForever() external onlyOwner {
        require(!destinationLocked, "already locked");
        require(pendingDestination == address(0), "cancel pending change first");
        destinationLocked = true; emit DestinationLockedForever(spcxcDestination);
    }

    function lockForever() external onlyOwner {
        require(!lockedForever, "already locked forever");
        lockedForever = true; emit LiquidityLockedForever(address(pool));
    }
    function extendLock(uint256 newUnlockTime) external onlyOwner {
        require(!lockedForever, "locked forever");
        require(newUnlockTime > unlockTime, "can only extend");
        require(newUnlockTime > block.timestamp && newUnlockTime <= block.timestamp + 100 * 365 days, "invalid unlock time");
        unlockTime = newUnlockTime; emit LockExtended(newUnlockTime);
    }
    /// @notice Transfers LP ownership only after unlock. It does not remove liquidity or
    /// transfer previously accrued fee entitlement; harvest() can collect that separately.
    function withdrawLiquidity(address to, uint256 amount) external onlyOwner nonReentrant {
        require(!lockedForever, "locked forever");
        require(block.timestamp >= unlockTime, "still locked");
        require(to != address(0) && to != address(this) && to != address(pool), "bad recipient");
        require(amount > 0, "zero amount");
        IERC20(address(pool)).safeTransfer(to, amount);
        emit LiquidityWithdrawn(to, amount);
    }
    function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        require(token != address(pool) && token != address(dickbutt) && token != address(spcxc), "protected token");
        require(to != address(0) && to != address(this), "bad recipient");
        IERC20(token).safeTransfer(to, amount);
    }
    function _checkDestination(address target) private view {
        require(target != address(0) && target != address(this) && target != address(pool)
            && target != address(dickbutt) && target != address(spcxc) && target != burnAddress
            && target != factory, "bad destination");
    }
}
