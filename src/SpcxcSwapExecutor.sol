// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev Aerodrome Slipstream ISpcxcSwapRouter exactInput ABI. Paths encode signed
/// int24 tick spacings, not Uniswap fee tiers. Verify the configured deployment.
interface ISpcxcSwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Swaps the WETH allocation received from Splits to the fixed rewards distributor.
/// @dev The expiring owner floor is an administrative limit, not an oracle. Only
/// standard, non-rebasing, non-fee-on-transfer tokens are supported. No percentages
/// are computed here. Gas must be funded externally.
contract SpcxcSwapExecutor is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant MAX_FLOOR_LIFETIME = 1 days;
    IERC20 public immutable weth;
    IERC20 public immutable spcxc;
    ISpcxcSwapRouter public immutable router;
    address public immutable distributor;
    bytes public swapPath;
    uint256 public maxSwapPerCall;
    uint256 public minSwapInterval;
    uint256 public lastSwapAt;
    bool private hasSwapped;
    uint256 public minSpcxcPerWeth;
    uint256 public priceFloorExpiresAt;
    mapping(address => bool) public isKeeper;
    event WethProcessed(uint256 swapped, uint256 spcxcOut);
    event KeeperUpdated(address indexed keeper, bool allowed);
    event SwapLimitsUpdated(uint256 maxSwapPerCall, uint256 minSwapInterval);
    event PriceFloorUpdated(uint256 minSpcxcPerWeth, uint256 expiresAt);
    modifier onlyKeeper() {
        require(isKeeper[msg.sender], "not a keeper");
        _;
    }

    constructor(
        address weth_,
        address spcxc_,
        address router_,
        address distributor_,
        address intermediate_,
        int24 firstTickSpacing_,
        int24 secondTickSpacing_,
        uint256 maxSwapPerCall_,
        uint256 minSwapInterval_,
        address owner_
    ) Ownable(owner_) {
        require(
            weth_.code.length > 0 && spcxc_.code.length > 0 && router_.code.length > 0
                && intermediate_.code.length > 0,
            "bad contract"
        );
        require(
            weth_ != spcxc_ && intermediate_ != weth_ && intermediate_ != spcxc_,
            "duplicate token"
        );
        require(
            distributor_ != address(0) && distributor_ != address(this) && distributor_ != weth_
                && distributor_ != spcxc_ && distributor_ != intermediate_ && distributor_ != router_,
            "bad recipient"
        );
        require(firstTickSpacing_ > 0 && secondTickSpacing_ > 0, "bad spacing");
        require(maxSwapPerCall_ > 0, "cap must be set");
        weth = IERC20(weth_);
        spcxc = IERC20(spcxc_);
        router = ISpcxcSwapRouter(router_);
        distributor = distributor_;
        swapPath = abi.encodePacked(weth_, firstTickSpacing_, intermediate_, secondTickSpacing_, spcxc_);
        maxSwapPerCall = maxSwapPerCall_;
        minSwapInterval = minSwapInterval_;
    }

    /// @param minOut Keeper can tighten the owner floor, including by supplying
    /// a quote-derived floor. Zero means use the enforced protocol floor.
    /// @param deadline Absolute transaction expiry, fixed before signing.
    function processWeth(uint256 minOut, uint256 deadline) external onlyKeeper nonReentrant returns (uint256 spcxcOut) {
        require(deadline >= block.timestamp, "deadline already passed");
        require(minSpcxcPerWeth > 0 && block.timestamp <= priceFloorExpiresAt, "price floor expired");
        require(!hasSwapped || block.timestamp - lastSwapAt >= minSwapInterval, "cooldown active");
        uint256 balance = weth.balanceOf(address(this));
        require(balance > 0, "nothing to process");
        uint256 amount = Math.min(balance, maxSwapPerCall);
        uint256 floor = Math.mulDiv(amount, minSpcxcPerWeth, 1e18, Math.Rounding.Ceil);
        uint256 minimum = Math.max(minOut, floor);
        lastSwapAt = block.timestamp;
        hasSwapped = true;
        uint256 beforeOut = spcxc.balanceOf(distributor);
        weth.forceApprove(address(router), amount);
        router.exactInput(ISpcxcSwapRouter.ExactInputParams(swapPath, distributor, deadline, amount, minimum));
        weth.forceApprove(address(router), 0);
        spcxcOut = spcxc.balanceOf(distributor) - beforeOut;
        require(spcxcOut >= minimum, "insufficient actual output");
        require(weth.balanceOf(address(this)) == balance - amount, "incorrect input spent");
        emit WethProcessed(amount, spcxcOut);
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        require(keeper != address(0), "bad keeper");
        isKeeper[keeper] = allowed;
        emit KeeperUpdated(keeper, allowed);
    }

    function setSwapLimits(uint256 cap, uint256 interval) external onlyOwner {
        require(cap > 0, "cap must be set");
        maxSwapPerCall = cap;
        minSwapInterval = interval;
        emit SwapLimitsUpdated(cap, interval);
    }

    function setPriceFloor(uint256 floor, uint256 expiresAt) external onlyOwner {
        require(floor > 0, "zero floor");
        require(expiresAt > block.timestamp && expiresAt - block.timestamp <= MAX_FLOOR_LIFETIME, "bad expiry");
        minSpcxcPerWeth = floor;
        priceFloorExpiresAt = expiresAt;
        emit PriceFloorUpdated(floor, expiresAt);
    }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        require(token != address(weth) && token != address(spcxc), "protected token");
        require(to != address(0), "bad recipient");
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice For SPCXc accidentally transferred here; only the fixed rewards destination.
    function forwardSpcxc() external nonReentrant {
        spcxc.safeTransfer(distributor, spcxc.balanceOf(address(this)));
    }

    /// @notice Recover forcibly sent ETH; no payable receive or WETH unwrapping.
    function rescueETH(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "bad recipient");
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "eth transfer failed");
    }
}
