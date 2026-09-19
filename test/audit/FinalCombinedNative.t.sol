// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../NativePipelineFork.t.sol";
import "../NativeVammFork.t.sol";

/// Runs each inherited native Clanker/legacy/Splits/swap scenario with actual vAMM fees
/// added to the SAME distributor before its holder payout. Only local fork state is changed.
contract FinalCombinedNativeTest is NativePipelineForkTest {
    address constant VAMM_FACTORY=0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    address constant SPCXC_SOURCE=0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E;
    function pushRewards(DickbuttRewardsDistributor distributor,uint256 received,address keeper,address proposer,bool immediate) internal override {
        // Seed from already-existing token balances; never etch/mint a replacement native token.
        vm.prank(KC);require(IERC20(DICK).transfer(address(this),102_000_000 ether));
        vm.prank(SPCXC_SOURCE);require(IERC20(SPCXC).transfer(address(this),102*1e8));
        address p=VammLiveFactory(VAMM_FACTORY).getPool(DICK,SPCXC,false);
        if(p==address(0))p=VammLiveFactory(VAMM_FACTORY).createPool(DICK,SPCXC,false);
        VammLivePool pool=VammLivePool(p);
        require(IERC20(DICK).transfer(p,100_000_000 ether));require(IERC20(SPCXC).transfer(p,100*1e8));
        uint256 lp=pool.mint(address(this));require(lp>0,"missing LP shares");
        AerodromeVammHarvester harvester=new AerodromeVammHarvester(VAMM_FACTORY,p,DICK,SPCXC,BURN,address(distributor),block.timestamp+365 days,3600,address(this));
        require(pool.transfer(address(harvester),lp));harvester.lockForever();harvester.lockDestinationForever();
        if(distributor.owner()!=address(this))acceptNewOwner(harvester,distributor.owner());
        uint256 added=accrueAndClaim(pool,harvester,lp,address(distributor));
        require(IERC20(SPCXC).balanceOf(address(distributor))==received+added,"combined funding mismatch");
        super.pushRewards(distributor,received+added,keeper,proposer,immediate);
        // Further real LP fees and a second capped reward round after the earning interval.
        vm.warp(block.timestamp+6 hours);
        accrueAndClaim(pool,harvester,lp,address(distributor));
        address holder=address(0xBEEF3);uint256 amount=distributor.maxProposableTotal();uint256 id=distributor.nextRoundId();
        vm.prank(proposer);distributor.proposeRound(keccak256(bytes.concat(keccak256(abi.encode(id,holder,amount)))),amount);
        (,,uint256 ready)=distributor.pending(id);vm.warp(ready);distributor.activateRound(id);
        address[] memory accounts=new address[](1);accounts[0]=holder;
        uint256[] memory amounts=new uint256[](1);amounts[0]=amount;
        bytes32[][] memory proofs=new bytes32[][](1);proofs[0]=new bytes32[](0);
        uint256 beforeBalance=IERC20(SPCXC).balanceOf(holder);
        vm.prank(keeper);distributor.distributeBatch(id,accounts,amounts,proofs);
        vm.prank(keeper);distributor.distributeBatch(id,accounts,amounts,proofs);
        distributor.closeRound(id);
        require(IERC20(SPCXC).balanceOf(holder)-beforeBalance==amount,"duplicate or missing second-round payment");
        require(distributor.totalReserved()==0&&pool.balanceOf(address(harvester))==lp,"final reserves or LP principal wrong");
        emit log_named_uint("combined pipeline vAMM first SPCXc fee raw",added);
        emit log_named_uint("combined pipeline second holder payout raw",amount);
    }
    function accrueAndClaim(VammLivePool pool,AerodromeVammHarvester harvester,uint256 lp,address distributor) internal returns(uint256 added){
        trade(pool,DICK,1_000_000 ether);trade(pool,SPCXC,1e8);
        uint256 beforeBurn=IERC20(DICK).balanceOf(BURN);uint256 beforeReward=IERC20(SPCXC).balanceOf(distributor);
        vm.prank(address(0x777));harvester.harvest();
        added=IERC20(SPCXC).balanceOf(distributor)-beforeReward;
        require(added>0&&IERC20(DICK).balanceOf(BURN)>beforeBurn,"no actual vAMM fees");
        require(pool.balanceOf(address(harvester))==lp,"LP principal changed");
    }
    function trade(VammLivePool pool,address input,uint256 amount) internal {
        uint256 output=pool.getAmountOut(amount,input);require(output>0,"empty quote");
        require(IERC20(input).transfer(address(pool),amount));
        bool zeroIn=input==pool.token0();pool.swap(zeroIn?0:output,zeroIn?output:0,address(this),"");
    }
}
