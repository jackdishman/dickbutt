# Price-floor bot

`SpcxcSwapExecutor`'s price floor expires within one day (`MAX_FLOOR_LIFETIME`). When it lapses, `processWeth` reverts and fee conversion stops until the owner refreshes it. `script/run-floor.mjs` automates that refresh and reports how long the current floor has left.

It is **a separate operational role from the keeper** and is built to run on separate infrastructure.

| | Keeper | Floor bot |
| --- | --- | --- |
| Key | `KEEPER_PRIVATE_KEY` | `OPS_PRIVATE_KEY` |
| On-chain role | approved keeper | executor owner |
| Writes | `processWeth`, `distributeBatch` | `setPriceFloor` |
| Lock namespace | `dickbutt-keeper-<chain>-<signer>` | `dickbutt-floor-<chain>-<signer>` |
| Needs the calculator journal | yes | no |

Three independent checks keep the keys apart, so a single compromised host cannot both move funds and set the price they move at:

1. `operations/floor.js` reads `executor.isKeeper(signer)` and **refuses to run** if the ops signer is an approved keeper — in dry-run as well as execute.
2. `script/run-floor.mjs` refuses when `OPS_PRIVATE_KEY` equals `KEEPER_PRIVATE_KEY`.
3. The lock names differ, so the two roles never serialise against each other and nothing implies they share a host.

The local rehearsal exercises all of this: signer 0 owns the contracts and refreshes the floor, signer 5 is the hot keeper, and the run asserts the bot rejects the keeper key.

## Run

```sh
# Read-only: report the active floor, time remaining and the floor a refresh would set.
npm run floor -- --config deployment.json

# Refresh. Requires OPS_PRIVATE_KEY and chain 31337 or 84532.
npm run floor -- --config deployment.json --execute

# Alerting role. No key is ever loaded. Exit 2 means someone should look.
npm run floor -- --config deployment.json --monitor
```

Defaults: 20-hour lifetime, refresh when under 8 hours remain, alert when under 4 hours, 5% slippage below the quote, and a 50% deviation guard against the active floor.

## Alerting

A crashed refresher cannot page anyone about itself, so **run `--monitor` somewhere else** — a third host, or an uptime checker that reads the exit code. It takes no key, makes no writes, and is the only part of this system that reliably notices the refresher is dead.

Exit codes: **0** fresh or refreshed, **2** needs attention, **1** failure. Output is JSON lines; `floor-expiring` carries `secondsRemaining` and `swapsBlocked`. Alert on exit 2, on any `floor-expiring`, and on a refresher that has not logged a `transaction-confirmed` within its expected cadence.

Status values are `fresh`, `refresh-required`, `refreshed` and `expired`. `alert` is independent of status: it is true whenever the remaining time is inside the warning window or the floor has already lapsed, and a refresh in the same invocation clears it rather than leaving a stale page.

## How the floor is derived

The bot quotes the route at `maxSwapPerCall` — the largest swap the executor can make, so the worst price impact and therefore the most conservative floor — then discounts by `--slippage-bps` and normalises to raw SPCXc per `1e18` raw WETH, which is what `minSpcxcPerWeth` means. A smaller real swap clears that floor comfortably.

**The floor is a coarse backstop, not an oracle and not the per-transaction slippage limit.** The keeper still computes a tight `minOut` from a fresh quote at the actual swap size; the executor enforces `max(keeperMin, ownerFloor)`, so a keeper can tighten the limit but never weaken it. A stale-but-unexpired floor is possible by design.

If the newly quoted floor deviates from the active floor by more than `--max-deviation-bps` (default 5000), the bot **refuses and exits nonzero** rather than writing a backstop derived from a possibly manipulated quote. Review the quote, then rerun with `--force`.

## Limits

Execution is restricted to chain 31337 and Base Sepolia 84532, like every other operating CLI here. Lifting that is a separate production-operating decision, not a config change.

The bot does not fund itself. The ops key needs ETH on Base, and an unfunded ops key fails exactly like a crashed one — which is another reason the monitor belongs on different infrastructure. It refuses to run while its signer has a pending transaction, and a crashed process leaves its lock behind for manual inspection.
