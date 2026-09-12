// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../test/Integration.t.sol";

interface MockDeploymentVm {
    function startBroadcast(address signer) external;
    function stopBroadcast() external;
}

/// @notice Mock-only rehearsal deployment. Never uses production token addresses.
/// Run with `forge script script/DeployMocks.s.sol --sig "run(address)" <signer>`.
/// Broadcast is an explicit separate operator action; Base mainnet is rejected.
contract DeployMocks {
    MockDeploymentVm constant vm = MockDeploymentVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    event MockDeployment(
        address weth,
        address dickbutt,
        address spcxc,
        address router,
        address distributor,
        address splitter,
        address clankerHarvester,
        address aeroHarvester,
        address locker,
        address manager
    );

    function run(address signer) external {
        require(block.chainid == 84532 || block.chainid == 31337, "mock deployment: wrong chain");
        require(signer != address(0), "zero signer");
        vm.startBroadcast(signer);
        RewardMock w = new RewardMock();
        RewardMock d = new RewardMock();
        RewardMock s = new RewardMock();
        RewardMock u = new RewardMock();
        RouterMock router = new RouterMock(w, s);
        PositionMock manager = new PositionMock();
        DickbuttRewardsDistributor distributor = new DickbuttRewardsDistributor(address(s), 0, signer);
        FeeSplitter splitter = new FeeSplitter(
            address(w),
            address(d),
            address(s),
            address(router),
            address(101),
            address(102),
            address(103),
            address(distributor),
            address(u),
            100,
            200,
            1000,
            0,
            signer
        );
        FeeCycleLocker locker = new FeeCycleLocker(manager, w, d, signer);
        manager.mint(address(locker), 7);
        LockerHarvester clanker = new LockerHarvester(
            address(locker), address(manager), 7, address(splitter), 0, signer
        );
        locker.transferOwnership(address(clanker));
        AerodromeFeeHarvester aero = new AerodromeFeeHarvester(
            address(manager),
            8,
            address(d),
            address(s),
            address(102),
            address(distributor),
            block.timestamp + 365 days,
            0,
            signer
        );
        manager.mint(signer, 8);
        manager.safeTransferFrom(signer, address(aero), 8);
        manager.configureFees(d, s);
        splitter.setKeeper(signer, true);
        splitter.setPriceFloor(1e18, block.timestamp + 1 days);
        distributor.setKeeper(signer, true);
        vm.stopBroadcast();
        emit MockDeployment(
            address(w),
            address(d),
            address(s),
            address(router),
            address(distributor),
            address(splitter),
            address(clanker),
            address(aero),
            address(locker),
            address(manager)
        );
    }
}
