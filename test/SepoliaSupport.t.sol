// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Support.sol";
import "../script/SepoliaSupport.sol";

/// The testnet stand-ins are deployed to a public chain where anyone can call them, and the
/// deployment hands locker ownership to a contract. Both facts have bitten this file already.
contract SepoliaSupportTest is Support {
    SepoliaToken weth;
    SepoliaToken spcxc;
    SepoliaToken dick;
    SepoliaLocker locker;
    SepoliaPositionManager manager;
    address constant STRANGER = address(0xBAD);
    address constant HARVESTER = address(0xC0FFEE);

    function setUp() public {
        weth = new SepoliaToken("W", "W", 18);
        spcxc = new SepoliaToken("S", "S", 8);
        dick = new SepoliaToken("D", "D", 18);
        manager = new SepoliaPositionManager();
        locker = new SepoliaLocker(address(manager), address(weth), address(dick), address(this), 7);
    }

    /// Regression: fee size was gated on `owner`, which the deployment transfers to
    /// LockerHarvester. A contract cannot call setFeeAmounts, so the amounts froze forever.
    function testFeeAmountsStayAdjustableAfterOwnershipHandoff() public {
        locker.transferOwnership(HARVESTER);
        eq(uint256(uint160(locker.owner())), uint256(uint160(HARVESTER)));
        locker.setFeeAmounts(0.5 ether, 1 ether);
        eq(locker.wethPerCollect(), 0.5 ether);
        eq(locker.dickbuttPerCollect(), 1 ether);
    }

    function testOnlyFeeAdminAdjustsFeesAndTheRoleIsTransferable() public {
        vm.prank(STRANGER);
        vm.expectRevert(bytes("not fee admin"));
        locker.setFeeAmounts(1, 1);

        locker.setFeeAdmin(STRANGER);
        vm.prank(STRANGER);
        locker.setFeeAmounts(7, 9);
        eq(locker.wethPerCollect(), 7);
        // The old admin loses the role rather than sharing it.
        vm.expectRevert(bytes("not fee admin"));
        locker.setFeeAmounts(1, 1);
        vm.expectRevert(bytes("bad admin"));
        vm.prank(STRANGER);
        locker.setFeeAdmin(address(0));
    }

    /// Minting is an intentional faucet. Blocking a recipient is not: on a public testnet an
    /// unrestricted setBlocked lets any stranger stall the payout path.
    function testFaucetIsOpenButBlockingIsAdminOnly() public {
        vm.prank(STRANGER);
        weth.mint(STRANGER, 5 ether);
        eq(weth.balanceOf(STRANGER), 5 ether);

        vm.prank(STRANGER);
        vm.expectRevert(bytes("not admin"));
        weth.setBlocked(address(this), true);

        weth.setBlocked(address(this), true);
        vm.prank(STRANGER);
        vm.expectRevert(bytes("recipient blocked"));
        weth.transfer(address(this), 1);
        weth.setBlocked(address(this), false);
        vm.prank(STRANGER);
        require(weth.transfer(address(this), 1), "unblocked transfer");
    }

    function testPositionFeesAreAdminOnly() public {
        vm.prank(STRANGER);
        vm.expectRevert(bytes("not admin"));
        manager.configureFees(address(dick), address(spcxc), 1, 1);

        manager.configureFees(address(dick), address(spcxc), 5 ether, 1e8);
        manager.mint(address(this), 8);
        INonfungiblePositionManager.CollectParams memory p = INonfungiblePositionManager.CollectParams({
            tokenId: 8, recipient: address(this), amount0Max: type(uint128).max, amount1Max: type(uint128).max
        });
        (uint256 a0, uint256 a1) = manager.collect(p);
        eq(a0, 5 ether);
        eq(a1, 1e8);
        eq(dick.balanceOf(address(this)), 5 ether);
    }

    function testCollectRequiresPositionOwnership() public {
        manager.mint(address(this), 8);
        manager.configureFees(address(dick), address(spcxc), 1, 1);
        INonfungiblePositionManager.CollectParams memory p = INonfungiblePositionManager.CollectParams({
            tokenId: 8, recipient: STRANGER, amount0Max: type(uint128).max, amount1Max: type(uint128).max
        });
        vm.prank(STRANGER);
        vm.expectRevert(bytes("not position owner"));
        manager.collect(p);
    }

    /// A quoter that disagrees with the router it quotes for makes the price floor meaningless.
    function testQuoterAgreesWithTheRouterItQuotesFor() public {
        SepoliaSwapRouter router = new SepoliaSwapRouter(address(weth), address(spcxc), 2 * 1e8);
        SepoliaQuoter quoter = new SepoliaQuoter(address(router));
        for (uint256 amount = 1; amount <= 1e18; amount *= 10) {
            (uint256 quoted,,,) = quoter.quoteExactInput("", amount);
            eq(quoted, router.quote(amount));
        }
        eq(router.quote(1e18), 2e8);
        // A realistic per-1e18 rate floors sub-1e10 inputs to zero; that is why testnet fee
        // amounts default to realistic magnitudes rather than the rehearsal's 1000 wei.
        eq(router.quote(1000), 0);
    }

    function testRouterHonoursDeadlineAndMinimumOutput() public {
        SepoliaSwapRouter router = new SepoliaSwapRouter(address(weth), address(spcxc), 2 * 1e8);
        weth.mint(address(this), 1 ether);
        weth.approve(address(router), 1 ether);
        ISpcxcSwapRouter.ExactInputParams memory p = ISpcxcSwapRouter.ExactInputParams({
            path: "", recipient: address(this), deadline: block.timestamp - 1, amountIn: 1 ether, amountOutMinimum: 0
        });
        vm.expectRevert(bytes("expired"));
        router.exactInput(p);

        p.deadline = block.timestamp + 60;
        p.amountOutMinimum = 2e8 + 1;
        vm.expectRevert(bytes("insufficient output"));
        router.exactInput(p);

        p.amountOutMinimum = 2e8;
        eq(router.exactInput(p), 2e8);
        eq(spcxc.balanceOf(address(this)), 2e8);
    }
}
