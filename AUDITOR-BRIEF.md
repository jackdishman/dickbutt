# Brief for the reviewing developer

This code was written by an AI (Claude) across a long design conversation.
It has **never been compiled and never been executed** — the environment it
was written in had no network access and no toolchain. Every line is
reasoned, none is verified. Please treat it as a detailed specification that
happens to be written in Solidity and JavaScript, not as working software.

Several real bugs were found and fixed during self-review (a meaningless
swap deadline, a missing exclusion list that would have let liquidity pools
farm rewards, a reused decimals constant, a read-skew between two vault
calls, an event-counting design that would have stranded an entire income
stream). That success rate is exactly why an independent pass matters: the
same author who wrote each bug also wrote the review that missed it first
time round.

## What the system does

DICKBUTT is an immutable 2024 Clanker token with no tax hook. It cannot be
modified and will not be replaced. So holder rewards are built entirely
around it: trading fees are harvested, converted to SPCXc, and PUSHED to
holders automatically in batches. Holders never claim and never sign
anything.

Push was a deliberate product decision. The safety properties usually lost
by choosing push over claim are reinstated in `DickbuttRewardsDistributor`:
the payout plan is committed as a Merkle root and timelocked before any
token moves, batches are idempotent, individual transfer failures are
caught rather than reverting the batch, and the executing keeper can only
pay amounts that match the committed root.

Read `README.md` for the flow. Contracts in `contracts/`, off-chain
calculator in `calculator/`.

## Unverified assumptions — please check these first

1. **Router interface.** `FeeSplitter` assumes a Uniswap-V3-style
   `exactInputSingle`. The intended venue is Aerodrome Slipstream, a fork.
   Not verified against the live router. Also assumes a **single-hop**
   WETH→SPCXc route exists with real liquidity; if the best route is
   multi-hop, this function is wrong and needs `exactInput` with a path.
2. **SPCXc token behaviour.** Assumed to be a standard ERC-20. If it is
   fee-on-transfer, rebasing, blocklisting, or pausable, several things
   break — most importantly `minOut` accounting and the vault's
   balance-derived distributable calculation. Please confirm.
3. **Clanker LpLocker semantics.** We read the deployed source
   (`0x2Ad4DB8ba8de03834DB14454Afcd74C2393d81C4`) and concluded
   `collectFees` is owner-gated with no delegate role, and that the
   protocol takes a cut before the recipient is paid. **This now matters
   more than anything else in the review**, because `LockerHarvester` is
   designed to take ownership of that locker, and that transfer is
   single-step and irreversible. Please independently confirm:
   - `collectFees(address,uint256)` has exactly the signature we assume
   - the locker inherits OpenZeppelin `Ownable` (single-step
     `transferOwnership`, no acceptance handshake) — if it is actually
     `Ownable2Step`, our deployment instructions are wrong
   - nothing else in the locker becomes unreachable or dangerous once a
     contract owns it rather than an EOA. In particular `release()` (gated
     on a vesting timestamp set ~1000 years out, so presumed unreachable)
     and `withdrawERC20()` (which looks broken anyway — it calls
     `transferFrom(address(this), owner(), balanceOf(owner()))`, using the
     owner's balance, without approval). Confirm neither creates a problem
     or a trapped-value scenario under contract ownership.
4. **DICKBUTT decimals = 18.** Taken from BaseScan. Trivial to confirm.
5. **Reorg depth on Base.** The calculator stays 50 blocks behind the tip.
   Confirm that is comfortably beyond realistic reorg depth.

## Known gaps we chose not to close

- **Keeper MEV.** A compromised keeper key can pass a deliberately bad
  `minOut` and let a bot sandwich the swap. Funds still reach the vault
  (destination is immutable) but less arrives. Mitigated by bounding the
  damage — `maxSwapPerCall`, `minSwapInterval`, instant revocation — rather
  than by an on-chain TWAP floor. Reasoning is documented in the contract
  header. If you think the TWAP floor is worth its complexity, say so.
- **`rescueToken` on the forwarder** can move any non-WETH token anywhere.
  That makes the forwarder owner a privileged role, not a low-stakes one.
  Vault's `rescueToken` deliberately cannot touch SPCXc.
- **Merkle root correctness is entirely off-chain.** The distributor
  verifies proofs but has no idea whether the amounts are fair. The 6-hour
  timelock is the only defence, and unlike a claim model there is no holder
  action in between to catch a problem. Please review the calculator as
  carefully as the contracts — arguably more carefully.
- **Push means gas is paid by the project**, and rounds are sequential: a
  new round cannot be calculated until the previous one is closed. If a
  round stalls (keeper down, batches unsent), rewards stop until it is
  resolved. There is no holder-side fallback.
- **No pause mechanism** on the distributor, to avoid handing the owner a
  freeze-holder-funds power. Push back if you disagree.

## Specific things worth attacking

**AerodromeFeeHarvester**
- Does Slipstream's `NonfungiblePositionManager.collect` actually match the
  Uniswap V3 signature assumed here? Not verified against the live contract.
- The harvest pattern collects to `address(this)` then sweeps by token
  balance rather than by token0/token1 ordering. Is there any path where a
  stray balance of DICKBUTT or SPCXc could be sent to the contract and then
  swept to the wrong destination on the next harvest? (Deliberate tradeoff:
  it avoids depending on token ordering, but it does mean any DICKBUTT sent
  here gets burned and any SPCXc gets distributed.)
- Is `withdrawPosition` genuinely unreachable before `unlockTime`, and
  permanently unreachable after `lockForever()`?
- `extendLock` can only move `unlockTime` later — confirm no overflow or
  ordering trick defeats that.
- Confirm the contract can actually receive the position NFT
  (`onERC721Received`) and that nothing else about contract-ownership of a
  Slipstream position breaks fee collection.
- Should `burnAddress` really be immutable while `spcxcDestination` is
  timelock-changeable? That asymmetry is intentional; push back if wrong.

**LockerHarvester**
- Is `harvest()` genuinely safe to leave permissionless? The caller has no
  parameters and cannot influence the destination — confirm there is no
  reentrancy or gas-griefing angle via the locker's `collectFees`.
- Can `applyDestination()` be reached before its timelock expires?
- Does `lockDestinationForever()` actually close every mutation path? Check
  `proposeDestination`, `applyDestination`, and `setDestinationDelay`.
- Is there any sequence that leaves the locker owned by this contract but
  with fees flowing nowhere useful (e.g. destination locked to a contract
  that later self-destructs or stops accepting tokens)? This is the
  scenario that would permanently kill the fee stream, so it matters more
  than anything else here.
- Is `minInterval` ever able to wedge harvesting entirely?

**DickbuttRewardsDistributor**
- Does the leaf encoding in `distributeBatch` (double `keccak256` over
  `abi.encode(uint256,address,uint256)`) match exactly what
  `StandardMerkleTree.of(values, ["uint256","address","uint256"])`
  produces? A mismatch does not revert loudly in any useful way — it makes
  every payment fail. Highest-consequence single line in the system.
- The `try this.executeTransfer(...) catch` pattern: is unwinding
  `paid[roundId][account] = false` inside the catch safe? Can a malicious
  recipient exploit the retry path, burn gas to force a partial batch, or
  cause inconsistent `roundDistributed` accounting?
- `executeTransfer` is `external` but guarded by
  `require(msg.sender == address(this))`. Confirm that is airtight.
- Can `roundDistributed` desync from the sum of actual transfers?
- Reentrancy: `nonReentrant` guards the batch, but `executeTransfer` is a
  self-call — confirm the guard is not bypassed by that pattern, and that a
  hostile reward token with transfer hooks cannot re-enter.
- Can a round be activated before its timelock expires, via any path?
- Is there a sequence that leaves a round permanently active and unclosable
  (e.g. some recipients always revert, and the owner key is lost)?
- Gas: is 250 recipients per batch actually safe on Base, including
  proof verification? What is the realistic ceiling?

**FeeSplitter**
- `forceApprove` to 0 after the swap — correct, or does it break routers
  that pull lazily?
- Split arithmetic: both split functions compute the last slice as a
  remainder rather than a percentage, so rounding dust is never stranded.
  Confirm that holds for all balances including 1 wei.
- All recipients and both bps values are immutable. Confirm there is
  genuinely no path to redirect them, and that the constructor's
  `kcGreenBps + cdbVaultBps < BPS` check is sufficient.
- `splitDickbutt()` is permissionless. Confirm there is no griefing angle
  in calling it with a tiny balance repeatedly.

**Calculator**
- Round sequencing: the script refuses to run while a round is active
  on-chain. Is that check sufficient to prevent computing a round against
  funds already committed to the previous one?
- TWAB maths in `computeTWAB`: is the settle-up-on-touch pattern correct for
  addresses that never transact during a period? For addresses that go to
  zero and back? For self-transfers (`from == to`)?
- `bigIntSqrt` correctness at extremes (0, 1, very large balances).
- Integer-division ordering in `distribute` — is truncation dust always
  retained rather than lost?
- Can `outstanding` go negative in any legitimate scenario, or is the throw
  correct?
- Address-casing: could the same wallet appear twice under different
  casing across runs and be double-credited?
- Is `state.json` + `periods/` genuinely sufficient to reconstruct state
  after a loss, or is there a hidden dependency on a past vault balance
  that cannot be recovered?

## Issues found in self-review that are NOT fixed in code

These are judgement calls or operational constraints, not bugs. Flagging so
you do not have to rediscover them:

- **Off-chain accrual remains calculator state.** The contract reserves every
  pending and active round on-chain; the calculator also journals below-threshold
  accrual and refuses to size a plan that exceeds the snapshot balance.
- **Two calculator runs before proposing collide on roundId.** The script
  reads `nextRoundId()`, so two runs before a `proposeRound` call both target
  the same id. The refusal to overwrite an existing `round-N.json` catches
  this locally, but it is a real operational footgun.
- **Raising `minPayout` after proposal no longer strands a round.** Committed
  leaves are executed without consulting mutable `minPayout`.
- **`rescueETH` and `rescueToken` on the forwarder** give the owner real
  fund-movement power. The forwarder owner is not a low-privilege role.
- **Gas is externally funded.** The reward-funded `topUpGas` entry point was
  removed, so keeper-wallet loss cannot drain splitter WETH.

## Scale note

If DICKBUTT's holder count grows large enough that direct event scanning
becomes slow, the intended upgrade is a real indexer (Ponder or Envio) into
Postgres, replacing the scan + JSON state. The distribution maths would not
change. We stayed with direct scanning because it has no extra
infrastructure to secure and is adequate at a weekly harvest cadence — but
flag it if you think the crossover point is nearer than we assume.

## Before mainnet

Full cycle on Base Sepolia, multiple claiming wallets, then mainnet with a
deliberately small amount of SPCXc before scaling up.

## Independent implementation status

The prototype issues requested in this brief are addressed in the canonical
`src/` tree and covered by the local suites. Reconciliation read skew,
pending-round reservation, reward-funded gas drainage, the Slipstream ABI,
execution-time `minPayout`, calculator journaling, Clanker release recovery,
Aerodrome NFT receipt, and unlock validation are fixed and tested. Weighting is
an explicit setting: linear is recommended for Sybil neutrality; sqrt remains
available as an accepted, documented economic choice. Keeper slippage is
mitigated with an expiring owner-set floor that the keeper cannot weaken; it
is not an oracle, so stale owner configuration remains an accepted risk.

The pinned Base evidence is in `artifacts/base-inspection.json`; no mainnet
custody transfer or deployment was broadcast. Fork tests verify the live
locker and DICKBUTT facts at that block. Optional live SPCXc and Aerodrome
position checks skip unless explicitly configured with funded addresses.
