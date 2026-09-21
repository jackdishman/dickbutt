// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../Support.sol";
import "../../src/DickbuttRewardsDistributor.sol";

/// Independent two-recipient model; no expected reverts are swallowed by the fuzzer.
contract AuditAccountingHandler is Support {
    RewardMock public token;
    DickbuttRewardsDistributor public d;
    address constant A=address(0xAA);
    address constant B=address(0xBB);
    uint256 public minted;
    uint256 public paidA;
    uint256 public paidB;
    uint256[9] public successfulActions;
    constructor() {
        vm.warp(100000);
        token=new RewardMock();d=new DickbuttRewardsDistributor(address(token),0,address(this));
        d.setKeeper(address(this),true);d.setRoundDelay(0);
        token.mint(address(d),1000000);minted=1000000;
    }
    function leaf(uint256 id,address a,uint256 n) internal pure returns(bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(id,a,n))));
    }
    function step(uint256 seed,uint96 amount,uint32 seconds_) external {
        uint256 op=seed%9;
        uint256 id=1+(seed/9)%d.nextRoundId();
        if(op==0){token.mint(address(d),amount);minted+=amount;}
        else if(op==1){vm.warp(block.timestamp+uint256(seconds_)%1 days+1);}
        else if(op==2){
            uint256 cap=d.maxProposableTotal();
            if(cap<2||block.timestamp<d.nextProposalAllowedAt()||d.proposalsPaused())return;
            uint256 n=2+uint256(amount)%(cap-1);id=d.nextRoundId();
            bytes32 a=leaf(id,A,n/2);bytes32 b=leaf(id,B,n-n/2);
            d.proposeRound(a<b?keccak256(abi.encodePacked(a,b)):keccak256(abi.encodePacked(b,a)),n);
        }
        else if(op==3){(bytes32 root,,)=d.pending(id);if(root==0)return;d.activateRound(id);}
        else if(op==4){
            (,uint256 n,,bool active,)=d.roundInfo(id);if(!active)return;
            token.setBlocked(B,amount%2==0);
            address[] memory a=new address[](2);a[0]=A;a[1]=B;
            uint256[] memory v=new uint256[](2);v[0]=n/2;v[1]=n-n/2;
            bytes32[][] memory p=new bytes32[][](2);p[0]=new bytes32[](1);p[1]=new bytes32[](1);
            p[0][0]=leaf(id,B,v[1]);p[1][0]=leaf(id,A,v[0]);
            uint256 beforeA=token.balanceOf(A);uint256 beforeB=token.balanceOf(B);
            d.distributeBatch(id,a,v,p);paidA+=token.balanceOf(A)-beforeA;paidB+=token.balanceOf(B)-beforeB;
        }
        else if(op==5){(bytes32 root,,)=d.pending(id);if(root==0)return;d.cancelPendingRound(id);}
        else if(op==6){(,,,bool active,)=d.roundInfo(id);if(!active)return;d.closeRound(id);}
        else if(op==7){d.pauseProposals(amount%2==0);}
        else {
            vm.prank(address(0xBAD));
            (bool ok,)=address(d).call(abi.encodeCall(d.executeTransfer,(address(0xBAD),1)));
            require(!ok,"unprivileged transfer escaped");
        }
        successfulActions[op]++;
    }
    function assertAccounting() external view {
        uint256 reserve;uint256 paidTotal;
        for(uint256 id=1;id<d.nextRoundId();id++){
            (,uint256 pending,)=d.pending(id);reserve+=pending;
            (,uint256 total,uint256 distributed,bool active,bool closed)=d.roundInfo(id);
            require(distributed<=total,"round overspend");
            require(!(active&&closed),"impossible lifecycle");
            if(active)reserve+=total-distributed;
            uint256 flagged=(d.paid(id,A)?total/2:0)+(d.paid(id,B)?total-total/2:0);
            require(distributed==flagged,"paid ledger mismatch");paidTotal+=distributed;
        }
        require(reserve==d.totalReserved(),"reserve mismatch");
        require(token.balanceOf(address(d))>=reserve,"insolvency");
        require(paidTotal==paidA+paidB,"delivery mismatch");
        require(token.balanceOf(A)==paidA&&token.balanceOf(B)==paidB,"recipient conservation");
        require(token.balanceOf(address(d))+paidTotal==minted,"asset conservation");
    }
}
contract AccountingSecurityAuditInvariantTest {
    AuditAccountingHandler public handler;
    function setUp() public {handler=new AuditAccountingHandler();}
    function targetContracts() external view returns(address[] memory targets){targets=new address[](1);targets[0]=address(handler);}
    function invariantTwoRecipientPartialPaymentsAndConcurrentReserves() public view {handler.assertAccounting();}
}
