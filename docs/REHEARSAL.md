# Deployment rehearsal

`npm run rehearse` deploys the whole architecture to a **disposable local Anvil fork of Base**, drives one complete fee-to-holder cycle through the real calculator and real keeper, and writes structured evidence. It never connects a signer to mainnet and never creates a pool, claims legacy fees, or transfers custody.

The rehearsal is an orchestration and accounting proof. It is not a deployment receipt. Read [Evidence categories](#evidence-categories) before citing any result as production readiness.

## Prerequisites

Node 18+, `npm ci`, and Foundry binaries. `FORGE_BIN` and `ANVIL_BIN` override the default `~/.foundry/bin` paths. The runner needs a Base RPC that serves the pinned fork block; `REHEARSAL_FORK_BLOCK` overrides the default 51,218,068.

```sh
npm ci
npm test
forge test
BASE_RPC_URL=https://mainnet.base.org npm run rehearse
```

Each run picks a free loopback port, starts its own Anvil with chain ID 31337, and stops that node in a `finally` block. Results land in a fresh `.context/rehearsal-run-*` directory containing `report.json`, `progress.log`, `build.log`, `calculator-config.json` and the calculator journal. Nothing is reused between runs, so a failed run's evidence stays intact.

## What one rehearsal run exercises

The fee sources, assets and swap router are mocks with fixed amounts; the Splits factory, implementation and Warehouse are the **genuine Base contracts** read through the fork. The reward token is an 8-decimal mock matching SPCXc's decimals — not native B20, which has its own fork tests.

**1. Three fee sources reach the router.** The mock Clanker locker collects 1,000 raw WETH and 1,000 raw DICKBUTT to `SplitsFeeRouter`. Both legacy Safes return their balances through `LegacyFeeHarvester` — 600 and 500 raw DICKBUTT. The router therefore holds 2,100 DICKBUTT and 1,000 WETH.

**2. Genuine Splits distribute the allocations.** `splitDickbutt()` and `splitWeth()` forward each token to its own immutable PushSplit and call `distribute`. The asserted outcome matches upstream rounding exactly:

| Token | Input | KC Green | Burn / CDB | Swap executor | Retained at Split |
| --- | ---: | ---: | ---: | ---: | ---: |
| DICKBUTT | 2,100 | 209 | 1,889 burn | — | 2 |
| WETH | 1,000 | 99 | 99 CDB | 799 | 3 |

**3. The Aerodrome position settles independently.** The mock position yields 13 DICKBUTT and 17 SPCXc. `AerodromeFeeHarvester` burns the DICKBUTT and forwards the SPCXc, so the burn address finishes at 1,902 (1,889 + 13) and the distributor receives 17 SPCXc directly.

**4. The executor swaps its whole allocation.** `processWeth` converts all 799 WETH at the mock router's 2× rate into 1,598 SPCXc paid straight to the distributor. Combined with the Aerodrome fees the rewards vault holds **1,615 raw SPCXc**. A keeper minimum, an owner price floor, the per-call cap and a deadline all apply; the executor verifies the actual distributor balance delta rather than the router's claimed output.

**5. The real calculator produces a committed plan.** Two holders qualify against the 6.9M time-weighted threshold (7M and 14M DICKBUTT) under `linear` weighting, with every contract, treasury and burn address excluded. Shares split exactly 1:2 by time-weighted balance, and unallocated raw units are booked as dust for a later period. Integer flooring, not loss.

**5b. The share cap bites.** The distributor admits at most 25% of the unreserved balance per round, so the plan commits 402 of the 1,615 and the rest rolls into the next period. The guardian then pauses proposals, the keeper refuses to propose while paused, and the guardian unpauses — all without the owner key. [Roles and bounds](GOVERNANCE.md).

**6. The real keeper delivers it.** With `--propose` the owner commits the root; the six-hour timelock is reported as `timelocked`; after the delay the round activates and pays in `batchSize: 1` batches. One recipient is deliberately blocked mid-round, producing a `payment-failed` event and `partial` status with one unpaid account. The block is lifted, a rerun pays only that account, and the round closes at `closed` — the already-paid recipient's balance is asserted unchanged.

**7. Repetition is safe.** A fourth keeper invocation submits **zero transactions**. `totalReserved` returns to 0 and a second calculator pass marks the plan `settled`.

## Evidence categories

These are distinct and must not be merged when reporting status. Results below are from the current tree.

| Category | Command | Result |
| --- | --- | --- |
| Deterministic JS units | `npm test` | 65 passed, 0 failed |
| Deterministic Solidity units | `forge test` | 85 passed, 0 failed, 4 fork suites skipped |
| Genuine protocol/state forks | `BASE_RPC_URL=… forge test` | 12 passed, 0 failed; native-only tests skipped |
| Native B20 + real route | Base Foundry, see below | 13 passed, 0 failed, 1 skipped |
| Full local rehearsal | `npm run rehearse` | success; five checks recorded |
| Read-only production preflight | `npm run preflight -- --config config/base-mainnet.json` | 2 configuration errors, all external prerequisites |

The fork suites cover the real Clanker locker and its 60% deduction, the real legacy module against both actual Safes, and the real Splits factory/implementation/Warehouse including dust, Warehouse-only balances, recipient-failure rollback and fuzzed conservation.

Native SPCXc is a **Base B20 precompile**. Ordinary Foundry cannot execute it; changing its EVM version does not add support. Use Base's compatible build and never etch a mock over the real address:

```sh
DYLD_FALLBACK_LIBRARY_PATH=.context/base-foundry/libusb/1.0.30/lib \
FOUNDRY_BASE=true BASE_NATIVE_TESTS=true \
BASE_RPC_URL=https://mainnet.base.org \
LIVE_SPCXC_HOLDER=0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E \
.context/base-foundry/forge test --match-contract "BaseForkTest|RealSwapForkTest|SplitsBaseForkTest" -vv
```

That run covers two things the mock rehearsal cannot: a **real two-hop WETH → USDC → SPCXc swap** executed through the live Slipstream router at the pinned block, and a **real SPCXc push payout** through `DickbuttRewardsDistributor` funded from a live holder. Both pass. [Base tooling](https://github.com/base/base-anvil/tree/base-anvil-fork).

`LIVE_SPCXC_HOLDER` above is the USDC/SPCXc pool, used only as a funded source inside the local fork. Any address holding SPCXc at the pinned block works.

## Swap route

The executor's path encodes **signed tick spacings, not pool addresses**, so the configured spacings must be confirmed to resolve to the intended pools. The selected route is **WETH →(spacing 1)→ USDC →(spacing 10)→ SPCXc**, hopping `0x4e392fBfE4D0557C82D2F97F02ec39daA31516dd` and `0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E`.

A direct WETH/SPCXc pool does exist at spacing 200 (`0xb0ffB2A01AbbDD54c0b227543260aa65e2b84909`, 0.3%), but it is shallow and quotes worse: at 0.1 WETH it returned about 1.4% less SPCXc than the two-hop route, and its 0.3% fee exceeds the combined 0.008% + 0.05% of the two hops. It is recorded in [config/base-mainnet.json](../config/base-mainnet.json) as the rejected alternative so it is not mistaken for a simplification. `npm run preflight` now checks both hops resolve from the factory at the configured spacings and hold active liquidity. Re-quote with `node script/inspect-route.mjs` at a finalized block before deployment; the depth comparison is a snapshot, not a guarantee.

This swap route is separate from the **rewards pool** — the 0.3% full-range DICKBUTT/SPCXc position described in [AERODROME-SETUP.md](../AERODROME-SETUP.md), which does not exist yet.

## What the rehearsal does not prove

- **No production deployment.** No contract in `src/` has a mainnet or public-testnet deployment receipt. A local fork address is not a deployment.
- **No real fee sources.** Locker, Aerodrome manager, legacy module, Safes and the swap router are mocks in the rehearsal. Their real behavior is covered only by the separate fork suites, and the real DICKBUTT/SPCXc pool has no coverage at all because it does not exist.
- **No custody change.** Locker ownership, legacy creator authority and LP NFT custody are three separate handoffs. None was performed or simulated against mainnet.
- **No governance judgement.** The distributor enforces proof membership, solvency and the round bounds, not whether a root fairly represents holders. Exclusions, thresholds and weighting stay off-chain policy. The guardian only helps if somebody is alerted and acts inside the 24-hour timelock.
- **No liveness guarantee.** The keeper processes one invocation and exits. Scheduling, gas funding, alerting and journal backup are operational work that does not exist in this repository. [Keeper behavior](KEEPER.md).

## Preparing a public-testnet rehearsal

The operating CLIs permit transaction execution only on chain **31337** or Base Sepolia **84532**; mainnet writes are rejected. Base Sepolia has no DICKBUTT, SPCXc, Clanker locker or legacy module, so a testnet rehearsal needs stand-in tokens and sources and proves orchestration only — the same limit the local run already has, at higher cost. Run it when you want a durable multi-day record with real block times and a real scheduler, not to add protocol evidence.

Deploy from reviewed manifests, then:

```sh
npm run fees -- --config deployment.json                     # read-only plan
npm run fees -- --config deployment.json --execute
npm run keeper -- --config calculator-config.json --journal ./data --execute --propose
# after the timelock, to deliver, retry and close:
npm run keeper -- --config calculator-config.json --journal ./data --execute
```

Set `RPC_URL`, `KEEPER_PRIVATE_KEY`, and `OWNER_PRIVATE_KEY` when the proposer is separate. Keep fee cycles and keeper runs sequential for a signer; both acquire a shared process lock and refuse to run against a signer with pending transactions.

## Remaining external prerequisites

Preflight reports these as errors until they are resolved. Every one needs a decision or an asset from the owner — none can be closed by code in this repository.

1. **Governance addresses.** `kcGreen` and `cdbVault` are recorded. `owner` and `keeper` are still `null` in [config/base-mainnet.json](../config/base-mainnet.json); `owner` should be a multisig.

   Both recipients are EOAs that have never sent a Base transaction, and the CDB vault is unused on Base and Ethereum with no gas on either. They become recipients of an **immutable** Split with no setter, so prove key control on Base — a signed message or a dust transaction — before deploying `SplitsFeeRouter`. Correcting a recipient afterwards means redeploying the router and re-pointing every harvester.

   `EXCLUDED_ADDRESSES` must list both, every pipeline contract and the rewards pool. KC Green already holds 1,000,000 DICKBUTT and receives 10% of all DICKBUTT fees, so without exclusion it eventually crosses the 6.9M threshold and earns holder rewards on its own fee income. The calculator rejects an empty list but cannot tell which addresses matter; [config/base-mainnet.json](../config/base-mainnet.json) records the required set under `calculatorExclusions`.
2. **The rewards pool.** Create and seed the 0.3% full-range DICKBUTT/SPCXc position, record `rewardsPool.pool` and `rewardsPool.tokenId`, then verify the real pool's fee collection. Only then can `testForkOptionalAeroCollect` stop skipping — it is the one remaining skipped fork test.
3. **Legacy creator handoff.** DICKBUTT's existing `tokenCreator` must call `updateTokenCreator`. Assignment to this adapter is **permanent**; settle the migration policy first. [Legacy authority](LEGACY-FEES.md).
4. **Locker ownership handoff.** Separate from the above and from NFT custody. Rehearse all three before performing any.
5. **Independent contract review.** [AUDITOR-BRIEF.md](../AUDITOR-BRIEF.md) lists the scope and trust assumptions.
6. **Operational plan.** Scheduler, gas funding for keeper and owner, price-floor refresh (expires within one day), monitoring on nonzero exits and unpaid recipients, and journal backup.
