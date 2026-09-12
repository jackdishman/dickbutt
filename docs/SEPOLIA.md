# Base Sepolia deployment

`npm run deploy:sepolia` deploys the whole architecture to Base Sepolia (84532) and emits the two manifests the operating CLIs consume. It refuses any other chain, including Base mainnet.

This is where the system runs against real block times, a real scheduler and keys held on separate hosts for days at a stretch. The local rehearsal proves accounting in seconds; only a testnet deployment proves the bots survive a weekend.

## What is genuine and what is a stand-in

**Splits V2.2 is deployed on Base Sepolia at the same addresses as mainnet**, verified at deploy time — factory `0x8E8eB0cC…`, implementation `0x1e2086A7…`, Warehouse `0x8fb66F38…`. So `SplitsFeeRouter` creates **real immutable PushSplit clones** here, and the 10/90 and 10/10/80 fan-outs are the actual protocol, not a simulation.

Everything else is a stand-in, because it does not exist on Sepolia:

| Component | On Sepolia |
| --- | --- |
| Splits factory, implementation, Warehouse | **Genuine protocol** |
| DICKBUTT, SPCXc, WETH, USDC | Open-faucet mocks. Anyone can mint, so balances prove nothing about economics |
| Aerodrome router and quoter | `SepoliaSwapRouter` / `SepoliaQuoter`, fixed rate, output minted |
| Clanker locker, Aerodrome position manager | `SepoliaLocker` / `SepoliaPositionManager`, configurable fee size |
| Legacy Clanker module and Safes | Mocks from the unit-test suite |

The router and quoter share one `rate` in one file deliberately: a quoter that disagreed with the router it quotes for would make the price floor meaningless.

Fee amounts default to realistic magnitudes (0.01 WETH and 1,000 DICKBUTT per collect). This matters — the local rehearsal's 1,000-**wei** fees round a per-`1e18` swap rate to zero, so a toy-scale testnet would never exercise the price floor or slippage paths at all.

## Admin roles on the stand-ins

These contracts sit on a public chain where anyone can call them, so the parts that would let a stranger derail a rehearsal are gated to the deployer.

| Contract | Open to anyone | Deployer only |
| --- | --- | --- |
| `SepoliaToken` | `mint` — an intentional faucet | `setBlocked` |
| `SepoliaPositionManager` | `mint` | `configureFees` |
| `SepoliaLocker` | — | `setFeeAmounts` |

`SepoliaLocker` keeps `feeAdmin` **separate from `owner`**. Deployment transfers `owner` to `LockerHarvester`, and a contract cannot call `setFeeAmounts`, so gating fee size on `owner` would freeze it at the defaults permanently. `feeAdmin` stays with the deployer and is transferable with `setFeeAdmin`. Each admin role is transferable and rejects the zero address.

Minting stays open because the tokens are faucets and balances are meaningless anyway. `setBlocked` is not open, because it exists to exercise the distributor's failed-recipient and retry path — a stranger flipping it mid-run would stall payouts and look like a bug in the keeper.

## Deploy

```sh
cp config/roles-sepolia.example.json roles.json   # fill in the addresses
forge build
RPC_URL=https://sepolia.base.org DEPLOYER_PRIVATE_KEY=0x… \
  npm run deploy:sepolia -- --roles roles.json
```

Role validation runs **before the first transaction**. The keeper must be a separate key from the owner, proposer, guardian and the deploying key; the guardian may share the owner multisig. KC Green, the CDB vault and the burn address must be distinct and must not be bot keys.

The deployer needs at least 0.02 ETH. Each deployed address is written to `<manifest>.partial` as it happens, so a mid-run failure leaves a record instead of orphaning contracts nobody can find. The script refuses to overwrite an existing manifest without `--force`, for the same reason.

Two files come out:

- `deployment-sepolia.json` — addresses for `npm run fees`, `npm run floor`. Its `sources` block also records the locker, position manager and legacy Safes, which the CLIs read on-chain but an operator debugging a harvest should not have to reconstruct from transaction history.
- `deployment-sepolia-calculator.json` — the **exact** object the calculator hashes and the keeper verifies

Pass the second one straight through with `--config`. Rebuilding it from environment variables is possible but one stray value produces a journal the keeper rejects as a configuration identity mismatch.

## Operate

```sh
export RPC_URL=https://sepolia.base.org

# Ops host: set the price floor, then leave it on a schedule.
OPS_PRIVATE_KEY=0x… npm run floor -- --config deployment-sepolia.json --execute

# Keeper host: harvest, split, swap.
KEEPER_PRIVATE_KEY=0x… npm run fees -- --config deployment-sepolia.json --execute

# Calculator host: build a plan from finalized state.
CALCULATOR_DATA_DIR=./data node calculate-rewards.js --config deployment-sepolia-calculator.json

# Propose with the bot proposer key, then pay after the 24-hour timelock.
KEEPER_PRIVATE_KEY=0x… PROPOSER_PRIVATE_KEY=0x… \
  npm run keeper -- --config deployment-sepolia-calculator.json --journal ./data --execute --propose
KEEPER_PRIVATE_KEY=0x… \
  npm run keeper -- --config deployment-sepolia-calculator.json --journal ./data --execute

# Third host, no key: alerting.
npm run monitor -- --config deployment-sepolia.json --journal ./data
```

`npm run schedule` renders systemd timers or a crontab for each host; the [runbook](RUNBOOK.md) covers alert triage.

Base finalizes roughly 22 minutes behind head, and the calculator reads only finalized state, so nothing you just did appears in a plan immediately. `No new finalized period.` right after a deployment is correct, not broken. Holders need a time-weighted balance above the threshold across a full period. A freshly minted balance has a low TWAB and will not qualify until it has been held for one; a first run that reports `roundId: null` usually means exactly that, not a fault.

## Ownership stays with the deployer

The script leaves `owner` on every contract as the deploying key and prints `ownershipStillHeldBy`. Handing ownership to the multisig is a separate, deliberate step, because `Ownable2Step` needs the new owner to accept and because rehearsing the handoff is part of the point.

Until that happens the **ops/floor key must be the deployer key**, since `setPriceFloor` is owner-gated. The keeper, proposer and guardian roles are wired to the configured addresses immediately and work from the start.

## Verified end to end

A full run against a local fork of Base Sepolia (chain ID 84532, genuine Splits contracts) completed:

1. Deployed 14 contracts; `SplitsFeeRouter` created two real PushSplit clones bound to the genuine factory, zero owner
2. Floor monitor reported `expired` and exit 2; the ops key refreshed it; monitor returned `fresh` and exit 0
3. A keeper key rejected as the ops key, and a proposer key equal to the keeper key rejected
4. Fee cycle harvested all three sources, distributed both Splits and swapped — KC Green 210 DICKBUTT and 0.001 WETH, burn 1,895 DICKBUTT, CDB vault 0.001 WETH, rewards vault 1.016 SPCXc
5. Calculator produced a plan from the emitted config: 2 qualifying holders, 1:2 split, total exactly 50% of available — the round share cap
6. Proposer bot proposed; guardian paused and unpaused without the owner key; after the 24-hour timelock the keeper activated, paid and closed
7. Both holders received exactly their planned amounts
8. `setFeeAmounts` still worked after `owner` moved to the harvester, and a non-admin key was rejected from `setBlocked`

## Live deployment

The scripts have now been run against **public Base Sepolia**. Addresses are recorded in [config/deployment-sepolia.json](../config/deployment-sepolia.json); throwaway keys, nothing of value at stake.

| | |
| --- | --- |
| Deployer / owner / guardian | `0x1d179bEed174E5Eb0Fd65816797245F385C2c1F6` |
| SplitsFeeRouter | `0x7faB864aCb452A93a3857c743241C7a99d6b8dfD` |
| DICKBUTT Split (genuine PushSplit) | `0x23AB25F8d56262eAb17caA88e2f1e11d7A99eaeC` |
| WETH Split (genuine PushSplit) | `0x783f6f84CB489a243bAa9C2Ea3F2B12c534be64d` |
| SpcxcSwapExecutor | `0x6F3e354C4bF5C9AE23994d923F3441ba2c347968` |

Both Splits report `FACTORY() = 0x8E8eB0cC…` and `owner() = 0x0`, so they are real immutable clones of the genuine protocol, not stand-ins. The whole deployment cost about **0.00008 ETH**.

`roundDelay` was lowered from 24h to the contract minimum of 1h for this run so a round completes in observable time. Restore it before drawing any conclusion about mainnet timelock behaviour.

The earlier fork run proved the scripts and wiring. This one is a real public-testnet deployment receipt. [Evidence boundaries](REHEARSAL.md#evidence-categories), [roles and bounds](GOVERNANCE.md).
