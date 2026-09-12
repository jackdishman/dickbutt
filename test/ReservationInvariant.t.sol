// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./Support.sol";
import "../src/DickbuttRewardsDistributor.sol";

contract ReservationHandler is Support {
    RewardMock public token;
    DickbuttRewardsDistributor public d;
    mapping(uint256=>uint256) public delivered;
    uint256 public minted;
    constructor() {
        token=new RewardMock(); d=new DickbuttRewardsDistributor(address(token),0,address(this));
        d.setKeeper(address(this),true); fund(1000);
    }
    function fund(uint96 amount) public { token.mint(address(d),amount); minted+=amount; }
    function propose(uint96 raw) external {
        uint256 available=d.availableForNextRound(); if(available==0)return;
        uint256 n=uint256(raw)%available+1; uint256 id=d.nextRoundId();
        address recipient=address(uint160(id+1000));
        d.proposeRound(keccak256(bytes.concat(keccak256(abi.encode(id,recipient,n)))),n);
    }
    function activate(uint256 seed) external {
        uint256 id=seed%d.nextRoundId(); (, , uint256 ready)=d.pending(id);
        if(ready==0)return; if(block.timestamp<ready)vm.warp(ready); d.activateRound(id);
    }
    function cancel(uint256 seed) external {
        uint256 id=seed%d.nextRoundId(); (bytes32 root,,)=d.pending(id);
        if(root!=0)d.cancelPendingRound(id);
    }
    function close(uint256 seed) external {
        uint256 id=seed%d.nextRoundId(); (,,,bool active,)=d.roundInfo(id); if(active)d.closeRound(id);
    }
    function pay(uint256 seed,bool fail) external {
        uint256 id=seed%d.nextRoundId(); (,uint256 n,,bool active,)=d.roundInfo(id); if(!active)return;
        address recipient=address(uint160(id+1000)); token.setBlocked(recipient,fail);
        address[] memory a=new address[](1); a[0]=recipient;
        uint256[] memory amounts=new uint256[](1); amounts[0]=n;
        bytes32[][] memory p=new bytes32[][](1); p[0]=new bytes32[](0);
        uint256 beforeBalance=token.balanceOf(recipient); d.distributeBatch(id,a,amounts,p);
        delivered[id]+=token.balanceOf(recipient)-beforeBalance;
    }
    function guidance(uint256 threshold) external { d.setMinPayout(threshold); }
}
contract ReservationInvariantTest is Support {
    ReservationHandler public handler;
    function setUp() public { handler=new ReservationHandler(); }
    function targetContracts() external view returns(address[] memory a) { a=new address[](1); a[0]=address(handler); }
    function invariantReservationConservationAndNoDoublePayment() public view {
        DickbuttRewardsDistributor d=handler.d(); RewardMock t=handler.token();
        uint256 reserved; uint256 paidTotal;
        for(uint256 id=1;id<d.nextRoundId();id++) {
            (,uint256 p,)=d.pending(id); reserved+=p;
            (,uint256 total,uint256 distributed,bool active,)=d.roundInfo(id);
            require(distributed<=total,"overspend");
            if(active)reserved+=total-distributed;
            require(distributed==handler.delivered(id),"delivery mismatch");
            require(t.balanceOf(address(uint160(id+1000)))==distributed,"double payment");
            if(d.paid(id,address(uint160(id+1000))))require(distributed==total,"paid ledger");
            paidTotal+=distributed;
        }
        require(d.totalReserved()==reserved,"reserve accounting");
        require(t.balanceOf(address(d))>=reserved,"insolvent");
        require(t.balanceOf(address(d))+paidTotal==handler.minted(),"conservation");
    }
}
