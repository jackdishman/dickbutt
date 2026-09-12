// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../src/LockerHarvester.sol";
import "../src/AerodromeFeeHarvester.sol";
import "../src/FeeSplitter.sol";
import "../src/DickbuttRewardsDistributor.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

interface ForkVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function envOr(string calldata, string calldata) external returns (string memory);
    function envOr(string calldata, address) external returns (address);
    function envOr(string calldata, uint256) external returns (uint256);
    function createSelectFork(string calldata, uint256) external returns (uint256);
    function skip(bool) external;
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert() external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

interface LiveLocker is ILpLocker {
    function transferOwnership(address) external;
    function _fee() external view returns (uint256);
    function _feeRecipient() external view returns (address);
}

interface LivePool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

/// No broadcasts: impersonation and time travel affect only this local fork.
contract BaseForkTest {
    ForkVm constant vm = ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant PINNED_BLOCK = 51218068;
    address constant LOCKER = 0x2Ad4DB8ba8de03834DB14454Afcd74C2393d81C4;
    address constant MANAGER = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address constant OWNER = 0xDF3eFAfdA19D2dF229eF3fbEC73d2EE6C5fB6d7c;
    address constant DICK = 0x2D57C47BC5D2432FEEEdf2c9150162A9862D3cCf;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant SPCXC = 0xb2000000000000000000007b9fcbd005511aCBd5;
    address constant POOL = 0x92d90f7f8413749Bd4BeA26ddE4e29efC9e9A0B6;
    uint256 constant TOKEN_ID = 1391176;
    uint256 constant UNLOCK = 4132317178;
    event OptionalForkCheckSkipped(string reason);

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            emit OptionalForkCheckSkipped("BASE_RPC_URL absent: fork not executed");
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, PINNED_BLOCK);
    }

    function testForkVerifiedLockerAndDickbuttFacts() public view {
        require(block.chainid == 8453 && block.number == PINNED_BLOCK, "wrong fork");
        require(LiveLocker(LOCKER).owner() == OWNER, "owner drift");
        require(LiveLocker(LOCKER).released(MANAGER) == TOKEN_ID, "id drift");
        require(LiveLocker(LOCKER).end() == UNLOCK, "unlock drift");
        require(LiveLocker(LOCKER)._fee() == 60, "fee drift");
        require(IERC721(MANAGER).ownerOf(TOKEN_ID) == LOCKER, "custody drift");
        require(IERC20Metadata(DICK).decimals() == 18, "DICK decimals");
        // SPCXc is a post-Cancun B20 asset; decimals and transfer behavior
        // are recorded by script/inspect-base.mjs. Older local fork engines
        // may not implement one of its newer opcodes, so this test verifies
        // deployed code and the optional transfer path below separately.
        require(SPCXC.code.length > 0, "SPCXc code missing");
        require(LivePool(POOL).token0() == DICK && LivePool(POOL).token1() == WETH, "pool pair");
        require(LivePool(POOL).fee() == 10000, "pool fee");
    }

    function newHarvester(address destination) internal returns (LockerHarvester h) {
        h = new LockerHarvester(LOCKER, MANAGER, TOKEN_ID, destination, 0, address(this));
        vm.prank(OWNER);
        LiveLocker(LOCKER).transferOwnership(address(h));
        require(h.ownsLocker(), "ownership");
    }

    function testForkRealLockerHarvestFixedDestinationAndProtocolCut() public {
        // Collection destination is the actual splitter; no router or swap is invoked.
        FeeSplitter splitter = new FeeSplitter(
            WETH,
            DICK,
            SPCXC,
            MANAGER,
            address(101),
            address(102),
            address(103),
            address(104),
            0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
            100,
            200,
            1 ether,
            0,
            address(this)
        );
        LockerHarvester h = newHarvester(address(splitter));
        address protocol = LiveLocker(LOCKER)._feeRecipient();
        uint256 beforeD = IERC20(DICK).balanceOf(address(splitter));
        uint256 beforeW = IERC20(WETH).balanceOf(address(splitter));
        uint256 protocolD = IERC20(DICK).balanceOf(protocol);
        uint256 protocolW = IERC20(WETH).balanceOf(protocol);
        vm.recordLogs();
        vm.prank(address(777));
        h.harvest();
        ForkVm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (
                logs[i].emitter != LOCKER
                    || logs[i].topics[0]
                        != keccak256("ClaimedFees(address,address,address,uint256,uint256,uint256,uint256)")
            ) continue;
            require(address(uint160(uint256(logs[i].topics[1]))) == address(splitter), "wrong recipient");
            (uint256 netD, uint256 netW, uint256 grossD, uint256 grossW) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
            require(netD == grossD - grossD * 60 / 100 && netW == grossW - grossW * 60 / 100, "protocol cut");
            require(IERC20(DICK).balanceOf(address(splitter)) - beforeD == netD, "DICK receipt");
            require(IERC20(WETH).balanceOf(address(splitter)) - beforeW == netW, "WETH receipt");
            require(IERC20(DICK).balanceOf(protocol) - protocolD == grossD - netD, "protocol DICK");
            require(IERC20(WETH).balanceOf(protocol) - protocolW == grossW - netW, "protocol WETH");
            found = true;
        }
        require(found, "no collection event");
        uint256 dickBalance = IERC20(DICK).balanceOf(address(splitter));
        if (dickBalance > 0) {
            splitter.splitDickbutt();
            require(IERC20(DICK).balanceOf(address(101)) == dickBalance / 10, "KC split");
            require(IERC20(DICK).balanceOf(address(102)) == dickBalance - dickBalance / 10, "burn split");
        }
    }

    function testForkActualUnlockRecovery() public {
        LockerHarvester h = newHarvester(address(123));
        vm.expectRevert();
        h.recoverReleasedPosition(address(999));
        vm.warp(UNLOCK);
        vm.prank(address(777));
        LiveLocker(LOCKER).release();
        require(IERC721(MANAGER).ownerOf(TOKEN_ID) == address(h), "release custody");
        h.recoverReleasedPosition(address(999));
        require(IERC721(MANAGER).ownerOf(TOKEN_ID) == address(999), "recovery custody");
    }

    function testForkSpcxcRealTransferAndPush() public {
        address holder = vm.envOr("LIVE_SPCXC_HOLDER", address(0));
        if (holder == address(0)) {
            emit OptionalForkCheckSkipped("LIVE_SPCXC_HOLDER absent: real token transfer unverified");
            vm.skip(true);
            return;
        }
        uint256 amount = 1;
        require(IERC20(SPCXC).balanceOf(holder) >= amount, "unfunded holder at pinned block");
        DickbuttRewardsDistributor distributor = new DickbuttRewardsDistributor(SPCXC, 0, address(this));
        distributor.setKeeper(address(this), true);
        vm.prank(holder);
        require(IERC20(SPCXC).transfer(address(distributor), amount), "fund transfer");
        address recipient = address(0xBEEF);
        uint256 beforeBalance = IERC20(SPCXC).balanceOf(recipient);
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(uint256(1), recipient, amount))));
        distributor.proposeRound(leaf, amount);
        vm.warp(block.timestamp + 6 hours);
        distributor.activateRound(1);
        address[] memory accounts = new address[](1);
        accounts[0] = recipient;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);
        distributor.distributeBatch(1, accounts, amounts, proofs);
        require(distributor.paid(1, recipient), "SPCXc push rejected");
        require(IERC20(SPCXC).balanceOf(recipient) - beforeBalance == amount, "SPCXc transfer delta");
    }

    function testForkOptionalAeroCollect() public {
        address manager = vm.envOr("LIVE_AERO_MANAGER", address(0));
        uint256 id = vm.envOr("LIVE_AERO_TOKEN_ID", uint256(0));
        if (manager == address(0) || id == 0) {
            emit OptionalForkCheckSkipped("LIVE_AERO_MANAGER or LIVE_AERO_TOKEN_ID absent: live collect unverified");
            vm.skip(true);
            return;
        }
        AerodromeFeeHarvester h = new AerodromeFeeHarvester(
            manager, id, DICK, SPCXC, address(0xdead), address(123), block.timestamp + 365 days, 0, address(this)
        );
        address nftOwner = IERC721(manager).ownerOf(id);
        vm.prank(nftOwner);
        IERC721(manager).safeTransferFrom(nftOwner, address(h), id);
        h.harvest();
        require(h.holdsPosition(), "Aero custody");
    }
}
