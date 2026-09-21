# Price-floor bot

`SpcxcSwapExecutor`'s price floor expires within one day (`MAX_FLOOR_LIFETIME`). When it lapses, `processWeth` reverts and fee conversion stops until an approved floor setter or owner refreshes it. `script/run-floor.mjs` automates that refresh and reports how long the current floor has left.

It is **a separate operational role from the keeper** and is built to run on separate infrastructure.

| | Keeper | Floor bot |
| --- | --- | --- |
| Key | `KEEPER_PRIVATE_KEY` | `OPS_PRIVATE_KEY` |
| On-chain role | approved keeper | approved floor setter, bounded by `floorLowerBound` |
| Writes | `processWeth`, `distributeBatch` | `setPriceFloor` |
| Lock namespace | `dickbutt-keeper-<chain>-<signer>` | `dickbutt-floor-<chain>-<signer>` |
| Needs the calculator journal | yes | no |

Four independent checks keep the keys apart, so a single compromised host cannot both move funds and set the price they move at:

1. **On-chain.** `setFloorSetter` rejects an approved keeper, rejects any setter while `floorLowerBound` is zero, and `setKeeper` rejects an approved floor setter. A floor setter can call `setPriceFloor` and nothing else, and not below the owner's `floorLowerBound`. The executor's owner is the multisig; no bot key owns it.
2. `operations/floor.js` reads `executor.isKeeper(signer)` and **refuses to run** if the ops signer is an approved keeper — in dry-run as well as execute. In execute mode it also refuses a signer that is neither a floor setter nor the owner, fresh floor or not, so a misconfigured host is found on its first scheduled run.
3. `script/run-floor.mjs` refuses when `OPS_PRIVATE_KEY` equals `KEEPER_PRIVATE_KEY`.
4. The lock names differ, so the two roles never serialise against each other and nothing implies they share a host.

The bound is what makes a hot floor key survivable. Without it, a stolen key sets a one-unit floor and the next swap executes at whatever price the thief just moved the pool to. With it, the worst a stolen key can do is drop the floor to the owner's line. Set `floorLowerBound` conservatively below market and revisit it rarely; if the market falls through it, swaps halt until the owner lowers it, and the bot says so rather than routing around it.

The local rehearsal exercises all of this: signer 0 owns the contracts, signer 8 is the floor setter that refreshes the floor, signer 5 is the hot keeper, and the run asserts the contract rejects the keeper as a setter, rejects a setter floor below the bound, rejects the setter calling `setKeeper`, and that the bot refuses a keeper key and an unknown key.

## Run

```sh
# Read-only: report the active floor, time remaining and the floor a refresh would set.
npm run floor -- --config deployment.json

# Refresh on local/Sepolia. Requires OPS_PRIVATE_KEY (an approved floor setter, or the owner).
# Base mainnet additionally needs --allow-mainnet and the separate manifest ops signer;
# see PRODUCTION-OPERATING-MODE.md before preparing production commands.
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

If the newly quoted floor deviates from the active floor by more than `--max-deviation-bps` (default 5000), the bot **refuses and exits nonzero** rather than writing a backstop derived from a possibly manipulated quote. Review the quote, then rerun with `--force`. A quote that lands below `floorLowerBound` is refused for every signer, including the owner, and `--force` does not override it; the output reports `floorLowerBound` and `lowerBoundUnset` so the monitor can flag a bound that was never set.

## Limits

Execution is restricted to chain 31337 and Base Sepolia 84532, like every other operating CLI here. Lifting that is a separate production-operating decision, not a config change.

The bot does not fund itself. The ops key needs ETH on Base, and an unfunded ops key fails exactly like a crashed one — which is another reason the monitor belongs on different infrastructure. It refuses to run while its signer has a pending transaction, and a crashed process leaves its lock behind for manual inspection.
