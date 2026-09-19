> Historical NFT configuration. Current production candidate uses basic volatile vAMM; see ../AERODROME-SETUP.md.

# DICKBUTT/SPCXc pool setup

The selected pool is **0.3% concentrated liquidity (Slipstream), full range**, with approximately $30k initial TVL as the intended seed size. This supersedes the earlier vAMM wording and the 1% alternative. Seed roughly equal market value on each side after verifying the starting price; a wrong price is immediately arbitrageable.

This pool is the **rewards pool** that the harvester collects from. It is distinct from the swap route used to convert fee WETH into SPCXc, which is the existing two-hop **WETH → USDC → SPCXc** path through `0x4e392fBfE4D0557C82D2F97F02ec39daA31516dd` and `0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E`. The one direct WETH/SPCXc pool is too shallow to use; see [route evidence](docs/REHEARSAL.md#swap-route).

The routing goal is USDC → SPCXc → DICKBUTT. This offers aggregators an alternative to the Uniswap/WETH route. Routing still depends on executable depth, prices, total path fees and gas. More liquidity can help; the project cannot force aggregators to select the pool. The 0.3% is a swap fee on the input amount, not two simultaneous 0.3% charges.

## Verify the intended deployment

The selected current-generation manager is `0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53`; factory is `0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef`. Source: [official Slipstream deployments](https://github.com/aerodrome-finance/slipstream/blob/main/README.md).

The factory's `tickSpacingToFee(200)` returns 3000 (0.3%) at the inspected block. The configured dynamic fee module is `0x87D8f999BBa9343E8099552426775B51C338E8CB`. Pool fee settings are **not permanently fixed by tick spacing**. Check `pool.fee()` and `factory.getUnstakedFee(pool)` at a recent finalized block; review the fee module before assuming trades always execute at the base rate. The [factory source](https://github.com/aerodrome-finance/slipstream/blob/main/contracts/core/CLFactory.sol) distinguishes base, effective and unstaked fees.

At the latest inspection used for this update, `getPool(DICKBUTT, SPCXc, 200)` on this factory returned zero. That is an observation about this generation and spacing, not a claim that the pair has never existed anywhere.

## Setup sequence

Production is on **Base mainnet (8453)** with the real **DICKBUTT** token and separately selected production owner/bot wallets. Testnet keys, role addresses and mock NFT IDs must not be reused as production configuration. Reconfirm all proposed mainnet role and recipient addresses with the owner.

The NFT custody transfer can happen later. However, `positionManager` and `tokenId` are immutable in `AerodromeFeeHarvester`: the NFT ID must be known when that harvester is deployed. If the NFT has not been minted yet, prepare the other components first and deploy its harvester after the ID is known. The Aerodrome source remains inactive until it holds the configured NFT; the fee runner reports the missing custody and skips that source.

1. Confirm token addresses from [config/base-mainnet.json](config/base-mainnet.json), including SPCXc's **8 decimals**. Decide exact seed amounts and starting price from current market data.
2. Select the intended concentrated factory and 0.3% base-fee configuration. If a matching pool already exists, verify its state before depositing rather than creating a duplicate.
3. Mint a full-range position. For spacing 200, usable extreme ticks are **-887200 and 887200**. Record pool address, manager and NFT ID. Full range avoids ordinary range maintenance; it does not remove token-policy, price or liquidity risks.
4. Keep the position unstaked for the current harvester model. It collects from the NFT position manager, not an Aerodrome gauge. If a gauge introduces an unstaked fee, the economics must be reconsidered; the preflight deliberately fails this condition. Routing all of a pool's fees is not possible: the harvester receives only the managed position's share. Other LPs keep their own fees unless their positions are separately integrated.
5. Fill `rewardsPool.pool` and `rewardsPool.tokenId` in the reviewed configuration. Run `npm run preflight -- --config config/base-mainnet.json --strict`. Confirm pair, factory, effective fee, liquidity, NFT pair/spacing, full-range ticks and NFT owner.
6. Deploy `AerodromeFeeHarvester(manager, tokenId, dickbutt, spcxc, burnAddress, distributor, unlockTime, minInterval, owner)`. Verify every immutable address and lock timestamp from the deployed contract.
7. In rehearsal first, transfer the NFT using `safeTransferFrom`, verify `holdsPosition()`, generate fees, harvest and verify DICKBUTT goes to burn and SPCXc to the rewards distributor. Repeat with the actual new pool before production scaling.

The requested seed liquidity and pool creation require the owner's assets and transactions. The signed orchestration rehearsal uses a mock position. `test/NativeAeroPositionFork.t.sol` additionally creates/seeds a local position with the real manager and tokens, trades, collects and checks payouts. Neither test creates or funds a public production pool.

## Adding liquidity after handing over the NFT

The harvester manages one immutable NFT ID and has no function to add liquidity or reinvest fees. The same unstaked position can nevertheless be topped up by an external wallet through the position manager's `increaseLiquidity` function. This is a separate token-funded transaction; the contributor does not become the NFT owner or gain withdrawal or fee-collection rights.

On 2026-09-17, four local fork tests passed against the configured manager at Base block **51,223,062**, using the real DICKBUTT and native SPCXc tokens with Base Foundry v1.1.1. Two new cases each add liquidity twice after NFT handoff, including after a permanent lock. They verify contributor balances, increased position liquidity, unchanged NFT custody, rejected unauthorized fee collection and NFT transfer, and preservation of the permanent withdrawal lock. Subsequent trades, fee collection and an SPCXc holder payment still succeed, and harvesting leaves the position liquidity intact.

Added liquidity belongs to that same position and follows its withdrawal restrictions. Sending DICKBUTT or SPCXc directly to the harvester does **not** add liquidity: `harvest()` sweeps those balances to the burn address and rewards destination. Recheck the actual future pool, manager, NFT and token policy before using this path with real assets. These tests use historical state and do not create a public pool or prove the production scheduler is running.

## Custody and locks

`unlockTime` permits owner withdrawal only after expiry. `extendLock` can only extend it. `lockForever()` permanently disables withdrawal. SPCXc destination changes are timelocked and can separately be frozen. Transferring the NFT is therefore not unconditionally permanent if an expiring lock is used, but incorrectly configured or permanent locks can strand the position. Use a reviewed multisig and verify the configuration before custody moves.

The latest native staged-custody test transfers administrative ownership with acceptance, delays the NFT transfer, freezes destination and liquidity, advances past the original unlock time, confirms withdrawal still fails, then trades and harvests successfully. This is a local real-contract fork test, not a production multisig ceremony or proof of permanent uptime. [Alignment retest](docs/ALIGNMENT-RETEST-REPORT.md).
