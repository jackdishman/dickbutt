// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./BaseFork.t.sol";
import "./LegacyFork.t.sol";
import "./RealSwapFork.t.sol";
import "../src/SplitsFeeRouter.sol";

interface PipelineVm is ForkVm { function envOr(string calldata,bool) external returns(bool); }

/// Real Base fee sources, real tokens, genuine Splits, real two-hop swap, and real SPCXc push.
/// All ownership impersonation, new deployments and time changes remain inside this local fork.
/// Holder eligibility is exercised separately by the actual JS calculator and public testnet run.
contract NativePipelineForkTest {
    PipelineVm constant vm=PipelineVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant DICK=0x2D57C47BC5D2432FEEEdf2c9150162A9862D3cCf;
    address constant WETH=0x4200000000000000000000000000000000000006;
    address constant USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant SPCXC=0xb2000000000000000000007b9fcbd005511aCBd5;
    address constant LOCKER=0x2Ad4DB8ba8de03834DB14454Afcd74C2393d81C4;
    address constant MANAGER=0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address constant CREATOR=0xDF3eFAfdA19D2dF229eF3fbEC73d2EE6C5fB6d7c;
    address constant MODULE=0x10F4485d6f90239B72c6A5eaD2F2320993D285E4;
    address constant SAFE=0x1eaf444ebDf6495C57aD52A04C61521bBf564ace;
    address constant HISTORIC=0x04F6ef12a8B6c2346C8505eE4Cff71C43D2dd825;
    address constant KC=0x331BB8664d032544327E61753485d06d663995B6;
    address constant CDB=0xB58f2Ce04bd5d397F34ba319316CfaB471E16cF3;
    address constant BURN=0x000000000000000000000000000000000000dEaD;
    event log_named_uint(string key,uint256 value);
    function setUp() public {
        string memory rpc=vm.envOr("BASE_RPC_URL",string(""));
        if(bytes(rpc).length==0||!vm.envOr("BASE_NATIVE_TESTS",false)){vm.skip(true);return;}
        vm.createSelectFork(rpc,51223062);
    }
    function testNativeClankerLegacySplitsSwapAndHolderPushTogether() public {
        exercisePipeline(false, false);
    }
    function testNativeStagedCustodyNewOwnerAndSeparateBots() public {
        exercisePipeline(true, false);
    }
    function testNativeZeroDelayClankerLegacySwapAndIndependentKeeperPush() public {
        exercisePipeline(true, true);
    }
    function acceptNewOwner(Ownable2Step target,address newOwner) internal {
        target.transferOwnership(newOwner);
        require(target.owner()==address(this)&&target.pendingOwner()==newOwner,"ownership changed before acceptance");
        vm.expectRevert();vm.prank(address(0xBAD));target.acceptOwnership();
        vm.prank(newOwner);target.acceptOwnership();
        require(target.owner()==newOwner&&target.pendingOwner()==address(0),"ownership acceptance failed");
    }
    function exercisePipeline(bool staged, bool immediate) internal {
        require(block.chainid==8453,"wrong fork");
        address admin=staged?address(0xA1101):address(this);
        address keeper=staged?address(0xA1102):address(this);
        address ops=staged?address(0xA1103):address(this);
        address proposer=staged?address(0xA1104):address(this);
        uint256 supplyBefore=IERC20(DICK).totalSupply();
        DickbuttRewardsDistributor distributor=new DickbuttRewardsDistributor(SPCXC,1,address(this));
        if(immediate)distributor.setRoundDelay(0);
        SpcxcSwapExecutor executor=new SpcxcSwapExecutor(WETH,SPCXC,0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F,address(distributor),USDC,1,10,1000 ether,0,address(this));
        executor.setKeeper(address(this),true);distributor.setKeeper(address(this),true);
        SplitsFeeRouter router=new SplitsFeeRouter(0x8E8eB0cC6AE34A38B67D5Cf91ACa38f60bc3Ecf4,WETH,DICK,KC,BURN,CDB,address(executor));
        LockerHarvester locker=new LockerHarvester(LOCKER,MANAGER,1391176,address(router),0,address(this));
        address[] memory safes=new address[](2);safes[0]=SAFE;safes[1]=HISTORIC;
        LegacyFeeHarvester legacy=new LegacyFeeHarvester(MODULE,safes,DICK,address(router));
        if(staged){
            require(!locker.ownsLocker()&&!legacy.isTokenCreator(),"handoff unexpectedly active");
            vm.expectRevert();locker.harvest();
            vm.expectRevert();legacy.harvest();
            acceptNewOwner(distributor,admin);acceptNewOwner(executor,admin);acceptNewOwner(locker,admin);
            require(distributor.guardian()==admin,"guardian did not follow owner");
            // Ownership transfer does not revoke previously assigned bot roles; rotate them explicitly.
            require(distributor.isKeeper(address(this))&&executor.isKeeper(address(this)),"role unexpectedly removed");
            vm.prank(admin);distributor.setKeeper(address(this),false);
            vm.prank(admin);executor.setKeeper(address(this),false);
            vm.prank(admin);distributor.setKeeper(keeper,true);
            vm.prank(admin);executor.setKeeper(keeper,true);
            vm.prank(admin);distributor.setProposer(proposer,true);
            vm.expectRevert();executor.setKeeper(address(this),true);
            vm.expectRevert();distributor.setProposer(address(this),true);
            vm.prank(admin);locker.lockDestinationForever();
            vm.expectRevert();vm.prank(admin);locker.proposeDestination(address(0xBAD));
        }
        uint256 safeD=IERC20(DICK).balanceOf(SAFE);uint256 historicD=IERC20(DICK).balanceOf(HISTORIC);uint256 safeW=IERC20(WETH).balanceOf(SAFE);
        uint256 kcD=IERC20(DICK).balanceOf(KC);uint256 kcW=IERC20(WETH).balanceOf(KC);uint256 cdbW=IERC20(WETH).balanceOf(CDB);uint256 burnD=IERC20(DICK).balanceOf(BURN);
        vm.prank(CREATOR);LiveLocker(LOCKER).transferOwnership(address(locker));
        require(locker.ownsLocker()&&!legacy.isTokenCreator(),"locker handoff changed legacy authority");
        vm.expectRevert();vm.prank(CREATOR);LiveLocker(LOCKER).collectFees(CREATOR,1391176);
        vm.recordLogs();vm.prank(address(777));locker.harvest();
        ForkVm.Log[] memory logs=vm.getRecordedLogs();
        uint256 grossD;uint256 grossW;uint256 netW;bool found;
        for(uint256 i;i<logs.length;i++){
            if(logs[i].emitter!=LOCKER||logs[i].topics.length==0||logs[i].topics[0]!=keccak256("ClaimedFees(address,address,address,uint256,uint256,uint256,uint256)"))continue;
            uint256 netD;(netD,netW,grossD,grossW)=abi.decode(logs[i].data,(uint256,uint256,uint256,uint256));
            require(netD==grossD-grossD*60/100&&netW==grossW-grossW*60/100,"Clanker cut differs");found=true;
        }
        require(found&&grossD>0&&netW>0,"no genuine fees");
        vm.expectRevert();legacy.harvest();
        vm.prank(CREATOR);LegacyLiveModule(MODULE).updateTokenCreator(DICK,address(legacy));
        require(legacy.isTokenCreator(),"legacy handoff failed");
        vm.expectRevert();vm.prank(CREATOR);LegacyLiveModule(MODULE).updateTokenCreator(DICK,CREATOR);
        uint256 claimed=legacy.harvest();uint256 historicClaimed=legacy.harvestFrom(1);
        require(claimed==safeD+grossD*60/100&&historicClaimed==historicD,"legacy claim mismatch");
        uint256 allD=IERC20(DICK).balanceOf(address(router));require(allD==grossD+safeD+historicD,"combined DICK mismatch");
        require(IERC20(WETH).balanceOf(SAFE)-safeW==grossW*60/100,"legacy moved WETH");
        require(legacy.harvest()==0&&legacy.harvestFrom(1)==0,"legacy duplicate collection");
        router.splitDickbutt();router.splitWeth();
        uint256 kcDDelta=IERC20(DICK).balanceOf(KC)-kcD;uint256 burnDelta=IERC20(DICK).balanceOf(BURN)-burnD;
        uint256 kcWDelta=IERC20(WETH).balanceOf(KC)-kcW;uint256 cdbDelta=IERC20(WETH).balanceOf(CDB)-cdbW;
        uint256 toSwap=IERC20(WETH).balanceOf(address(executor));
        require(kcDDelta==(allD-1)/10&&burnDelta==(allD-1)*9/10,"DICK split mismatch");
        require(kcWDelta==(netW-1)/10&&cdbDelta==kcWDelta&&toSwap==(netW-1)*8/10,"WETH split mismatch");
        require(kcDDelta+burnDelta+IERC20(DICK).balanceOf(router.dickSplit())==allD,"DICK conservation");
        require(kcWDelta+cdbDelta+toSwap+IERC20(WETH).balanceOf(router.wethSplit())==netW,"WETH conservation");
        require(IERC20(DICK).totalSupply()==supplyBefore,"burn-address transfer changed total supply");
        require(keccak256(executor.swapPath())==keccak256(abi.encodePacked(WETH,int24(1),USDC,int24(10),SPCXC)),"wrong two-hop path");
        (uint256 quote,,,)=LiveQuoter(0x514c8B5f54112481E28028F1166Bd78501089259).quoteExactInput(executor.swapPath(),toSwap);
        require(quote>=6,"quote too small");
        uint256 floor=quote*95/100*1e18/toSwap;
        if(staged){
            vm.prank(admin);executor.setFloorLowerBound(floor);
            vm.prank(admin);executor.setFloorSetter(ops,true);
            vm.expectRevert();vm.prank(keeper);executor.setPriceFloor(floor,block.timestamp+1 hours);
        }
        vm.prank(ops);executor.setPriceFloor(floor,block.timestamp+1 hours);
        vm.recordLogs();vm.prank(keeper);uint256 received=executor.processWeth(quote*95/100,block.timestamp+120);
        ForkVm.Log[] memory swapLogs=vm.getRecordedLogs();uint256 usdcFromFirst;uint256 usdcToSecond;
        for(uint256 i;i<swapLogs.length;i++){
            ForkVm.Log memory entry=swapLogs[i];
            if(entry.emitter!=USDC||entry.topics.length!=3||entry.topics[0]!=keccak256("Transfer(address,address,uint256)"))continue;
            uint256 value=abi.decode(entry.data,(uint256));
            if(address(uint160(uint256(entry.topics[1])))==0x4e392fBfE4D0557C82D2F97F02ec39daA31516dd)usdcFromFirst+=value;
            if(address(uint160(uint256(entry.topics[2])))==0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E)usdcToSecond+=value;
        }
        require(usdcFromFirst>0&&usdcFromFirst==usdcToSecond,"USDC did not bridge the two real pools");
        require(IERC20(USDC).balanceOf(address(executor))==0,"intermediate token stranded at executor");
        require(IERC20(SPCXC).balanceOf(address(distributor))==received,"SPCXc missing at distributor");
        require(IERC20(WETH).balanceOf(address(executor))==0&&IERC20(WETH).allowance(address(executor),address(executor.router()))==0,"input or allowance remains");
        pushRewards(distributor,received,keeper,proposer,immediate);
        require(distributor.totalReserved()==0,"reserved funds remain");
        emit log_named_uint("gross DICK from real Clanker position",grossD);emit log_named_uint("gross WETH from real Clanker position",grossW);
        emit log_named_uint("legacy DICK claimed",claimed+historicClaimed);emit log_named_uint("KC DICK",kcDDelta);emit log_named_uint("DICK burned",burnDelta);
        emit log_named_uint("KC WETH",kcWDelta);emit log_named_uint("CDB WETH",cdbDelta);emit log_named_uint("WETH actually swapped",toSwap);
        emit log_named_uint("SPCXc received from real swap",received);
        emit log_named_uint("USDC actually transferred between swap pools",usdcFromFirst);
    }
    // Keep payout proof construction separate from the large fee-accounting fixture so solc's
    // optimizer does not need every swap balance and Merkle temporary on its stack together.
    function pushRewards(DickbuttRewardsDistributor distributor,uint256 received,address keeper,address proposer,bool immediate) internal {
        address[] memory accounts=new address[](2);accounts[0]=address(0xBEEF1);accounts[1]=address(0xBEEF2);
        uint256[] memory amounts=new uint256[](2);amounts[0]=received/6;amounts[1]=amounts[0]*2;
        uint256 beforeA=IERC20(SPCXC).balanceOf(accounts[0]);uint256 beforeB=IERC20(SPCXC).balanceOf(accounts[1]);
        bytes32 a=keccak256(bytes.concat(keccak256(abi.encode(uint256(1),accounts[0],amounts[0]))));
        bytes32 b=keccak256(bytes.concat(keccak256(abi.encode(uint256(1),accounts[1],amounts[1]))));
        bytes32 root=a<b?keccak256(abi.encodePacked(a,b)):keccak256(abi.encodePacked(b,a));
        bytes32[][] memory proofs=new bytes32[][](2);proofs[0]=new bytes32[](1);proofs[0][0]=b;proofs[1]=new bytes32[](1);proofs[1][0]=a;
        vm.prank(proposer);distributor.proposeRound(root,amounts[0]+amounts[1]);
        if(immediate){(,,uint256 readyAt)=distributor.pending(1);require(readyAt==block.timestamp,"unexpected extra reward wait");}
        vm.warp(block.timestamp+distributor.roundDelay());distributor.activateRound(1);
        if(keeper!=address(this)){vm.expectRevert();distributor.distributeBatch(1,accounts,amounts,proofs);}
        vm.prank(keeper);distributor.distributeBatch(1,accounts,amounts,proofs);distributor.closeRound(1);
        require(IERC20(SPCXC).balanceOf(accounts[0])-beforeA==amounts[0]&&IERC20(SPCXC).balanceOf(accounts[1])-beforeB==amounts[1],"actual holder receipt mismatch");
        require(distributor.totalReserved()==0,"reserved funds remain");
        emit log_named_uint("configured extra review seconds",distributor.roundDelay());
        emit log_named_uint("SPCXc holder A",amounts[0]);emit log_named_uint("SPCXc holder B",amounts[1]);
    }
}
