// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./Support.sol";
import "../src/FeeSplitter.sol";

contract RouterMock {
    RewardMock public input;
    RewardMock public output;
    bytes public path;
    uint256 public minimum;
    uint256 public allowanceSeen;
    bool public lie;

    constructor(RewardMock a, RewardMock b) {
        input = a;
        output = b;
    }

    function setLie(bool value) external {
        lie = value;
    }

    function exactInput(ISwapRouter.ExactInputParams calldata p) external payable returns (uint256) {
        path = p.path;
        minimum = p.amountOutMinimum;
        allowanceSeen = input.allowance(msg.sender, address(this));
        input.transferFrom(msg.sender, address(this), p.amountIn);
        if (!lie) output.mint(p.recipient, p.amountIn * 2);
        return p.amountIn * 2;
    }
}

contract FeeSplitterTest is Support {
    RewardMock w;
    RewardMock d;
    RewardMock s;
    RewardMock u;
    RouterMock r;
    FeeSplitter f;
    address constant KC = address(101);
    address constant BURN = address(102);
    address constant CDB = address(103);
    address constant DIST = address(104);

    function setUp() public {
        w = new RewardMock();
        d = new RewardMock();
        s = new RewardMock();
        u = new RewardMock();
        r = new RouterMock(w, s);
        f = new FeeSplitter(
            address(w),
            address(d),
            address(s),
            address(r),
            KC,
            BURN,
            CDB,
            DIST,
            address(u),
            int24(100),
            int24(200),
            1000,
            60,
            address(this)
        );
        f.setKeeper(address(this), true);
        vm.warp(1000);
        f.setPriceFloor(1e18, block.timestamp + 1 hours);
    }

    function testFuzzFixedDickSplit(uint128 amount) public {
        if (amount == 0) amount = 1;
        d.mint(address(f), amount);
        f.splitDickbutt();
        eq(d.balanceOf(KC), uint256(amount) / 10);
        eq(d.balanceOf(BURN), uint256(amount) - uint256(amount) / 10);
        eq(d.balanceOf(address(f)), 0);
    }

    function testRouteAndAllowanceAndCap() public {
        w.mint(address(f), 2000);
        eq(f.processWeth(1, block.timestamp + 60), 1600);
        eq(w.balanceOf(KC), 100);
        eq(w.balanceOf(CDB), 100);
        eq(w.balanceOf(address(f)), 1000);
        eq(w.allowance(address(f), address(r)), 0);
        eq(r.allowanceSeen(), 800);
        eq(r.minimum(), 800);
        require(
            keccak256(r.path())
                == keccak256(abi.encodePacked(address(w), int24(100), address(u), int24(200), address(s))),
            "path"
        );
        vm.expectRevert();
        f.processWeth(1, block.timestamp + 60);
        vm.warp(block.timestamp + 60);
        vm.expectRevert();
        f.processWeth(1700, block.timestamp + 60);
    }

    function testRouterCannotLie() public {
        w.mint(address(f), 1000);
        r.setLie(true);
        vm.expectRevert();
        f.processWeth(1, block.timestamp + 60);
        eq(w.balanceOf(address(f)), 1000);
        eq(w.allowance(address(f), address(r)), 0);
    }

    function testExpiredFloorAndDeadline() public {
        w.mint(address(f), 1000);
        vm.expectRevert();
        f.processWeth(1, block.timestamp - 1);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert();
        f.processWeth(1, block.timestamp + 60);
    }

    function testNoGasDrain() public {
        w.mint(address(f), 1000);
        for (uint256 i; i < 10; i++) {
            (bool ok,) = address(f).call(abi.encodeWithSignature("topUpGas()"));
            require(!ok, "gas entry remains");
        }
        eq(w.balanceOf(address(f)), 1000);
    }

    function testAuthorizationAndRescue() public {
        vm.prank(address(999));
        vm.expectRevert();
        f.processWeth(1, block.timestamp + 60);
        vm.prank(address(999));
        vm.expectRevert();
        f.setPriceFloor(1, block.timestamp + 60);
        vm.expectRevert();
        f.rescueToken(address(w), KC, 1);
        vm.expectRevert();
        f.rescueToken(address(d), KC, 1);
        vm.expectRevert();
        f.rescueToken(address(s), KC, 1);
        u.mint(address(f), 1);
        f.rescueToken(address(u), KC, 1);
        eq(u.balanceOf(KC), 1);
    }

    function testFloorRounding() public {
        w.mint(address(f), 1);
        f.setPriceFloor(1, block.timestamp + 60);
        f.processWeth(0, block.timestamp + 60);
        eq(r.minimum(), 1);
    }

    function testFloorBounds() public {
        vm.expectRevert();
        f.setPriceFloor(0, block.timestamp + 60);
        vm.expectRevert();
        f.setPriceFloor(1, block.timestamp + 1 days + 1);
    }

    function testFuzzWethSplit(uint128 raw) public {
        uint256 amount = uint256(raw) + 1;
        f.setSwapLimits(amount, 0);
        w.mint(address(f), amount);
        f.processWeth(0, block.timestamp + 60);
        eq(w.balanceOf(KC), amount / 10);
        eq(w.balanceOf(CDB), amount / 10);
        eq(s.balanceOf(DIST), (amount - 2 * (amount / 10)) * 2);
        eq(w.balanceOf(address(f)), 0);
        eq(w.allowance(address(f), address(r)), 0);
    }

    function testRepeatedProcessingAndRevocation() public {
        w.mint(address(f), 3000);
        for (uint256 i; i < 3; i++) {
            vm.warp(1000 + i * 60);
            f.processWeth(0, 2000);
        }
        eq(w.balanceOf(KC), 300);
        eq(w.balanceOf(CDB), 300);
        eq(s.balanceOf(DIST), 4800);
        eq(w.balanceOf(address(this)), 0);
        eq(w.balanceOf(address(f)), 0);
        f.setKeeper(address(this), false);
        w.mint(address(f), 1000);
        vm.expectRevert();
        f.processWeth(0, block.timestamp + 60);
    }

    function testProtectedRewardForwarding() public {
        s.mint(address(f), 99);
        vm.prank(address(999));
        f.forwardSpcxc();
        eq(s.balanceOf(DIST), 99);
    }

    function testMissingFloorFailsClosed() public {
        FeeSplitter fresh = new FeeSplitter(
            address(w),
            address(d),
            address(s),
            address(r),
            KC,
            BURN,
            CDB,
            DIST,
            address(u),
            100,
            200,
            1000,
            0,
            address(this)
        );
        fresh.setKeeper(address(this), true);
        w.mint(address(fresh), 100);
        vm.expectRevert();
        fresh.processWeth(100, block.timestamp + 60);
    }

    function testConstructorValidation() public {
        vm.expectRevert();
        new FeeSplitter(
            address(w),
            address(d),
            address(s),
            address(r),
            KC,
            BURN,
            CDB,
            DIST,
            address(w),
            100,
            200,
            1000,
            0,
            address(this)
        );
        vm.expectRevert();
        new FeeSplitter(
            address(w),
            address(d),
            address(s),
            address(r),
            KC,
            BURN,
            CDB,
            DIST,
            address(u),
            -1,
            200,
            1000,
            0,
            address(this)
        );
    }
}
