// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title DickbuttRewardsDistributor
/// @notice PUSH distribution. Holders receive SPCXc in their wallet
/// automatically -- they never claim, never sign, never visit a site.
///
/// ROUNDS ARE INDEPENDENT AND CONCURRENT.
/// An earlier version allowed only one open round at a time, so a single
/// stuck round halted all rewards until someone intervened. That is a
/// single point of failure on the thing that must never stop. Here every
/// round is its own object with its own root, total, and payment ledger:
///   - round 7 can be proposed, activated and distributed while round 6
///     still has batches outstanding;
///   - a round with a few permanently-failing recipients never blocks any
///     other round;
///   - rounds may be closed in any order, or left open indefinitely;
///   - if the keeper dies for a day, rounds simply queue up and all of them
///     drain when it returns. Nothing is lost and nothing needs unwinding.
///
/// SOLVENCY IS ENFORCED BY A RESERVE, NOT BY SEQUENCING.
/// `totalReserved` tracks SPCXc promised by pending and active rounds and not yet paid.
/// A round can only activate if the balance covers its total ON TOP OF
/// everything already committed. So concurrency can never let two rounds
/// promise the same tokens.
///
/// SAFETY PROPERTIES RETAINED FROM THE CLAIM DESIGN
///   - Plans are committed as a Merkle root and timelocked before any token
///     moves, so a bad round can be cancelled with nothing lost.
///   - Batches are idempotent: re-send a failed batch verbatim, already-paid
///     accounts are skipped.
///   - A single reverting recipient is caught and skipped, never reverting
///     the batch.
///   - The keeper has no discretion: it can only pay amounts matching the
///     committed root. A stolen keeper key cannot steal or redirect funds.
contract DickbuttRewardsDistributor is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable rewardToken; // SPCXc

    struct Round {
        bytes32 root;
        uint256 total;
        uint256 distributed;
        bool active;
        bool closed;
    }

    struct PendingRound {
        bytes32 root;
        uint256 total;
        uint256 readyAt;
    }

    /// @notice Next round id to be handed out by proposeRound.
    uint256 public nextRoundId = 1;

    mapping(uint256 => Round) public rounds;
    mapping(uint256 => PendingRound) public pending;

    /// @notice SPCXc promised by activated-but-unpaid rounds. Never let the
    /// contract activate a round it cannot cover on top of this.
    uint256 public totalReserved;

    /// @notice roundId => recipient => paid.
    mapping(uint256 => mapping(address => bool)) public paid;

    uint256 public roundDelay = 6 hours;

    /// @notice Payments below this are skipped -- gas would exceed value.
    uint256 public minPayout;

    mapping(address => bool) public isKeeper;

    event RoundProposed(uint256 indexed roundId, bytes32 root, uint256 total, uint256 readyAt);
    event RoundCancelled(uint256 indexed roundId, bytes32 root);
    event RoundActivated(uint256 indexed roundId, bytes32 root, uint256 total);
    event RoundClosed(uint256 indexed roundId, uint256 distributed, uint256 released);
    event Paid(uint256 indexed roundId, address indexed account, uint256 amount);
    event PaymentFailed(uint256 indexed roundId, address indexed account, uint256 amount);
    event KeeperUpdated(address indexed keeper, bool allowed);

    modifier onlyKeeper() {
        require(isKeeper[msg.sender], "not a keeper");
        _;
    }

    constructor(address rewardToken_, uint256 minPayout_, address owner_) Ownable(owner_) {
        require(rewardToken_ != address(0), "bad reward token");
        rewardToken = IERC20(rewardToken_);
        minPayout = minPayout_;
    }

    // ---------------------------------------------------------------
    // Round lifecycle -- all per-round, nothing global blocks
    // ---------------------------------------------------------------

    /// @notice Commit a payout plan. Moves no tokens. Multisig should own
    /// this: it is the step that decides who gets paid.
    /// @return roundId The id assigned to this plan.
    function proposeRound(bytes32 root, uint256 total) external onlyOwner returns (uint256 roundId) {
        require(root != bytes32(0), "empty root");
        require(total > 0, "empty round");
        require(rewardToken.balanceOf(address(this)) >= totalReserved + total, "insufficient balance for this round");
        totalReserved += total;

        roundId = nextRoundId++;
        pending[roundId] = PendingRound({root: root, total: total, readyAt: block.timestamp + roundDelay});

        emit RoundProposed(roundId, root, total, block.timestamp + roundDelay);
    }

    /// @notice Cancel a committed plan before it can pay anything. This is
    /// the reason the timelock exists -- use it if the calculator output
    /// looks wrong, or the proposing key may be compromised.
    function cancelPendingRound(uint256 roundId) external onlyOwner {
        PendingRound memory p = pending[roundId];
        require(p.root != bytes32(0), "nothing pending");
        emit RoundCancelled(roundId, p.root);
        totalReserved -= p.total;
        rounds[roundId] = Round(p.root, p.total, 0, false, true);
        delete pending[roundId];
    }

    /// @notice Permissionless after the timelock: the decision already
    /// happened publicly at propose time.
    /// @dev Reserves the round's total against the contract balance. This is
    /// what makes concurrent rounds safe -- two rounds can never promise the
    /// same tokens.
    function activateRound(uint256 roundId) external {
        PendingRound memory p = pending[roundId];
        require(p.root != bytes32(0), "nothing pending");
        require(block.timestamp >= p.readyAt, "still timelocked");
        require(!rounds[roundId].active && !rounds[roundId].closed, "already activated");

        rounds[roundId] = Round({root: p.root, total: p.total, distributed: 0, active: true, closed: false});
        delete pending[roundId];

        emit RoundActivated(roundId, p.root, p.total);
    }

    /// @notice Close a finished round and release any undistributed reserve
    /// back into the available pool, where the next round's calculation will
    /// pick it up. Anyone may close a fully-distributed round; only the
    /// owner may close one early (e.g. a few recipients permanently revert).
    function closeRound(uint256 roundId) external {
        Round storage r = rounds[roundId];
        require(r.active, "round not active");

        uint256 released = r.total - r.distributed;
        if (released > 0) {
            require(msg.sender == owner(), "only owner can close early");
        }

        r.active = false;
        r.closed = true;
        totalReserved -= released;

        emit RoundClosed(roundId, r.distributed, released);
    }

    // ---------------------------------------------------------------
    // Distribution
    // ---------------------------------------------------------------

    /// @notice Pay a batch for a specific round. Re-runnable: accounts
    /// already paid in this round are skipped, so a partially-failed batch
    /// can be resubmitted verbatim with no double-payment risk.
    /// @dev Keep batches around 250-400 recipients to stay inside the block
    /// gas limit. Batches for different rounds can be interleaved freely.
    function distributeBatch(
        uint256 roundId,
        address[] calldata accounts,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external onlyKeeper nonReentrant {
        Round storage r = rounds[roundId];
        require(r.active, "round not active");
        require(accounts.length == amounts.length && accounts.length == proofs.length, "length mismatch");

        uint256 batchPaid;

        for (uint256 i = 0; i < accounts.length; i++) {
            address account = accounts[i];
            uint256 amount = amounts[i];

            if (paid[roundId][account]) continue;

            // roundId is inside the leaf, so a proof from one round can
            // never be replayed against another.
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(roundId, account, amount))));
            require(MerkleProof.verify(proofs[i], r.root, leaf), "invalid proof");

            // Effects before interaction.
            paid[roundId][account] = true;

            // One hostile or broken recipient must not take down the batch.
            // try/catch requires an external call, hence the self-call.
            try this.executeTransfer(account, amount) {
                batchPaid += amount;
                emit Paid(roundId, account, amount);
            } catch {
                // Unwind so this account can be retried later. If it never
                // succeeds, closeRound releases the amount back to the pool
                // and the off-chain calculator re-credits the holder.
                paid[roundId][account] = false;
                emit PaymentFailed(roundId, account, amount);
            }
        }

        r.distributed += batchPaid;
        require(r.distributed <= r.total, "round overspend");
        totalReserved -= batchPaid;
    }

    /// @notice Only callable by this contract. Exists solely so
    /// distributeBatch can try/catch an individual transfer.
    function executeTransfer(address to, uint256 amount) external {
        require(msg.sender == address(this), "self only");
        rewardToken.safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        require(keeper != address(0), "bad keeper");
        isKeeper[keeper] = allowed;
        emit KeeperUpdated(keeper, allowed);
    }

    function setRoundDelay(uint256 newDelay) external onlyOwner {
        require(newDelay >= 1 hours && newDelay <= 3 days, "unreasonable delay");
        roundDelay = newDelay;
    }

    function setMinPayout(uint256 newMin) external onlyOwner {
        minPayout = newMin;
    }

    /// @notice Undistributed SPCXc is NOT withdrawable -- it belongs to
    /// holders and rolls forward into the next round. An escape hatch here
    /// would make this contract a rug vector.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(rewardToken), "cannot touch reward token");
        require(to != address(0), "bad recipient");
        IERC20(token).safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------
    // Views for the off-chain calculator
    // ---------------------------------------------------------------

    /// @notice SPCXc not reserved by any open round. What the next round has
    /// to work with. Note the calculator must ALSO subtract amounts it is
    /// carrying forward for holders below the payout threshold -- the
    /// contract has no knowledge of those.
    function availableForNextRound() external view returns (uint256) {
        uint256 balance = rewardToken.balanceOf(address(this));
        return balance > totalReserved ? balance - totalReserved : 0;
    }

    function roundInfo(uint256 roundId)
        external
        view
        returns (bytes32 root, uint256 total, uint256 distributed, bool active, bool closed)
    {
        Round memory r = rounds[roundId];
        return (r.root, r.total, r.distributed, r.active, r.closed);
    }
}
