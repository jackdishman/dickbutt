# Roles and bounds

Normal configured operation needs **zero multisig signatures**. Bots propose, activate and pay; the multisig controls roles, limits and emergency actions. Current audit findings and deployment limitations are recorded in [AUDIT_REPORT.md](../AUDIT_REPORT.md).

| Role | Key | Can do | Cannot do |
| --- | --- | --- | --- |
| Owner | multisig | Set roles and limits, unpause, close a round early, rescue non-reward tokens, set the floor lower bound; appoint a keeper and propose arbitrary reward roots | Directly rescue the distributor's reward token; this does **not** prevent transfers through owner-appointed roles and roots |
| Guardian | same multisig | Cancel any pending round, pause/unpause proposals | Move tokens, set roles or limits |
| Proposer | bot | Commit any Merkle root with `proposeRound` within the cap, interval and pause | Execute payments without an approved keeper; the independently verifying keeper rejects a root inconsistent with holder history |
| Keeper | bot | `processWeth`, `distributeBatch` | Propose, change amounts, weaken the price floor |
| Ops (floor setter) | bot, separate host | `setPriceFloor` on the swap executor, at or above `floorLowerBound` | Anything else on the executor: approve keepers, change limits, rescue, transfer ownership. Cannot be a keeper — the contract refuses the pairing in both directions |
| Anyone | — | `harvest`, `activateRound` after the timelock, `closeRound` when fully paid, `splitDickbutt`/`splitWeth` | — |

The owner is implicitly a proposer and a floor setter, so the multisig can always act without waiting on a bot. Guardian defaults to the owner, follows an ownership transfer unless it was split out with `setGuardian`, and can be split out later without redeploying.

The swap executor's owner is the multisig too. Its daily floor refresh is signed by the floor-setter role precisely so that no hot key owns a contract: an executor owner can approve itself as keeper, set a one-unit floor, raise the cap and swap the whole WETH balance at a price it just moved, and 80% of all WETH fees pass through that contract. A floor setter can only move the floor, and only down to the owner's bound.

## What a stolen proposer key can and cannot do

The proposer role cannot call `distributeBatch`; a keeper is required to pay a committed root. The keeper now independently rebuilds the complete payout history from chain data before signing. Merely checking a copied journal and its own hashes was insufficient: a proposer host could supply a consistent but incorrect plan. Keep the keeper code, configuration and RPC independently controlled. The owner remains able to appoint keepers and propose roots, so its broader authority requires separate multisig review.

What a stolen proposer key *can* do is grief: reserve the pool against real rounds, or take a round id the calculator had already planned. The on-chain bounds limit the first. The second recovers on its own once the guardian cancels the foreign round: the calculator recredits the abandoned plan and re-plans it under the next id. [Runbook](RUNBOOK.md#unknown-commitment--treat-as-a-compromised-proposer-key).

| Bound | Selected deployment setting | Effect |
| --- | --- | --- |
| `maxRoundBps` | 5000 (50%) | One round may commit at most this share of the unreserved balance |
| `minRoundInterval` | 6 hours | Spacing between proposals. A cancellation does **not** refund the slot |
| `roundDelay` | 0 seconds | A newly proposed round can activate immediately; no guaranteed guardian review window |
| `proposalsPaused` | false | Guardian switch that stops new proposals outright |

Cancelling is a race against a compromised proposer re-proposing; **pausing ends the race**. Pause never strands owed rewards — activation and payment of already-committed rounds continue.

The constructor retains a 24-hour default. The selected deployment plan explicitly calls
`setRoundDelay(0)` at the user's request. The owner may set a delay from zero through three days;
the change affects only future proposals. Existing pending rounds retain their original `readyAt`.
At zero delay anyone may activate immediately, so cancelling a bad proposal is a race with no
guaranteed response window. Pausing proposals still stops future commitments, and the independent
keeper still reconstructs eligibility and amounts before paying. Neither protection is a substitute
for the removed review window, and the owner can still appoint keepers and propose arbitrary roots.

New reward rounds are scheduled every 6 hours with no extra review wait after proposal. The payout
job checks every minute; it sends no transaction when nothing is ready. The six-hour target depends
on successful proposals, available finalized rewards, eligibility and bot operation. An early job
can still hit the on-chain proposal interval and need a retry. Finality, journal replication and
transaction processing add latency; removing the timelock does not remove those dependencies.

## The share cap changes the payout schedule

**This is an economic decision, not just a safety knob.** The calculator allocates new shares subject to the live cap and previously carried credit. With a cap below 100%, each round pays at most that share of unreserved funds and the unallocated remainder stays available for later periods. Accrued amounts that cannot be paid remain recorded as holder credit.

The local rehearsal shows it directly at the 50% default: 1,615 raw SPCXc available, cap 807, plan 807, and 808 carried forward. For a simplified model with constant inflow `I` per round, immediate payout and share fraction `p = maxRoundBps / 10000`, the steady balance immediately after payout is `I * (1 - p) / p`; the available balance just before the next payout is `I / p`. At 50%, those are respectively one and two rounds of inflow. The actual timelocked, concurrent-round system also holds pending obligations and below-threshold accrual, so its raw vault balance is not predicted by this simple model alone.

| `maxRoundBps` | Simplified balance after payout | Notes |
| --- | --- | --- |
| 10000 | none | Cap disabled. Timelock, interval and guardian still apply |
| 5000 | ~1× inflow | **Current default.** Halves a single bad round at a modest backlog |
| 2500 | ~3× inflow | Tighter cap, noticeably slower payouts |

50% is the default because a stolen proposer key cannot move tokens at all — the cap only limits griefing, so paying a shorter backlog for a tighter bound is a poor trade. Raise or lower it with `setRoundLimits`; the calculator reads the live value every period.

The calculator reads `maxProposableTotal()` and caps new shares to it. If eligible accrued balances
exceed the round cap, it pays **proportional capped instalments** and retains every unpaid raw unit
as credit. Largest remainders assign indivisible raw units deterministically. The payout threshold
determines which accrued balances are eligible; a capped instalment can itself be smaller than
that threshold. A holder's remaining credit must reach the threshold again before a later payment.
This fixes the earlier cap-related calculation stall; see **M-01** in [the audit report](../AUDIT_REPORT.md).
Small budgets therefore need not pay every eligible holder each round. Changing the payout threshold
after journaling still requires a reviewed configuration migration; editing the file alone is
rejected by the existing journal integrity check.

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

1. Deploy with the multisig as `owner` of every contract, the executor included. `guardian` defaults to it on-chain and follows it if ownership moves, but write the address into `deployment.guardian` anyway: preflight refuses a null there rather than assuming the inheritance.
2. `setProposer(bot, true)` and `setKeeper(bot, true)` with **different** addresses. On the executor, `setFloorLowerBound(bound)` first, then `setFloorSetter(ops, true)` with a third address; the contract rejects the keeper, and rejects any setter while the bound is zero.
3. Confirm or change `setRoundLimits(maxRoundBps, minRoundInterval)` against the payout schedule above. Defaults are 5000 and 6 hours. This default applies to newly deployed contracts; an existing deployment retains its current setting until its owner changes it.
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

Ownership, permanent destination freezing and permanent **ERC-20 LP locking** in the selected Aerodrome vAMM harvester are separate decisions. An LP token contributor gains no individual withdrawal rights; all contributed LP shares inherit the harvester's lock. In particular, the legacy adapter cannot relay its creator authority to a replacement, and its fixed receiver leads through a router and executor with other fixed destinations. See [the current audit report](../AUDIT_REPORT.md) before assigning any production custody or creator role; the [earlier permanence review](ALIGNMENT-RETEST-REPORT.md) retains historical NFT evidence.

**Inspect pending destination changes during Safe ownership acceptance.** A transfer of ownership does not clear `pendingDestination` or its `pendingDestinationReadyAt` in either the vAMM or Clanker adapter. Once a pending change matures, anyone can apply it. Verify the current destination and pending proposal before acceptance; have the outgoing owner cancel an unwanted proposal before handing over, then verify the cleared state with the Safe. If acceptance already occurred, the Safe must inspect and cancel any unwanted pending change promptly and confirm whether it has already been applied. Freezing requires no pending proposal and is irreversible.

The **Clanker** lock is distinct from the new Aerodrome ERC-20 LP lock. `LockerHarvester.lockDestinationForever()` freezes the destination used by its `harvest()` function. It does **not** revoke the owner's `recoverReleasedPosition()` authority after the upstream locker unlocks. Once recovered, that underlying Clanker NFT's new owner controls future fee collection outside the adapter. Do not describe a frozen Clanker destination as permanent custody or an irrevocable future revenue stream.
