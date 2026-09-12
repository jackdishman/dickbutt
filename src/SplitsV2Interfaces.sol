// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev ABI-only definitions for the upstream Splits V2 protocol. No splitting implementation is copied here.
library SplitsV2 {
    struct Split {
        address[] recipients;
        uint256[] allocations;
        uint256 totalAllocation;
        uint16 distributionIncentive;
    }
}

interface IPushSplitFactoryV2 {
    function SPLIT_WALLET_IMPLEMENTATION() external view returns (address);
    function createSplit(SplitsV2.Split calldata config, address owner, address creator) external returns (address);
}

interface IPushSplitV2 {
    function FACTORY() external view returns (address);
    function SPLITS_WAREHOUSE() external view returns (address);
    function getSplitBalance(address token) external view returns (uint256 splitBalance, uint256 warehouseBalance);
    function owner() external view returns (address);
    function splitHash() external view returns (bytes32);
    function distribute(SplitsV2.Split calldata config, address token, address distributor) external;
    function updateSplit(SplitsV2.Split calldata config) external;
}
