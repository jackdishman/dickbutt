// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/SpcxcSwapExecutor.sol";
import "../src/AerodromeFeeHarvester.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Stand-ins for a public-testnet deployment. Aerodrome Slipstream is not deployed on Base
/// Sepolia, so the router and quoter are simulated. Splits V2.2 IS deployed there at the same
/// addresses as mainnet, so `SplitsFeeRouter` uses the genuine protocol on both chains.
///
/// The router and quoter live in one file and share `rate` on purpose: a quoter that disagrees
/// with the router it quotes for would make the price floor meaningless, and splitting them
/// across files is how that drift starts.

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @dev Fixed-rate swap. Mints the output rather than holding inventory, which is fine for a
/// testnet stand-in and is exactly why this contract must never be deployed to mainnet.
contract SepoliaSwapRouter {
    IERC20 public immutable input;
    IERC20 public immutable output;
    /// @notice Output units per 1e18 input units.
    uint256 public immutable rate;

    constructor(address input_, address output_, uint256 rate_) {
        require(input_ != address(0) && output_ != address(0) && rate_ > 0, "bad config");
        input = IERC20(input_);
        output = IERC20(output_);
        rate = rate_;
    }

    function quote(uint256 amountIn) public view returns (uint256) {
        return (amountIn * rate) / 1e18;
    }

    function exactInput(ISpcxcSwapRouter.ExactInputParams calldata p) external payable returns (uint256 amountOut) {
        require(block.timestamp <= p.deadline, "expired");
        require(input.transferFrom(msg.sender, address(this), p.amountIn), "input transfer");
        amountOut = quote(p.amountIn);
        require(amountOut >= p.amountOutMinimum, "insufficient output");
        IMintable(address(output)).mint(p.recipient, amountOut);
    }
}

/// @dev Matches the Aerodrome QuoterV2 signature the fee and floor CLIs call with staticCall.
contract SepoliaQuoter {
    SepoliaSwapRouter public immutable router;

    constructor(address router_) {
        require(router_ != address(0), "bad router");
        router = SepoliaSwapRouter(router_);
    }

    function quoteExactInput(bytes calldata, uint256 amountIn)
        external
        view
        returns (uint256 amountOut, uint160[] memory sqrtPricesAfter, uint32[] memory ticksCrossed, uint256 gasEstimate)
    {
        amountOut = router.quote(amountIn);
        sqrtPricesAfter = new uint160[](0);
        ticksCrossed = new uint32[](0);
        gasEstimate = 0;
    }
}

/// @dev Open faucet token. Anyone can mint, so balances mean nothing beyond testing the pipeline.
contract SepoliaToken is ERC20 {
    uint8 private immutable _decimals;
    mapping(address => bool) public blocked;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Exercise the distributor's failed-recipient and retry path on a live chain.
    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function _update(address from, address to, uint256 amount) internal override {
        require(!blocked[to], "recipient blocked");
        super._update(from, to, amount);
    }
}

/// @dev Clanker-locker stand-in with configurable fee size. The local rehearsal mocks mint a
/// fixed 1000 raw units, which is fine against a toy 2x rate but rounds a realistic per-1e18
/// swap rate to zero. A testnet deployment that never exercises a meaningful swap size never
/// tests the price floor either, so the amounts are settable here.
contract SepoliaLocker {
    address public owner;
    address public immutable manager;
    uint256 public immutable tokenId;
    IMintable public immutable weth;
    IMintable public immutable dickbutt;
    uint256 public duration;
    uint256 public wethPerCollect;
    uint256 public dickbuttPerCollect;

    constructor(address manager_, address weth_, address dickbutt_, address owner_, uint256 tokenId_) {
        manager = manager_;
        weth = IMintable(weth_);
        dickbutt = IMintable(dickbutt_);
        owner = owner_;
        tokenId = tokenId_;
        duration = block.timestamp + 365 days;
        wethPerCollect = 0.01 ether;
        dickbuttPerCollect = 1000 ether;
    }

    function setFeeAmounts(uint256 wethAmount, uint256 dickbuttAmount) external {
        require(msg.sender == owner || owner == address(0), "not owner");
        wethPerCollect = wethAmount;
        dickbuttPerCollect = dickbuttAmount;
    }

    function transferOwnership(address to) external {
        require(msg.sender == owner, "not owner");
        owner = to;
    }

    function released(address m) external view returns (uint256) { return m == manager ? tokenId : 0; }
    function end() external view returns (uint256) { return duration; }

    function release() external {
        require(block.timestamp >= duration, "locked");
        IERC721(manager).transferFrom(address(this), owner, tokenId);
    }

    /// @dev Mints rather than holding real fee inventory. Testnet only.
    function collectFees(address to, uint256 id) external {
        require(msg.sender == owner && id == tokenId, "not owner");
        weth.mint(to, wethPerCollect);
        dickbutt.mint(to, dickbuttPerCollect);
    }
}

/// @dev Slipstream position-manager stand-in with configurable collectable fees.
contract SepoliaPositionManager is ERC721 {
    IMintable public token0;
    IMintable public token1;
    uint256 public amount0PerCollect;
    uint256 public amount1PerCollect;

    constructor() ERC721("Sepolia Position", "sPOS") {}

    function mint(address to, uint256 id) external { _mint(to, id); }

    function configureFees(address t0, address t1, uint256 a0, uint256 a1) external {
        token0 = IMintable(t0);
        token1 = IMintable(t1);
        amount0PerCollect = a0;
        amount1PerCollect = a1;
    }

    function collect(INonfungiblePositionManager.CollectParams calldata p)
        external
        payable
        returns (uint256, uint256)
    {
        require(ownerOf(p.tokenId) == msg.sender, "not position owner");
        require(p.amount0Max == type(uint128).max && p.amount1Max == type(uint128).max, "wrong maxima");
        if (address(token0) == address(0)) return (0, 0);
        token0.mint(p.recipient, amount0PerCollect);
        token1.mint(p.recipient, amount1PerCollect);
        return (amount0PerCollect, amount1PerCollect);
    }
}
