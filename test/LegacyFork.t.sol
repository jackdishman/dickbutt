// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/LegacyFeeHarvester.sol";

interface LegacyForkVm {
    function envOr(string calldata, string calldata) external returns (string memory);
    function createSelectFork(string calldata, uint256) external returns (uint256);
    function skip(bool) external;
    function prank(address) external;
}

interface LegacyLiveModule is ILegacyFeeModule {
    function updateTokenCreator(address token, address creator) external;
    function teamGrantedTokensMap(address token) external view returns (bool);
}

interface LegacyLiveLocker {
    function owner() external view returns (address);
    function collectFees(address recipient, uint256 tokenId) external;
    function _feeRecipient() external view returns (address);
}

/// @dev Local fork impersonation only; no signed or broadcast transactions.
contract LegacyForkTest {
    LegacyForkVm constant vm = LegacyForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant MODULE = 0x10F4485d6f90239B72c6A5eaD2F2320993D285E4;
    address constant CURRENT_SAFE = 0x1eaf444ebDf6495C57aD52A04C61521bBf564ace;
    address constant HISTORIC_SAFE = 0x04F6ef12a8B6c2346C8505eE4Cff71C43D2dd825;
    address constant DICK = 0x2D57C47BC5D2432FEEEdf2c9150162A9862D3cCf;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant LOCKER = 0x2Ad4DB8ba8de03834DB14454Afcd74C2393d81C4;
    address constant CREATOR = 0xDF3eFAfdA19D2dF229eF3fbEC73d2EE6C5fB6d7c;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) { vm.skip(true); return; }
        vm.createSelectFork(rpc, 51223062);
    }

    function testForkRealModuleClaimsBothSafesAfterLockerCollection() public {
        require(block.chainid == 8453, "wrong chain");
        require(LegacyLiveModule(MODULE).tokenCreator(DICK) == CREATOR, "creator drift");
        require(!LegacyLiveModule(MODULE).teamGrantedTokensMap(DICK), "team privilege");
        require(LegacyLiveLocker(LOCKER)._feeRecipient() == CURRENT_SAFE, "sink drift");
        address[] memory safes = new address[](2);
        safes[0] = CURRENT_SAFE;
        safes[1] = HISTORIC_SAFE;
        address destination = address(0xBEEF);
        LegacyFeeHarvester adapter = new LegacyFeeHarvester(MODULE, safes, DICK, destination);

        // Real LP accrual supplies real tokens. No fabricated ERC20 storage or token mock.
        vm.prank(LegacyLiveLocker(LOCKER).owner());
        LegacyLiveLocker(LOCKER).collectFees(address(this), 1391176);
        uint256 currentFees = IERC20(DICK).balanceOf(CURRENT_SAFE);
        require(currentFees > 0, "no accrued fees at pinned block");
        uint256 historicalFunding = IERC20(DICK).balanceOf(address(this)) / 2;
        require(historicalFunding > 0, "no creator collection");
        // Both live Safe balances were zero; simulate old unclaimed fees on this fork.
        IERC20(DICK).transfer(HISTORIC_SAFE, historicalFunding);
        uint256 historicFees = IERC20(DICK).balanceOf(HISTORIC_SAFE);
        uint256 safeWeth = IERC20(WETH).balanceOf(CURRENT_SAFE);

        vm.prank(CREATOR);
        LegacyLiveModule(MODULE).updateTokenCreator(DICK, address(adapter));
        require(adapter.isTokenCreator(), "handoff failed");
        require(LegacyLiveLocker(LOCKER).owner() == CREATOR, "locker authority changed");
        vm.prank(address(0xBAD));
        require(adapter.harvest() == currentFees, "current claim mismatch");
        vm.prank(address(0xBAD));
        require(adapter.harvestFrom(1) == historicFees, "historic claim mismatch");
        require(IERC20(DICK).balanceOf(destination) == currentFees + historicFees, "destination mismatch");
        require(IERC20(DICK).balanceOf(CURRENT_SAFE) == 0, "current balance remains");
        require(IERC20(DICK).balanceOf(HISTORIC_SAFE) == 0, "historic balance remains");
        require(IERC20(WETH).balanceOf(CURRENT_SAFE) == safeWeth, "WETH moved");
        require(adapter.harvest() == 0 && adapter.harvestFrom(1) == 0, "empty claim reverted");
    }
}
