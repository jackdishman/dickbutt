// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Support.sol";
import "../src/LegacyFeeHarvester.sol";

contract LegacySafeMock {
    address public module;
    constructor(address module_) { module = module_; }
    function isModuleEnabled(address candidate) external view returns (bool) { return candidate == module; }
    function setModule(address candidate) external { module = candidate; }
    function transferToken(address token, address destination, uint256 amount) external {
        require(msg.sender == module, "disabled module");
        require(IERC20(token).transfer(destination, amount), "transfer failed");
    }
}

contract LegacyModuleMock {
    mapping(address => address) public tokenCreator;
    function updateTokenCreator(address token, address creator) external { tokenCreator[token] = creator; }
    function tokenCreatorTransfer(address safe, address token, address destination) external {
        require(tokenCreator[token] == msg.sender, "not creator");
        uint256 amount = IERC20(token).balanceOf(safe);
        require(amount > 0, "empty safe");
        LegacySafeMock(safe).transferToken(token, destination, amount);
    }
}

contract LegacyFeesTest is Support {
    RewardMock token;
    LegacyModuleMock module;
    LegacySafeMock safe;
    LegacyFeeHarvester harvester;
    address constant DESTINATION = address(0xBEEF);

    function _safes(address first) internal pure returns (address[] memory safes) {
        safes = new address[](1);
        safes[0] = first;
    }

    function setUp() public {
        token = new RewardMock();
        module = new LegacyModuleMock();
        safe = new LegacySafeMock(address(module));
        harvester = new LegacyFeeHarvester(address(module), _safes(address(safe)), address(token), DESTINATION);
        module.updateTokenCreator(address(token), address(harvester));
    }

    function testPermissionlessHarvestIncludesHistoricFeesAndKeepsOtherAssets() public {
        token.mint(address(safe), 90 ether);
        RewardMock other = new RewardMock();
        other.mint(address(safe), 7 ether);
        vm.prank(address(0xBAD));
        eq(harvester.harvest(), 90 ether);
        eq(token.balanceOf(DESTINATION), 90 ether);
        eq(token.balanceOf(address(0xBAD)), 0);
        eq(token.balanceOf(address(safe)), 0);
        eq(other.balanceOf(address(safe)), 7 ether);
        token.mint(address(safe), 10 ether);
        eq(harvester.harvest(), 10 ether);
        eq(token.balanceOf(DESTINATION), 100 ether);
    }

    function testEmptySafeIsNoOp() public { eq(harvester.harvest(), 0); }

    function testLegacyAuthorityRequiredEvenWhenEmpty() public {
        module.updateTokenCreator(address(token), address(this));
        require(!harvester.isTokenCreator(), "unexpected authority");
        vm.expectRevert(bytes("not token creator"));
        harvester.harvest();
    }

    function testDisabledModuleCannotHarvest() public {
        safe.setModule(address(1));
        token.mint(address(safe), 1 ether);
        vm.expectRevert();
        harvester.harvest();
        eq(token.balanceOf(address(safe)), 1 ether);
    }

    function testRecipientTransferFailurePreservesFees() public {
        token.mint(address(safe), 1 ether);
        token.setBlocked(DESTINATION, true);
        vm.expectRevert();
        harvester.harvest();
        eq(token.balanceOf(address(safe)), 1 ether);
    }

    function testConstructorRejectsDisabledModule() public {
        safe.setModule(address(1));
        vm.expectRevert(bytes("module not enabled"));
        new LegacyFeeHarvester(address(module), _safes(address(safe)), address(token), DESTINATION);
    }

    function testConstructorRejectsInvalidAddresses() public {
        vm.expectRevert();
        new LegacyFeeHarvester(address(module), _safes(address(safe)), address(token), address(0));
        vm.expectRevert();
        new LegacyFeeHarvester(address(module), _safes(address(safe)), address(token), address(safe));
        vm.expectRevert();
        new LegacyFeeHarvester(address(1), _safes(address(safe)), address(token), DESTINATION);
        vm.expectRevert();
        new LegacyFeeHarvester(address(module), _safes(address(1)), address(token), DESTINATION);
        vm.expectRevert();
        new LegacyFeeHarvester(address(module), _safes(address(safe)), address(1), DESTINATION);
    }

    function testHistoricalSafeUsesSameCreatorAndFixedDestination() public {
        LegacySafeMock historical = new LegacySafeMock(address(module));
        address[] memory safes = new address[](2);
        safes[0] = address(safe);
        safes[1] = address(historical);
        harvester = new LegacyFeeHarvester(address(module), safes, address(token), DESTINATION);
        module.updateTokenCreator(address(token), address(harvester));
        token.mint(address(historical), 42 ether);
        vm.prank(address(0xBAD));
        eq(harvester.harvestFrom(1), 42 ether);
        eq(token.balanceOf(DESTINATION), 42 ether);
        eq(harvester.safeCount(), 2);
        vm.expectRevert();
        harvester.harvestFrom(2);
    }

    function testRejectsEmptyAndDuplicateSafeList() public {
        address[] memory safes = new address[](0);
        vm.expectRevert();
        new LegacyFeeHarvester(address(module), safes, address(token), DESTINATION);
        safes = new address[](2);
        safes[0] = address(safe);
        safes[1] = address(safe);
        vm.expectRevert();
        new LegacyFeeHarvester(address(module), safes, address(token), DESTINATION);
    }

    function testFuzzCallerCannotRedirect(address caller, uint96 amount) public {
        token.mint(address(safe), amount);
        vm.prank(caller);
        eq(harvester.harvest(), amount);
        eq(token.balanceOf(DESTINATION), amount);
    }
}
