# Runbook

What runs where, what each alert means, and what to do at 3am. Roles and their on-chain limits are in [GOVERNANCE.md](GOVERNANCE.md).

## Hosts

Four hosts. A shared host is a shared blast radius, so none of these keys may be co-located.

| Host | Jobs | Key | Cadence |
| --- | --- | --- | --- |
| `keeper` | fee-cycle, payout | `KEEPER_PRIVATE_KEY` | 6h, 15m |
| `ops` | floor-refresh | `OPS_PRIVATE_KEY` | 1h |
| `proposer` | calculate-and-propose | `PROPOSER_PRIVATE_KEY` | 12h |
| `monitor` | monitor | **none** | 5m |

```sh
npm run schedule                      # the plan, with the contract limits it respects
npm run schedule -- --format systemd --host keeper --workdir /srv/dickbutt
npm run schedule -- --format cron --host ops
```

The schedule lives in `operations/schedule.js` and is validated before rendering: it refuses if a key would land on two hosts, if the keeper key would run on the ops host, if the monitor holds a key or shares a host, or if a cadence contradicts a contract limit. Edit that file, not the rendered output.

The proposer runs `--propose-only`, which **refuses to start if `KEEPER_PRIVATE_KEY` is present in its environment**. That is the enforcement, not just the convention: the host that commits roots never holds the key that moves funds.

## Exit codes

Every job uses the same convention. Alert on 1 and 2; do not restart into them.

| Exit | Meaning | Response |
| --- | --- | --- |
| 0 | Healthy, or progressed normally | none |
| 2 | Needs a human; the run itself was fine | triage below |
| 1 | The run failed | investigate before rerunning |

systemd units are rendered with `SuccessExitStatus=0 2` so a "needs a human" result does not look like a crash loop.

## Triage

### `unknown-commitment` — treat as a compromised proposer key

> round N carries a pending root the calculator journal never produced

**This is the alarm that matters.** A root exists on-chain that this pipeline did not create. Either someone holds the proposer key, or an operator worked outside the journal.

A stolen proposer key **cannot move tokens on its own** — payment is keeper-gated and the keeper refuses any root its journal did not produce — so you have the full 24-hour timelock to act. Do not panic-send transactions.

1. **Pause proposals.** Guardian multisig, no owner key needed:
   ```sh
   cast send $DISTRIBUTOR "pauseProposals(bool)" true --rpc-url $RPC_URL
   ```
2. **Cancel the pending round** before its timelock expires:
   ```sh
   cast send $DISTRIBUTOR "cancelPendingRound(uint256)" $ROUND_ID --rpc-url $RPC_URL
   ```
   Cancelling does **not** refund the proposer's rate-limit slot, so a compromised key cannot immediately re-propose. The pause is what ends the race; the cancel just cleans up.
3. **Confirm the keeper never paid it.** `paid(roundId, account)` should be false throughout, and the keeper logs should show a `commitment mismatch` refusal.
4. Rotate the proposer key, `setProposer(old, false)` and `setProposer(new, true)` from the owner, then unpause.

If the root turns out to be a legitimate out-of-band proposal, unpause and get it into the journal before proposing again.

### `price-floor` — swaps are blocked or about to be

> floor expired or unset; swaps are blocked / floor expires soon; the refresher may be down

Fees keep accruing safely; only the WETH→SPCXc conversion stops. Check the ops host first — this usually means the floor bot is dead or out of gas, not that anything is wrong on-chain.

```sh
npm run floor -- --config deployment.json            # read-only: what would it set?
OPS_PRIVATE_KEY=0x… npm run floor -- --config deployment.json --execute
```

If it refuses with *deviates Nbps from the active floor*, the quote moved more than 50% since the last refresh. **Look at the market before overriding.** Then `--force`.

If it refuses with *ops signer is an approved keeper*, someone put the wrong key on the ops host. Fix the host, do not remove the check.

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

A crashed process left its lock. Verify the recorded PID and host in `owner.json` are genuinely gone, check for outstanding transactions from that signer, then remove the directory. Locks coordinate processes on one host only; two hosts running the same key will both proceed.

## Compromised keys

| Key | What the holder can do | Immediate action |
| --- | --- | --- |
| Proposer | Commit roots; grief by reserving the pool. **Cannot move tokens.** | Guardian pause, cancel pending, rotate |
| Keeper | Swap at a bad-but-above-floor price; reorder or stall payouts. **Cannot redirect funds** — destinations are immutable and payouts are bounded by the committed root | `setKeeper(old,false)` from the owner, rotate |
| Ops | Set a harmful floor, or let it lapse and halt swaps. **Cannot move funds** | Rotate the executor owner; refresh the floor |
| Guardian | Pause proposals, cancel rounds. Denial only | `setGuardian(new)` from the owner |
| Owner multisig | Everything above, plus roles and limits. **Cannot withdraw reward tokens** — no such function exists | Full incident; there is no higher authority |

Theft of holder rewards requires the proposer key **and** the keeper key **and** the calculator journal. No single key loses funds.

## Timing you cannot tune away

`finalityTag: finalized` means the calculator only ever sees state that Base has finalized. On Base Sepolia that measured **~22 minutes behind head**, and mainnet is comparable. Consequences worth knowing before someone reports a bug:

- A fee cycle does not show up in a reward plan until finality passes it. A calculator run right after a harvest legitimately reports `No new finalized period.`
- A freshly funded holder needs a full period *after* finality catches up before their time-weighted balance qualifies. `roundId: null` on a first run is normal.
- Total latency from fee collection to payout is finality lag, plus the calculator period, plus the 24-hour timelock. Budget a day, not an hour.

This is deliberate. An unfinalized snapshot could be reorged out from under a committed Merkle root, and the root is what the contract pays against.

## Routine checks

- `npm run monitor -- --config deployment.json --journal ./data` on the monitor host; page on exit 2
- Gas balance on all three bot keys, plus whatever pays for the owner multisig
- The floor bot logging a `transaction-confirmed` within its expected cadence — silence is the failure mode
- `npm run preflight -- --config config/base-mainnet.json --strict` before any configuration change
- Journal backups. The journal is the replay and integrity record; cached `state.json` is not an execution source and a deleted journal cannot be reconstructed from it
