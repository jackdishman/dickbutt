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

- `deployment-sepolia.json` — addresses for `npm run fees`, `npm run floor`
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
npm run floor -- --config deployment-sepolia.json --monitor
```

Holders need a time-weighted balance above the threshold across a full period. A freshly minted balance has a low TWAB and will not qualify until it has been held for one; a first run that reports `roundId: null` usually means exactly that, not a fault.

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

That was a fork, not the public testnet. It proves the scripts and wiring; it is not a Base Sepolia deployment receipt. [Evidence boundaries](REHEARSAL.md#evidence-categories), [roles and bounds](GOVERNANCE.md).
