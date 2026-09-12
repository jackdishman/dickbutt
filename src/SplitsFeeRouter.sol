// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./SplitsV2Interfaces.sol";
import "./SpcxcSwapExecutor.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Token-specific adapter to two immutable, genuine upstream PushSplit V2 contracts.
/// @dev Deploy using the independently verified protocol factory. No owner, rescue,
/// generic calls, or mutable destinations. Protocol contracts themselves accept any
/// ERC20: send fees to this adapter, not to the wrong underlying split. Unexpected
/// tokens at the adapter cannot be redirected and remain stranded.
contract SplitsFeeRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    IPushSplitFactoryV2 public immutable factory;
    IERC20 public immutable weth;
    IERC20 public immutable dickbutt;
    address public immutable kcGreen;
    address public immutable burnAddress;
    address public immutable cdbVault;
    address public immutable swapExecutor;
    address public immutable dickSplit;
    address public immutable wethSplit;

    event FeesRouted(address indexed token, address indexed split, uint256 forwarded);

    constructor(
        address factory_, address weth_, address dickbutt_, address kcGreen_,
        address burnAddress_, address cdbVault_, address swapExecutor_
    ) {
        require(factory_.code.length > 0 && weth_.code.length > 0 && dickbutt_.code.length > 0
            && swapExecutor_.code.length > 0, "bad contract");
        require(weth_ != dickbutt_, "duplicate token");
        require(kcGreen_ != address(0) && burnAddress_ != address(0) && cdbVault_ != address(0), "bad recipient");
        address[4] memory recipients = [kcGreen_, burnAddress_, cdbVault_, swapExecutor_];
        for (uint256 i; i < recipients.length; ++i) {
            require(recipients[i] != address(this) && recipients[i] != factory_
                && recipients[i] != weth_ && recipients[i] != dickbutt_, "bad recipient");
            for (uint256 j; j < i; ++j) require(recipients[i] != recipients[j], "duplicate recipient");
        }
        require(address(SpcxcSwapExecutor(swapExecutor_).weth()) == weth_, "executor token mismatch");
        factory = IPushSplitFactoryV2(factory_);
        weth = IERC20(weth_);
        dickbutt = IERC20(dickbutt_);
        kcGreen = kcGreen_;
        burnAddress = burnAddress_;
        cdbVault = cdbVault_;
        swapExecutor = swapExecutor_;
        address implementation = factory.SPLIT_WALLET_IMPLEMENTATION();
        require(implementation.code.length > 0 && IPushSplitV2(implementation).FACTORY() == factory_, "bad factory binding");
        SplitsV2.Split memory dickConfig = dickSplitConfig();
        SplitsV2.Split memory wethConfig = wethSplitConfig();
        dickSplit = factory.createSplit(dickConfig, address(0), address(this));
        wethSplit = factory.createSplit(wethConfig, address(0), address(this));
        require(dickSplit != wethSplit, "same split");
        _validateSplit(dickSplit, dickConfig);
        _validateSplit(wethSplit, wethConfig);
    }

    /// @notice Flush this adapter's DICK and distribute any existing DICK at the Split/Warehouse.
    function splitDickbutt() external nonReentrant { _route(dickbutt, dickSplit, dickSplitConfig()); }

    /// @notice Flush this adapter's WETH and distribute any existing WETH at the Split/Warehouse.
    function splitWeth() external nonReentrant { _route(weth, wethSplit, wethSplitConfig()); }

    function dickSplitConfig() public view returns (SplitsV2.Split memory config) {
        config.recipients = new address[](2);
        config.allocations = new uint256[](2);
        config.recipients[0] = kcGreen; config.recipients[1] = burnAddress;
        config.allocations[0] = 1; config.allocations[1] = 9;
        config.totalAllocation = 10;
    }

    function wethSplitConfig() public view returns (SplitsV2.Split memory config) {
        config.recipients = new address[](3);
        config.allocations = new uint256[](3);
        config.recipients[0] = kcGreen; config.recipients[1] = cdbVault; config.recipients[2] = swapExecutor;
        config.allocations[0] = 1; config.allocations[1] = 1; config.allocations[2] = 8;
        config.totalAllocation = 10;
    }

    function _route(IERC20 token, address split, SplitsV2.Split memory config) private {
        uint256 amount = token.balanceOf(address(this));
        if (amount > 0) token.safeTransfer(split, amount);
        // Upstream retains one raw token unit in each nonempty location and
        // calls ERC20.transfer even for zero allocations. Avoid those calls
        // when only the protocol reserve (or no balance) remains.
        (uint256 splitBalance, uint256 warehouseBalance) = IPushSplitV2(split).getSplitBalance(address(token));
        if (splitBalance > 1 || warehouseBalance > 1) {
            IPushSplitV2(split).distribute(config, address(token), address(this));
        }
        emit FeesRouted(address(token), split, amount);
    }

    function _validateSplit(address split, SplitsV2.Split memory config) private view {
        require(split.code.length > 0 && IPushSplitV2(split).FACTORY() == address(factory), "bad split binding");
        require(IPushSplitV2(split).owner() == address(0), "mutable split");
        require(IPushSplitV2(split).splitHash() == keccak256(abi.encode(config)), "wrong split config");
    }
}
