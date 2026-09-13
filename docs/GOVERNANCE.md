# Roles and bounds

Normal operation needs **zero multisig signatures**. Bots propose, activate and pay; the multisig exists to stop something.

| Role | Key | Can do | Cannot do |
| --- | --- | --- | --- |
| Owner | multisig | Set roles and limits, unpause, close a round early, rescue non-reward tokens, set the floor lower bound | Withdraw reward tokens — there is no such function |
| Guardian | same multisig | Cancel any pending round, pause/unpause proposals | Move tokens, set roles or limits |
| Proposer | bot | `proposeRound` within the cap, interval and pause | Move tokens, choose who gets paid beyond the committed root |
| Keeper | bot | `processWeth`, `distributeBatch` | Propose, change amounts, weaken the price floor |
| Ops (floor setter) | bot, separate host | `setPriceFloor` on the swap executor, at or above `floorLowerBound` | Anything else on the executor: approve keepers, change limits, rescue, transfer ownership. Cannot be a keeper — the contract refuses the pairing in both directions |
| Anyone | — | `harvest`, `activateRound` after the timelock, `closeRound` when fully paid, `splitDickbutt`/`splitWeth` | — |

The owner is implicitly a proposer and a floor setter, so the multisig can always act without waiting on a bot. Guardian defaults to the owner, follows an ownership transfer unless it was split out with `setGuardian`, and can be split out later without redeploying.

The swap executor's owner is the multisig too. Its daily floor refresh is signed by the floor-setter role precisely so that no hot key owns a contract: an executor owner can approve itself as keeper, set a one-unit floor, raise the cap and swap the whole WETH balance at a price it just moved, and 80% of all WETH fees pass through that contract. A floor setter can only move the floor, and only down to the owner's bound.

## What a stolen proposer key can and cannot do

The proposer role cannot call `distributeBatch`; a keeper is required to pay a committed root. The keeper now independently rebuilds the complete payout history from chain data before signing. Merely checking a copied journal and its own hashes was insufficient: a proposer host could supply a consistent but incorrect plan. Keep the keeper code, configuration and RPC independently controlled. The owner remains able to appoint keepers and propose roots, so its broader authority requires separate multisig review.

What a stolen proposer key *can* do is grief: reserve the pool against real rounds, or take a round id the calculator had already planned. The on-chain bounds limit the first. The second recovers on its own once the guardian cancels the foreign round: the calculator recredits the abandoned plan and re-plans it under the next id. [Runbook](RUNBOOK.md#unknown-commitment--treat-as-a-compromised-proposer-key).

| Bound | Default | Effect |
| --- | --- | --- |
| `maxRoundBps` | 5000 (50%) | One round may commit at most this share of the unreserved balance |
| `minRoundInterval` | 12 hours | Spacing between proposals. A cancellation does **not** refund the slot |
| `roundDelay` | 24 hours | Timelock before a pending round can activate |
| `proposalsPaused` | false | Guardian switch that stops new proposals outright |

Cancelling is a race against a compromised proposer re-proposing; **pausing ends the race**. Pause never strands owed rewards — activation and payment of already-committed rounds continue.

`roundDelay` is 24 hours rather than the original 6. Routine operation needs no human signature, so the only cost of a longer delay is latency, while the guardian needs time to wake up, notice and act. It is adjustable between 1 hour and 3 days.

## The share cap changes the payout schedule

**This is an economic decision, not just a safety knob.** The calculator plans the whole distributable pot each round. With a cap below 100%, each round pays at most that share and the remainder rolls into the next period, so a permanent buffer accumulates in the distributor.

The local rehearsal shows it directly at the 50% default: 1,615 raw SPCXc available, cap 807, plan 807, and 808 carried forward. For a simplified model with constant inflow `I` per round, immediate payout and share fraction `p = maxRoundBps / 10000`, the steady balance immediately after payout is `I * (1 - p) / p`; the available balance just before the next payout is `I / p`. At 50%, those are respectively one and two rounds of inflow. The actual timelocked, concurrent-round system also holds pending obligations and below-threshold accrual, so its raw vault balance is not predicted by this simple model alone.

| `maxRoundBps` | Simplified balance after payout | Notes |
| --- | --- | --- |
| 10000 | none | Cap disabled. Timelock, interval and guardian still apply |
| 5000 | ~1× inflow | **Current default.** Halves a single bad round at a modest backlog |
| 2500 | ~3× inflow | Tighter cap, noticeably slower payouts |

50% is the default because a stolen proposer key cannot move tokens at all — the cap only limits griefing, so paying a shorter backlog for a tighter bound is a poor trade. Raise or lower it with `setRoundLimits`; the calculator reads the live value every period.

The calculator reads `maxProposableTotal()` and caps new shares to it, so a plan is always proposable. Without that it would build rounds the contract always rejects and nothing would ever pay. Carry from earlier periods can still push the payable total past the cap; that **fails loudly** rather than silently deferring a specific holder, and is fixed by raising `maxRoundBps` or lowering the payout threshold.

A share cap that floors to zero against a dust balance blocks proposals entirely — at 50%, a single raw unit. `maxProposableTotal()` returns 0 in that case so operators can see it before hitting a revert.

## Round 1 measures from a bootstrap period

The calculator has to rebuild balances from the token's first block, so without intervention the first period's time-weighted average spans DICKBUTT's whole history and a wallet that bought last month averages to almost nothing. That may or may not be what you want, but it must be a decision.

`node calculate-rewards.js --config … --bootstrap` commits the first period with balances and a **zero pot**: no shares, no plan. The pot is untouched and reappears in the next period, which measures from the bootstrap boundary. It is only accepted before any period has been journaled. Run it once, right after the distributor is deployed and before the first scheduled calculator run.

## Key isolation

Three bot signing keys and a keyless monitor, with separately controlled hosts:

- **Keeper** — `processWeth`, `distributeBatch`
- **Proposer** — `proposeRound`. `PROPOSER_PRIVATE_KEY`; the keeper CLI refuses it when it equals `KEEPER_PRIVATE_KEY`
- **Ops** — `setPriceFloor` under the executor's `floorSetter` role, bounded by `floorLowerBound`. The contract refuses a keeper as a floor setter and vice versa; the bot refuses to run as an approved keeper. [Price-floor bot](PRICE-FLOOR.md)
- **Monitor** — no key at all; read-only alerting, deliberately elsewhere

The local rehearsal runs owner, keeper, proposer and guardian as four distinct signers and asserts the floor bot rejects a keeper key.

## Operating checklist

1. Deploy with the multisig as `owner` of every contract, the executor included. `guardian` defaults to it and follows it if ownership moves.
2. `setProposer(bot, true)` and `setKeeper(bot, true)` with **different** addresses. On the executor, `setFloorLowerBound(bound)` first, then `setFloorSetter(ops, true)` with a third address; the contract rejects the keeper, and rejects any setter while the bound is zero.
3. Confirm or change `setRoundLimits(maxRoundBps, minRoundInterval)` against the payout schedule above. Defaults are 5000 and 12 hours.
3b. Run the calculator once with `--bootstrap` before the first scheduled run, if round 1 should measure from launch rather than from the token's genesis.
4. Fund every bot key with ETH on Base. An unfunded key fails exactly like a compromised one is stopped — silently, until something alerts.
5. Alert on keeper exit 2 (`partial`, `closed-unpaid`, `proposal-rate-limited`), on floor-bot exit 2, and on any `RoundProposed` the calculator journal did not produce. `npm run monitor` checks the last of these directly; see the [runbook](RUNBOOK.md).
6. Rehearse the guardian path — pause, cancel, unpause — before relying on it.

## Why Splits handles the fan-out but not the swap

Splits' own [Swapper](https://splits.org/protocol/docs/core/swapper) product prices through Uniswap V3 and Chainlink. This pipeline swaps **WETH → USDC → SPCXc on Aerodrome Slipstream**, and SPCXc is a Base B20 precompile token, so that pricing model does not apply here.

So the split of responsibilities is deliberate:

- **Splits protocol** does the percentage fan-out only — immutable PushSplit V2.2 clones paying KC Green, the burn address and the CDB vault. The earlier custom `FeeSplitter.sol` remains for regression coverage; it is not the selected production splitter.
- **`SpcxcSwapExecutor`** does the swap, because the route is Aerodrome and the destination token is B20. Its protections are its own: a per-call cap, cooldown, deadline, keeper gate, and an owner price floor that expires within a day.

Reconsider Swapper only if the reward token and route ever move to a Uniswap V3 pair with a usable oracle. [Splits behaviour and exact rounding](SPLITS-INTEGRATION.md).

## Ownership and role rotation

Administrative ownership transfers require acceptance by the pending owner. Existing keeper, proposer and floor-setter approvals are separate storage entries and are not removed by ownership transfer. Explicitly revoke obsolete approvals and grant the final roles on every relevant contract. The distributor guardian follows the old owner only if it has not been separately assigned. Validate the actual post-transfer role set. The new native pipeline test exercises this with different simulated owner and bot wallets; it is not an actual multisig integration test.

The calculator journal binds its configuration, including excluded addresses. Before first calculation, fill the final production exclusion set. After rewards have started, changing that set for role rotation needs an explicit migration/replay procedure; simply editing the JSON causes the existing checker to refuse the changed configuration. Never delete accrued balances or payout history to get around that check.

Ownership, permanent destination freezing and permanent NFT locking are separate decisions. In particular, the legacy adapter cannot relay its creator authority to a replacement, and its fixed receiver leads through a router and executor with other fixed destinations. See [the permanence review](ALIGNMENT-RETEST-REPORT.md) before assigning any production custody or creator role.
