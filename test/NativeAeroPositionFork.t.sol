// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./BaseFork.t.sol";
interface AeroPositionVm is ForkVm {function envOr(string calldata,bool) external returns(bool);}
interface ActualAeroManager is IERC721 {
    struct MintParams {address token0;address token1;int24 tickSpacing;int24 tickLower;int24 tickUpper;uint256 amount0Desired;uint256 amount1Desired;uint256 amount0Min;uint256 amount1Min;address recipient;uint256 deadline;uint160 sqrtPriceX96;}
    struct IncreaseLiquidityParams {uint256 tokenId;uint256 amount0Desired;uint256 amount1Desired;uint256 amount0Min;uint256 amount1Min;uint256 deadline;}
    function mint(MintParams calldata) external payable returns(uint256,uint128,uint256,uint256);
    function increaseLiquidity(IncreaseLiquidityParams calldata) external payable returns(uint128,uint256,uint256);
    function factory() external view returns(address);
    function positions(uint256) external view returns(uint96,address,address,address,int24,int24,int24,uint128,uint256,uint256,uint128,uint128);
}
interface ActualAeroRouter {
    struct ExactInputSingleParams {address tokenIn;address tokenOut;int24 tickSpacing;address recipient;uint256 deadline;uint256 amountIn;uint256 amountOutMinimum;uint160 sqrtPriceLimitX96;}
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns(uint256);
}
interface ActualAeroFactory {function getPool(address,address,int24) external view returns(address);function getSwapFee(address) external view returns(uint24);function getUnstakedFee(address) external view returns(uint24);}

/// This creates a NEW DICKBUTT/SPCXc position at a pinned block
/// only on the local fork with real contracts and tokens, executes trades in both directions,
/// then checks actual accrued fees. It is not evidence that a production NFT was funded.
contract NativeAeroPositionForkTest {
    AeroPositionVm constant vm=AeroPositionVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant DICK=0x2D57C47BC5D2432FEEEdf2c9150162A9862D3cCf;
    address constant SPCXC=0xb2000000000000000000007b9fcbd005511aCBd5;
    address constant MANAGER=0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53;
    address constant ROUTER=0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address constant FACTORY=0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;
    address constant LOCKER=0x2Ad4DB8ba8de03834DB14454Afcd74C2393d81C4;
    address constant SPCXC_SOURCE=0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E;
    address constant BURN=0x000000000000000000000000000000000000dEaD;
    event log_named_uint(string key,uint256 value);
    function setUp() public {
        string memory rpc=vm.envOr("BASE_RPC_URL",string(""));
        if(bytes(rpc).length==0||!vm.envOr("BASE_NATIVE_TESTS",false)){vm.skip(true);return;}
        vm.createSelectFork(rpc,51223062);
    }
    function testNativeNewAeroPositionTradesCollectBurnAndRewardPush() public {
        exercisePosition(false, false);
    }
    function testNativeDelayedNftHandoffAndPermanentLocksKeepFeesWorking() public {
        exercisePosition(true, false);
    }
    function testNativeExternalWalletAddsLiquidityTwiceAfterNftHandoff() public {
        exercisePosition(false, true);
    }
    function testNativeExternalTopUpsKeepPermanentLockAndFeeRouting() public {
        exercisePosition(true, true);
    }
    function exercisePosition(bool staged, bool topUp) internal {
        address admin=staged?address(0xA2201):address(this);
        address keeper=staged?address(0xA2202):address(this);
        address proposer=staged?address(0xA2203):address(this);
        require(ActualAeroManager(MANAGER).factory()==FACTORY,"manager generation mismatch");
        require(ActualAeroFactory(FACTORY).getPool(DICK,SPCXC,200)==address(0),"pool already exists at pinned block");
        // Acquire existing real tokens on this local fork. No mock mint, code replacement or storage edits.
        vm.prank(LiveLocker(LOCKER).owner());LiveLocker(LOCKER).collectFees(address(this),1391176);
        vm.prank(SPCXC_SOURCE);require(IERC20(SPCXC).transfer(address(this),101*1e8),"SPCXc funding failed");
        IERC20(DICK).approve(MANAGER,100_000_000 ether);IERC20(SPCXC).approve(MANAGER,100*1e8);
        (uint256 id,uint128 liquidity,,)=ActualAeroManager(MANAGER).mint(ActualAeroManager.MintParams({token0:DICK,token1:SPCXC,tickSpacing:200,tickLower:-887200,tickUpper:887200,amount0Desired:100_000_000 ether,amount1Desired:100*1e8,amount0Min:0,amount1Min:0,recipient:address(this),deadline:block.timestamp+120,sqrtPriceX96:uint160((uint256(1)<<96)/1e8)}));
        require(liquidity>0,"no position liquidity");
        address pool=ActualAeroFactory(FACTORY).getPool(DICK,SPCXC,200);require(pool!=address(0),"pool not created");
        DickbuttRewardsDistributor distributor=new DickbuttRewardsDistributor(SPCXC,1,address(this));
        AerodromeFeeHarvester harvester=new AerodromeFeeHarvester(MANAGER,id,DICK,SPCXC,BURN,address(distributor),block.timestamp+365 days,0,address(this));
        require(!harvester.holdsPosition(),"NFT custody should start with LP owner");
        vm.expectRevert();harvester.harvest();
        require(harvester.lastHarvestAt()==0,"failed pre-handoff harvest changed state");
        if(staged){
            harvester.transferOwnership(admin);distributor.transferOwnership(admin);
            require(harvester.owner()==address(this)&&distributor.owner()==address(this),"premature ownership change");
            vm.expectRevert();vm.prank(address(0xBAD));harvester.acceptOwnership();
            vm.prank(admin);harvester.acceptOwnership();vm.prank(admin);distributor.acceptOwnership();
            require(harvester.owner()==admin&&distributor.owner()==admin&&distributor.guardian()==admin,"new owner/guardian mismatch");
            require(!harvester.holdsPosition(),"admin transfer moved NFT");
            vm.expectRevert();harvester.extendLock(block.timestamp+366 days);
            vm.warp(block.timestamp+1 hours);
        }
        ActualAeroManager(MANAGER).safeTransferFrom(address(this),address(harvester),id);
        require(harvester.holdsPosition(),"position handoff failed");
        if(staged){
            vm.prank(admin);harvester.lockDestinationForever();
            vm.prank(admin);harvester.lockForever();
            vm.expectRevert();vm.prank(admin);harvester.proposeDestination(address(0xBAD));
            vm.warp(harvester.unlockTime()+1);
            vm.expectRevert();vm.prank(admin);harvester.withdrawPosition(admin);
            require(harvester.holdsPosition(),"permanent lock lost custody after original expiry");
        }
        if(topUp) liquidity += addLiquidityFromExternalWallet(harvester, id);
        IERC20(DICK).approve(ROUTER,1_000_000 ether);IERC20(SPCXC).approve(ROUTER,1e8);
        uint256 soldDick=ActualAeroRouter(ROUTER).exactInputSingle(ActualAeroRouter.ExactInputSingleParams(DICK,SPCXC,200,address(this),block.timestamp+120,1_000_000 ether,1,0));
        uint256 soldSpcxc=ActualAeroRouter(ROUTER).exactInputSingle(ActualAeroRouter.ExactInputSingleParams(SPCXC,DICK,200,address(this),block.timestamp+120,1e8,1,0));
        require(soldDick>0&&soldSpcxc>0,"two-way trades failed");
        uint256 beforeBurn=IERC20(DICK).balanceOf(BURN);
        uint256 supplyBefore=IERC20(DICK).totalSupply();
        vm.prank(address(777));harvester.harvest();
        uint256 dickFees=IERC20(DICK).balanceOf(BURN)-beforeBurn;
        uint256 spcxcFees=IERC20(SPCXC).balanceOf(address(distributor));
        require(dickFees>0&&spcxcFees>0,"no actual fees on both sides");
        require(IERC20(DICK).totalSupply()==supplyBefore,"burn-address transfer changed total supply");
        require(IERC20(DICK).balanceOf(address(harvester))==0&&IERC20(SPCXC).balanceOf(address(harvester))==0,"harvester retained fees");
        (,,,,,,,uint128 remainingLiquidity,,,,)=ActualAeroManager(MANAGER).positions(id);
        require(remainingLiquidity==liquidity&&ActualAeroManager(MANAGER).ownerOf(id)==address(harvester),"principal or custody changed");
        harvester.harvest();require(IERC20(DICK).balanceOf(BURN)-beforeBurn==dickFees&&IERC20(SPCXC).balanceOf(address(distributor))==spcxcFees,"empty recollection changed balances");
        address[] memory accounts=new address[](1);accounts[0]=address(0xBEEF3);
        uint256[] memory amounts=new uint256[](1);amounts[0]=spcxcFees/2;require(amounts[0]>0,"fee payout too small");
        bytes32 root=keccak256(bytes.concat(keccak256(abi.encode(uint256(1),accounts[0],amounts[0]))));
        bytes32[][] memory proofs=new bytes32[][](1);proofs[0]=new bytes32[](0);
        vm.prank(admin);distributor.setKeeper(keeper,true);
        if(staged){vm.prank(admin);distributor.setProposer(proposer,true);}
        vm.prank(proposer);distributor.proposeRound(root,amounts[0]);vm.warp(block.timestamp+24 hours);distributor.activateRound(1);
        uint256 beforeHolder=IERC20(SPCXC).balanceOf(accounts[0]);
        vm.prank(keeper);distributor.distributeBatch(1,accounts,amounts,proofs);distributor.closeRound(1);
        require(IERC20(SPCXC).balanceOf(accounts[0])-beforeHolder==amounts[0]&&distributor.totalReserved()==0,"fee-funded holder payment failed");
        emit log_named_uint("locally created real-manager NFT",id);emit log_named_uint("swap fee pips",ActualAeroFactory(FACTORY).getSwapFee(pool));
        emit log_named_uint("unstaked fee pips",ActualAeroFactory(FACTORY).getUnstakedFee(pool));
        emit log_named_uint("actual Aero DICKBUTT burned",dickFees);emit log_named_uint("actual Aero SPCXc to distributor",spcxcFees);emit log_named_uint("actual Aero SPCXc holder payment",amounts[0]);
    }

    function addLiquidityFromExternalWallet(AerodromeFeeHarvester harvester, uint256 id) internal returns(uint128 totalAdded) {
        address contributor = address(0xA2204);
        ActualAeroManager manager = ActualAeroManager(MANAGER);
        require(manager.ownerOf(id) == address(harvester), "harvester must already own NFT");
        require(manager.getApproved(id) == address(0) && !manager.isApprovedForAll(address(harvester), contributor), "contributor must have no NFT approval");
        require(IERC20(DICK).transfer(contributor, 10_000_000 ether), "DICKBUTT contributor funding failed");
        vm.prank(SPCXC_SOURCE);
        require(IERC20(SPCXC).transfer(contributor, 10 * 1e8), "SPCXc contributor funding failed");
        vm.prank(contributor); IERC20(DICK).approve(MANAGER, 10_000_000 ether);
        vm.prank(contributor); IERC20(SPCXC).approve(MANAGER, 10 * 1e8);
        for(uint256 i; i < 2; ++i) {
            (,,,,,,,uint128 beforeLiquidity,,,,) = manager.positions(id);
            uint256 beforeDickbutt = IERC20(DICK).balanceOf(contributor);
            uint256 beforeSpcxc = IERC20(SPCXC).balanceOf(contributor);
            vm.prank(contributor);
            (uint128 added, uint256 amount0, uint256 amount1) = manager.increaseLiquidity(
                ActualAeroManager.IncreaseLiquidityParams(id, 5_000_000 ether, 5 * 1e8, 1, 1, block.timestamp + 120)
            );
            require(added > 0 && amount0 > 0 && amount1 > 0, "top-up added no liquidity");
            require(beforeDickbutt - IERC20(DICK).balanceOf(contributor) == amount0, "wrong DICKBUTT payer");
            require(beforeSpcxc - IERC20(SPCXC).balanceOf(contributor) == amount1, "wrong SPCXc payer");
            (,,,,,,,uint128 afterLiquidity,,,,) = manager.positions(id);
            require(afterLiquidity == beforeLiquidity + added, "top-up liquidity mismatch");
            require(manager.ownerOf(id) == address(harvester), "top-up moved NFT custody");
            require(manager.balanceOf(contributor) == 0, "contributor received an NFT");
            totalAdded += added;
        }
        // Paying for liquidity does not grant the contributor fee or withdrawal authority.
        vm.expectRevert(); vm.prank(contributor);
        INonfungiblePositionManager(MANAGER).collect(INonfungiblePositionManager.CollectParams(id, contributor, type(uint128).max, type(uint128).max));
        vm.expectRevert(); vm.prank(contributor); manager.safeTransferFrom(address(harvester), contributor, id);
        require(IERC20(DICK).balanceOf(address(harvester)) == 0 && IERC20(SPCXC).balanceOf(address(harvester)) == 0, "top-up sent tokens to harvester");
        if(harvester.lockedForever()) {
            address admin = harvester.owner();
            vm.expectRevert(); vm.prank(admin); harvester.withdrawPosition(admin);
            require(harvester.lockedForever() && harvester.holdsPosition(), "top-up bypassed permanent lock");
        }
        emit log_named_uint("external top-ups completed", 2);
        emit log_named_uint("additional position liquidity", totalAdded);
    }
    function onERC721Received(address,address,uint256,bytes calldata) external pure returns(bytes4){return IERC721Receiver.onERC721Received.selector;}
}
