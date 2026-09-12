// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert() external;
    function expectRevert(bytes calldata) external;
}
contract Support {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    function eq(uint256 a, uint256 b) internal pure { require(a == b, "unequal"); }
}
contract RewardMock is ERC20 {
    mapping(address => bool) public blocked;
    bool public paused;
    constructor() ERC20("Reward", "RWD") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setBlocked(address to, bool value) external { blocked[to] = value; }
    function setPaused(bool value) external { paused = value; }
    function _update(address from, address to, uint256 amount) internal override {
        require(!paused && !blocked[to], "policy restriction");
        super._update(from, to, amount);
    }
}
