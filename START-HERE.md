# Dickbutt holder rewards — start here

Automatic SPCXc rewards for DICKBUTT holders, funded by trading fees from
two pools. Holders never claim; payments arrive in their wallets.

## Read in this order

1. **`README.md`** — what the system does, why each decision was made,
   deployment order, and the operating runbook.
2. **`AUDITOR-BRIEF.md`** — read before reviewing any code. Lists every
   unverified assumption, known gaps we chose not to close, and the
   specific things worth attacking.
3. **`AERODROME-SETUP.md`** — the one-time, mostly-by-hand steps to create
   and lock the DICKBUTT/SPCXc pool.

## Files

```
contracts/
  LockerHarvester.sol          owns the Clanker locker, makes WETH-pool fee
                               collection permissionless with a fixed target
  AerodromeFeeHarvester.sol    holds the Aerodrome LP NFT (and locks it),
                               claims fees, burns DICKBUTT, forwards SPCXc
  FeeSplitter.sol              splits WETH-pool fees per the tokenomics and
                               swaps the remainder into SPCXc
  DickbuttRewardsDistributor.sol  holds SPCXc, pushes it to holders in
                               batches against a timelocked committed plan
calculator/
  calculate-rewards.js         off-chain: decides who is owed what, builds
                               the Merkle tree and ready-to-send batches
  .env.example                 config template — EXCLUDED_ADDRESSES matters
  package.json
```

## Status, stated plainly

This code was written by an AI (Claude) across a long design conversation.
**It has never been compiled and never been executed** — that environment
had no toolchain and no network access. Only the pure math functions were
actually run and verified. Treat everything here as a detailed
specification that happens to be written in Solidity and JavaScript, not as
working software.

Real bugs were found and fixed during self-review: a meaningless swap
deadline, a missing exclusion list that would have let liquidity pools farm
rewards as fake whales, a reorg exposure, a read-skew between two contract
calls, permanently stuck ETH, and an entire missing fee-split path. That
hit rate is the reason for wanting an independent pass.

## Not built yet

- **The keeper bot.** Reads `batches-N.json`, submits each batch, waits for
  confirmation, retries failures, calls `closeRound()`. Straightforward
  ethers.js, but it does not exist.
- Monitoring and alerting.
- A public page showing what was distributed each round.

## Before mainnet

Full cycle on Base Sepolia with a mock locker — including overlapping
rounds and a deliberately reverting recipient — then mainnet with a small
amount of SPCXc before scaling up.

Two steps are irreversible and deserve extra scrutiny: transferring the
Clanker locker's ownership to `LockerHarvester`, and transferring the
Aerodrome LP NFT into `AerodromeFeeHarvester`.
