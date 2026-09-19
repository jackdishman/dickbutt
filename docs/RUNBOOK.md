# Runbook

What runs where, what each alert means, and what to do at 3am. Roles and their on-chain limits are in [GOVERNANCE.md](GOVERNANCE.md).

## Hosts

Four hosts. A shared host is a shared blast radius, so none of these keys may be co-located.

| Host | Jobs | Key | Cadence |
| --- | --- | --- | --- |
| `keeper` | fee-cycle, payout | `KEEPER_PRIVATE_KEY` | 6h, 1m |
| `ops` | floor-refresh | `OPS_PRIVATE_KEY` (the executor's floor setter) | 1h |
| `proposer` | calculate-and-propose, propose-pending | `PROPOSER_PRIVATE_KEY` | 6h, 1m |
| `monitor` | monitor | **none** | 5m |

```sh
npm run schedule                      # the plan, with the contract limits it respects
npm run schedule -- --format systemd --host keeper --workdir /srv/dickbutt
npm run schedule -- --format cron --host ops
```

The schedule lives in `operations/schedule.js` and is validated before rendering: it refuses if a key would land on two hosts, if the keeper key would run on the ops host, if the monitor holds a key or shares a host, or if a cadence contradicts a contract limit. Edit that file, not the rendered output.

The proposer runs `--propose-only`, which **refuses to start if `KEEPER_PRIVATE_KEY` is present in its environment**. That is the enforcement, not just the convention: the host that commits roots never holds the key that moves funds.

The ops key holds the executor's `floorSetter` role, not its ownership. On-chain it can call `setPriceFloor` and nothing else, cannot set a floor below the owner's `floorLowerBound`, and cannot be approved as a keeper. The executor's owner is the multisig, like every other contract.

## Journal distribution

The calculator journal (`periods/*.json`) has exactly one writer: the proposer host, where `calculate-and-propose` runs. The keeper host needs a copy to pay from, and the monitor host needs a copy to tell a foreign root from one of ours. Neither may write to it.

- Copy, do not share. A writable network mount joins the hosts into one blast radius and lets a compromised keeper host rewrite the record the proposer relies on. Pull a read-only copy after each proposer run: `rsync -a --delete proposer:/srv/dickbutt/data/periods/ /srv/dickbutt/data/periods/` into a staging directory, then rename it into place so the keeper never reads a half-copied file.
- A stale copy is safe. The keeper verifies every plan against the on-chain commitment before acting; a copy that lacks the newest period simply has nothing to do for that round yet.
- A torn copy is rejected by the journal checks. A consistently rewritten copy is checked by independent historical recalculation before signing; hashes and rebuilt Merkle proofs alone do not prove correct eligibility.
- Back the proposer's copy up somewhere the bots cannot write. It is the only replay record; `state.json` is a cache.

Locks are per host. Two hosts running the same key are not coordinated by anything here; that is why the schedule never puts one key on two hosts.

## Exit codes

Every job uses the same convention. Alert on 1 and 2; do not restart into them.

| Exit | Meaning | Response |
| --- | --- | --- |
| 0 | Healthy, or progressed normally | none |
| 2 | Needs a human; the run itself was fine | triage below |
| 1 | The run failed | investigate before rerunning |

systemd units are rendered with `SuccessExitStatus=0 2` so a "needs a human" result does not look like a crash loop.

## Triage

Always supply `--journal` in production. Without it, the monitor reports `journal: absent` and
skips unknown-root detection; its exit status then describes only the remaining checks. An empty
but supplied journal still alarms on every non-cancelled commitment. The monitor checks overdue
pending rounds, reserves outside its five-round window and stalled active payouts. It persists public
round observations beside the deployment manifest in `monitor-progress-<chain>-<distributor>.json`.
The first observation of an unpaid active round reports unknown age (attention); six hours without
a subsequent payment reports stalled progress. Keep this file across scheduler runs. Corrupt or
regressing observations fail closed. This is not a scheduler heartbeat: independently alert when
any scheduled job stops running or no new rounds appear despite incoming rewards.

### `unknown-commitment` — treat as a compromised proposer key

> round N carries a pending root the calculator journal never produced

**This is the alarm that matters.** A root exists on-chain that this pipeline did not create. Either someone holds the proposer key, or an operator worked outside the journal.

A proposer cannot directly call the keeper-only payout function. The keeper must independently
recalculate the supplied journal; checking only its hashes is insufficient. The selected zero
review delay gives the guardian no guaranteed cancellation window: anyone may activate immediately.
Pause future proposals and revoke compromised keeper roles promptly; pending cancellation may
already be unavailable by the time the Safe acts.

1. **Pause proposals.** Guardian multisig, no owner key needed:
   ```sh
   cast send $DISTRIBUTOR "pauseProposals(bool)" true --rpc-url $RPC_URL
   ```
2. **Cancel the round if it is still pending.** With zero review delay, activation can win this race:
   ```sh
   cast send $DISTRIBUTOR "cancelPendingRound(uint256)" $ROUND_ID --rpc-url $RPC_URL
   ```
   Cancelling does **not** refund the proposer's rate-limit slot, so a compromised key cannot immediately re-propose. The pause is what ends the race; the cancel just cleans up.
3. **Confirm the keeper never paid it.** `paid(roundId, account)` should be false throughout. If the foreign round took a round id the calculator had already planned, the keeper reports that round as `foreign-commitment` (exit 2) and keeps paying every other round; it holds no proofs for a foreign root and cannot pay it.
4. Rotate the proposer key, `setProposer(old, false)` and `setProposer(new, true)` from the owner, then unpause.
5. **Let the pipeline recover the collided round.** Once the foreign round is cancelled (or, if it was activated, closed early by the owner), the keeper reports the local plan as `superseded` and the next calculator run recredits every recipient of that plan and re-plans them under the next free round id. The run log shows the recredits and `superseded: ["N"]`.
6. The calculator spreads otherwise-payable accrual proportionally across the permitted round budget and preserves unpaid balances. No temporary cap increase is needed. Largest raw-unit remainders break ties by address. The payout threshold selects eligible accrued balances; an individual cap-limited instalment can be smaller than that threshold. Remaining credit is checked against the threshold again in later periods.

If the root turns out to be a legitimate out-of-band proposal that should stand, leave it; the calculator refuses to run while a foreign round is pending or active at a planned id, so cancel or close it before the next period. The pipeline cannot adopt a root it did not compute.

### `floor-lower-bound` — floor setters are unbounded

> floorLowerBound is zero; a compromised floor setter can set any floor

Set it from the owner before any floor setter is approved: `setFloorLowerBound(raw SPCXc per 1e18 WETH)`, conservatively below market. If the executor reports `does not expose floorLowerBound`, it predates the floor-setter role and must be redeployed.

### `price-floor` — swaps are blocked or about to be

> floor expired or unset; swaps are blocked / floor expires soon; the refresher may be down

Fees keep accruing safely; only the WETH→SPCXc conversion stops. Check the ops host first — this usually means the floor bot is dead or out of gas, not that anything is wrong on-chain.

```sh
npm run floor -- --config deployment.json            # read-only: what would it set?
OPS_PRIVATE_KEY=0x… npm run floor -- --config deployment.json --execute
```

If it refuses with *deviates Nbps from the active floor*, the quote moved more than 50% since the last refresh. **Look at the market before overriding.** Then `--force`.

If it refuses with *ops signer is an approved keeper*, someone put the wrong key on the ops host. Fix the host, do not remove the check. If it refuses with *below the owner lower bound*, the market has fallen through a line the owner drew deliberately; the owner reviews and lowers `floorLowerBound`, the bot does not.

### `gas` — a bot is about to stop silently

An unfunded key fails exactly like a dead one. Fund the named address. This is the most common cause of every other alert here, so check it first.

### `proposals` — the guardian has paused

Expected during an incident; alarming otherwise. If nobody paused deliberately, treat it as guardian-key compromise: the guardian can only stop things, not move funds, but a hostile pause is a denial of rewards. Unpause from the owner and rotate.

### `stale-round` — a round passed its timelock and was not activated

Activation is permissionless, so anyone can unblock this:

```sh
cast send $DISTRIBUTOR "activateRound(uint256)" $ROUND_ID --rpc-url $RPC_URL
```

Then find out why the keeper did not. Usually gas, a held lock, or an unresolved transaction.

### `round-progress` — unknown age or stalled active payment

On a first observation, inspect the unpaid round and keeper; the monitor cannot infer prior payment age. Later observations report attention after six hours with no increase in distributed rewards. A successful payment resets that clock. An observation file is not a substitute for a separate alert on a silent/crashed monitor.

### proposer `proposal-rate-limited`

The six-hour job calculates periods. `propose-pending` retries the same journal plan each minute, on the same proposer host/key, without calculating another period. A retry before `nextProposalAllowedAt` is expected; repeated lateness after that timestamp needs investigation. The journal must reach the keeper independently before payments can proceed.

### fee cycle `cooldown-race` or `reverted`

Another caller may harvest after readiness was read. A conclusively unsent estimate revert with a newly advanced cooldown skips that one call and continues the independent fee steps. A broadcast failure continues only after the exact failed receipt is confirmed and the source cooldown advance is observed; it reports attention because gas was spent. Transport errors, missing receipts and unproven reverts stop the cycle for reconciliation.

### fee cycle `awaiting-handoff`

A source whose custody handoff has not happened is skipped and named in `awaitingHandoff`, and the rest of the cycle routes and swaps whatever has already arrived. This is the expected state during a staged rollout, not an alert. Once the handoff is done the next cycle picks the source up with no change.

### keeper exit 2 — `partial` or `closed-unpaid`

`partial` is normal and self-healing: a recipient's transfer reverted, the amount stays reserved, and the next run retries only the unpaid accounts. Investigate if the same account fails repeatedly — a blocklisted or contract recipient may never succeed, in which case close the round early from the owner and let the calculator re-credit them.

`closed-unpaid` needs calculator reconciliation to recredit those holders in a later period.

### keeper exit 1 — `unresolved transaction`

The keeper persisted a transaction hash and never saw a receipt. It refuses to send anything further until that is settled — deliberately, because the alternative is double-paying.

```sh
cast tx $HASH --rpc-url $RPC_URL
cast receipt $HASH --rpc-url $RPC_URL
```

If it was mined, delete `keeper-pending-transaction.json` from the journal directory and rerun. If it was replaced or dropped, **inspect the signer's nonce and chain history before restarting** — the keeper will not guess whether a replacement paid or cancelled the operation.

### `keeper lock exists` / `floor lock exists`

The payout job and the fee cycle share the keeper key and will sometimes overlap; both wait up to five minutes (`--lock-wait`) for the other to finish before failing, so a plain overlap never pages. A lock that outlives the wait belongs to a crashed or stuck process: the error names its PID, host and start time. Verify that process is genuinely gone, check for outstanding transactions from that signer, then remove the directory. Locks coordinate processes on one host only; two hosts running the same key will both proceed.

## Compromised keys

| Key | What the holder can do | Immediate action |
| --- | --- | --- |
| Proposer | Commit roots; grief by reserving the pool. **Cannot move tokens.** | Guardian pause, cancel pending, rotate |
| Keeper | Swap at a bad-but-above-floor price; reorder or stall payouts. **Cannot redirect funds** — destinations are immutable and payouts are bounded by the committed root | `setKeeper(old,false)` from the owner, rotate |
| Ops (floor setter) | Set the floor anywhere down to `floorLowerBound`, or let it lapse and halt swaps. Cannot approve keepers, change limits or move funds; the executor refuses it as a keeper | `setFloorSetter(old,false)` from the owner, rotate, refresh the floor |
| Guardian | Pause proposals, cancel rounds. Denial only | `setGuardian(new)` from the owner |
| Owner multisig | Everything above, plus roles and limits. **Cannot withdraw reward tokens** — no such function exists | Full incident; there is no higher authority |

A proposer cannot directly call the keeper-only payout function. That separation alone did not establish correct payouts when the keeper copied the proposer's journal. The keeper now independently recalculates chain history before every proposal or payout. Keep its executable, configuration and RPC independently controlled. Owner authority is broader: the owner can appoint keepers and propose roots, and the swap-executor owner can change limits. Do not claim that no single administrative key can lose funds; use reviewed multisig ownership and a working guardian response.

## Timing you cannot tune away

`finalityTag: finalized` means the calculator only ever sees state that Base has finalized. On Base Sepolia that measured **~22 minutes behind head**, and mainnet is comparable. Consequences worth knowing before someone reports a bug:

- A fee cycle does not show up in a reward plan until finality passes it. A calculator run right after a harvest legitimately reports `No new finalized period.`
- A freshly funded holder needs a full period *after* finality catches up before their time-weighted balance qualifies. `roundId: null` on a first run is normal.
- The selected zero review delay adds no wait after proposal. Finality lag, calculator scheduling,
  journal replication, the next one-minute payout check and transaction processing still take time.
  Fee and calculator jobs on separate hosts must be coordinated: fees not yet finalized at the
  calculation snapshot wait for a later plan. Six-hour job intervals do not establish exact
  wall-clock delivery to each holder.

This is deliberate. An unfinalized snapshot could be reorged out from under a committed Merkle root, and the root is what the contract pays against.

## Routine checks

- `npm run monitor -- --config deployment.json --journal ./data` on the monitor host; page on exit 2
- Gas balance on all three bot keys, plus whatever pays for the owner multisig
- The floor bot logging a `transaction-confirmed` within its expected cadence — silence is the failure mode
- `npm run preflight -- --config config/base-mainnet.json --strict` before any configuration change
- Journal backups. The journal is the replay and integrity record; cached `state.json` is not an execution source and a deleted journal cannot be reconstructed from it
