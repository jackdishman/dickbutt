// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Verified ClankerSafeErc20Spender interface; see docs/LEGACY-FEES.md.
interface ILegacyFeeModule {
    function tokenCreator(address token) external view returns (address);
    function tokenCreatorTransfer(address safe, address token, address recipient) external;
}

interface ILegacyFeeSafe {
    function isModuleEnabled(address module) external view returns (bool);
}

/// @notice Permissionlessly returns one token's legacy Clanker Safe fees to a fixed destination.
/// @dev The current legacy tokenCreator must assign this contract as the new creator separately.
/// Assignment is permanent: this adapter cannot updateTokenCreator, change destination, or call
/// arbitrary modules. This authority is independent of the Clanker LP locker's ownership.
contract LegacyFeeHarvester is ReentrancyGuard {
    ILegacyFeeModule public immutable feeModule;
    address[] public feeSafes;
    IERC20 public immutable token;
    address public immutable destination;

    event Harvested(address indexed caller, address indexed safe, address indexed destination, uint256 amount);

    constructor(address feeModule_, address[] memory feeSafes_, address token_, address destination_) {
        require(feeModule_.code.length > 0 && token_.code.length > 0, "not contract");
        require(destination_ != address(0) && destination_ != address(this), "bad destination");
        require(feeSafes_.length > 0 && feeSafes_.length <= 8, "bad safe count");
        for (uint256 i; i < feeSafes_.length; ++i) {
            require(feeSafes_[i].code.length > 0, "not contract");
            require(destination_ != feeSafes_[i], "bad destination");
            require(ILegacyFeeSafe(feeSafes_[i]).isModuleEnabled(feeModule_), "module not enabled");
            for (uint256 j; j < i; ++j) require(feeSafes_[i] != feeSafes_[j], "duplicate safe");
        }
        feeModule = ILegacyFeeModule(feeModule_);
        feeSafes = feeSafes_;
        token = IERC20(token_);
        destination = destination_;
    }

    /// @notice Includes previously accumulated fees; does not collect outstanding LP fees.
    /// @return amount Actual increase in destination token balance; zero for an empty Safe.
    function harvest() external nonReentrant returns (uint256) { return _harvest(0); }

    function harvestFrom(uint256 index) external nonReentrant returns (uint256) { return _harvest(index); }

    function safeCount() external view returns (uint256) { return feeSafes.length; }

    function _harvest(uint256 index) private returns (uint256 amount) {
        address feeSafe = feeSafes[index];
        require(isTokenCreator(), "not token creator");
        if (token.balanceOf(feeSafe) == 0) return 0;
        uint256 beforeBalance = token.balanceOf(destination);
        feeModule.tokenCreatorTransfer(feeSafe, address(token), destination);
        amount = token.balanceOf(destination) - beforeBalance;
        require(amount > 0, "no fees received");
        emit Harvested(msg.sender, feeSafe, destination, amount);
    }

    function isTokenCreator() public view returns (bool) {
        return feeModule.tokenCreator(address(token)) == address(this);
    }
}
