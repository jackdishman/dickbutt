# Roles and bounds

Normal operation needs **zero multisig signatures**. Bots propose, activate and pay; the multisig exists to stop something.

| Role | Key | Can do | Cannot do |
| --- | --- | --- | --- |
| Owner | multisig | Set roles and limits, unpause, close a round early, rescue non-reward tokens | Withdraw reward tokens — there is no such function |
| Guardian | same multisig | Cancel any pending round, pause/unpause proposals | Move tokens, set roles or limits |
| Proposer | bot | `proposeRound` within the cap, interval and pause | Move tokens, choose who gets paid beyond the committed root |
| Keeper | bot | `processWeth`, `distributeBatch` | Propose, change amounts, weaken the price floor |
| Ops | bot, separate host | `setPriceFloor` on the swap executor | Anything a keeper does — the bot refuses a keeper key |
| Anyone | — | `harvest`, `activateRound` after the timelock, `closeRound` when fully paid, `splitDickbutt`/`splitWeth` | — |

The owner is implicitly a proposer, so the multisig can always act without waiting on a bot. Guardian defaults to the owner at deployment and can be split out later without redeploying.

## What a stolen proposer key can and cannot do

**It cannot move a token.** `distributeBatch` is keeper-gated and pays only amounts inside the committed root, and the keeper independently rebuilds every root from its own calculator journal — a root it did not produce throws `commitment mismatch` and it refuses to distribute. Theft requires the proposer key **and** the keeper key **and** the keeper's journal.

What a stolen proposer key *can* do is grief: reserve the pool against real rounds. That is what the on-chain bounds limit.

| Bound | Default | Effect |
| --- | --- | --- |
| `maxRoundBps` | 2500 (25%) | One round may commit at most this share of the unreserved balance |
| `minRoundInterval` | 12 hours | Spacing between proposals. A cancellation does **not** refund the slot |
| `roundDelay` | 24 hours | Timelock before a pending round can activate |
| `proposalsPaused` | false | Guardian switch that stops new proposals outright |

Cancelling is a race against a compromised proposer re-proposing; **pausing ends the race**. Pause never strands owed rewards — activation and payment of already-committed rounds continue.

`roundDelay` is 24 hours rather than the original 6. Routine operation needs no human signature, so the only cost of a longer delay is latency, while the guardian needs time to wake up, notice and act. It is adjustable between 1 hour and 3 days.

## The share cap changes the payout schedule

**This is an economic decision, not just a safety knob.** The calculator plans the whole distributable pot each round. With a cap below 100%, each round pays at most that share and the remainder rolls into the next period, so a permanent buffer accumulates in the distributor.

At 25% the local rehearsal shows it directly: 1,615 raw SPCXc available, cap 403, plan 402, and 1,213 carried forward. In steady state the undistributed buffer settles at roughly `inflow / maxRoundBps` — about 4× per-round inflow at 25%.

Pick the number deliberately:

| `maxRoundBps` | Buffer held back | Notes |
| --- | --- | --- |
| 10000 | none | Cap disabled. Timelock, interval and guardian still apply |
| 5000 | ~2× inflow | Halves a single bad round, modest delay |
| 2500 | ~4× inflow | Current default |

The calculator reads `maxProposableTotal()` and caps new shares to it, so a plan is always proposable. Without that it would build rounds the contract always rejects and nothing would ever pay. Carry from earlier periods can still push the payable total past the cap; that **fails loudly** rather than silently deferring a specific holder, and is fixed by raising `maxRoundBps` or lowering the payout threshold.

A share cap that floors to zero against a dust balance blocks proposals entirely. `maxProposableTotal()` returns 0 in that case so operators can see it before hitting a revert.

## Key isolation

Four bot keys, none of which should share a host with another:

- **Keeper** — `processWeth`, `distributeBatch`
- **Proposer** — `proposeRound`. `PROPOSER_PRIVATE_KEY`; the keeper CLI refuses it when it equals `KEEPER_PRIVATE_KEY`
- **Ops** — `setPriceFloor`. Refuses to run as an approved keeper. [Price-floor bot](PRICE-FLOOR.md)
- **Monitor** — no key at all; read-only alerting, deliberately elsewhere

The local rehearsal runs owner, keeper, proposer and guardian as four distinct signers and asserts the floor bot rejects a keeper key.

## Operating checklist

1. Deploy with the multisig as `owner`. `guardian` defaults to it.
2. `setProposer(bot, true)` and `setKeeper(bot, true)` with **different** addresses.
3. Choose `setRoundLimits(maxRoundBps, minRoundInterval)` against the payout schedule above.
4. Fund every bot key with ETH on Base. An unfunded key fails exactly like a compromised one is stopped — silently, until something alerts.
5. Alert on keeper exit 2 (`partial`, `closed-unpaid`, `proposal-rate-limited`), on floor-bot exit 2, and on any `RoundProposed` the calculator journal did not produce.
6. Rehearse the guardian path — pause, cancel, unpause — before relying on it.
