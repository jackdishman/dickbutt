// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../VammHarvester.t.sol";

contract VammAuditHandler is Support {
    RewardMock public d; RewardMock public s;
    VammPoolMock public pool; AerodromeVammHarvester public h;
    address public constant BURN=address(0xdead);
    address public constant DEST=address(0x1234);
    uint256 public principal;
    bool public unauthorizedSuccess;
    constructor(){
        vm.warp(100000);d=new RewardMock();s=new RewardMock();
        VammFactoryMock factory=new VammFactoryMock();
        pool=new VammPoolMock(address(factory),address(d),address(s));factory.configure(address(pool),true);
        h=new AerodromeVammHarvester(address(factory),address(pool),address(d),address(s),BURN,DEST,block.timestamp+1 days,60,address(this));
        h.lockForever();h.lockDestinationForever();
    }
    function contribute(uint96 amount) external {pool.mint(address(h),amount);principal+=amount;}
    function accrue(uint96 a,uint96 b) external {pool.accrue(address(h),a,b);}
    function donate(uint96 a,uint96 b) external {d.mint(address(h),a);s.mint(address(h),b);}
    function advance(uint32 seconds_) external {vm.warp(block.timestamp+uint256(seconds_)%10 days);}
    function policy(bool blockRecipient) external {s.setBlocked(DEST,blockRecipient);}
    function fault(bool fail,bool consume,bool reenter) external {pool.setFault(fail,consume);pool.setReentry(reenter);}
    function harvest() external {try h.harvest() {}catch{}}
    function attack(uint8 kind) external {
        bytes memory data=kind%3==0?abi.encodeCall(h.withdrawLiquidity,(address(this),1)):
            kind%3==1?abi.encodeCall(h.rescueToken,(address(pool),address(this),1)):
            abi.encodeCall(h.proposeDestination,(address(this)));
        // Even the owner cannot bypass the permanent principal/destination locks.
        (bool ok,)=address(h).call(data);if(ok)unauthorizedSuccess=true;
    }
}
contract VammAuditInvariantTest {
    VammAuditHandler public handler;
    function setUp() public {handler=new VammAuditHandler();}
    function targetContracts() external view returns(address[] memory a){a=new address[](1);a[0]=address(handler);}
    function invariantPrincipalAndTokenConservationAcrossHostileSequences() public view {
        VammPoolMock pool=handler.pool();AerodromeVammHarvester h=handler.h();
        RewardMock d=handler.d();RewardMock s=handler.s();
        require(!handler.unauthorizedSuccess(),"locked operation succeeded");
        require(pool.balanceOf(address(h))==handler.principal(),"LP principal lost");
        require(d.totalSupply()==d.balanceOf(address(pool))+d.balanceOf(address(h))+d.balanceOf(handler.BURN()),"DICK conservation");
        require(s.totalSupply()==s.balanceOf(address(pool))+s.balanceOf(address(h))+s.balanceOf(handler.DEST()),"SPCX conservation");
        require(d.balanceOf(address(pool))==pool.claimable0(address(h)),"DICK claim ledger");
        require(s.balanceOf(address(pool))==pool.claimable1(address(h)),"SPCX claim ledger");
        require(h.spcxcDestination()==handler.DEST(),"destination changed");
    }
}
