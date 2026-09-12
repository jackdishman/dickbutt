// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./Support.sol";
/// Disposable rehearsal asset; mimics actual SPCXc decimals and per-recipient failure only.
/// It does not model Base native B20 issuer policy; separate native fork tests cover real SPCXc.
contract RehearsalRewardToken is RewardMock {
    function decimals() public pure override returns(uint8) { return 8; }
}
