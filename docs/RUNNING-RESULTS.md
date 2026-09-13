# Detailed running results

This page preserves the earlier balance/test snapshot. The later [alignment retest](ALIGNMENT-RETEST-REPORT.md) raises the current total to nine fix groups and records 169 application passes and 114 Solidity passes with one skip. Its latest public monitor completed 06:51:32 UTC; no fourth fee cycle is claimed.

Snapshot checked at **13 September 2026, 05:36:52 UTC**, using finalized Base Sepolia block **46,754,244**. The separate current monitor also returned **ok**, with no attention items. This is the owner's project and uses the existing authorized test deployment, chain **84532**.

**Current result:** three public fee cycles and one holder round have passed. The 48-hour observation is still running. These results do not establish zero possible errors or production readiness.

## Public fee flow: the latest completed cycle

These are test-token amounts decoded from the actual public receipts. Sepolia uses test stand-ins for fee sources, tokens and trading infrastructure, with genuine Splits. Tests against real external contracts are described separately below.

| Operation | Observed result |
| --- | --- |
| Test locker collection | 1,000 DICKBUTT and 0.01 WETH delivered to the fee router |
| Two legacy Safe claims | Both confirmed. No remaining DICKBUTT in these Safes during this cycle; the first public cycle exercised nonzero historical balances |
| DICKBUTT Split | 100 DICKBUTT to KC test wallet; 900 DICKBUTT to burn |
| WETH Split | 0.001 WETH each to KC and CDB test wallets; 0.008 WETH to swap executor |
| Test swap | Executor spent 0.008 WETH; distributor received 0.016 SPCXc |
| Test Aerodrome collection | 5 DICKBUTT sent to burn; 1 SPCXc sent to distributor |
| Total cycle | 100 DICKBUTT plus 0.001 WETH to KC; 0.001 WETH to CDB; 905 DICKBUTT burned; 1.016 SPCXc added to distributor |

All seven transaction receipts succeeded. The executor retained zero WETH after the swap. The two legacy claims being empty in this cycle is expected and is not evidence of an additional positive fee harvest.

- [locker receipt](https://sepolia.basescan.org/tx/0xabb56c28a2951cea3fc2712af9d33584d4167535a735ef1c61aa73a4a141a823) — block 46,752,829, successful.
- [aero receipt](https://sepolia.basescan.org/tx/0xfab287086737a8bea51a80832d0f00f1a68ade3d4b081c386253230c5ef15e7d) — block 46,752,834, successful.
- [legacy0 receipt](https://sepolia.basescan.org/tx/0xa92e97930a263060c74fbf5f19638cc6159d9f352df047ebe09000cccd1958b3) — block 46,752,838, successful.
- [legacy1 receipt](https://sepolia.basescan.org/tx/0x380c207d31058da8a87c7facfea6eee130cff2eddf832dd84fa476ff2f0ce20d) — block 46,752,842, successful.
- [split-dickbutt receipt](https://sepolia.basescan.org/tx/0xf4f6592d7c9aa771ada1d5997ebdd0d1b409047d90a903ff747b3c6ad0f14519) — block 46,752,846, successful.
- [split-weth receipt](https://sepolia.basescan.org/tx/0x7d0810a1ddd097e3be6be46630d434e773ba8683f757f8c6a43e899ecc9d2a83) — block 46,752,850, successful.
- [swap receipt](https://sepolia.basescan.org/tx/0x63dd68f818cd72235d0df9b44c3f5edd343bdbca5d1562bd096518f041660e19) — block 46,752,855, successful.

## Cumulative public test balances

The following balances include all three fee cycles and the completed holder round. DICKBUTT and WETH have 18 decimals; SPCXc has 8. Exact values retain protocol rounding.

| Recipient | DICKBUTT | WETH | SPCXc |
| --- | ---: | ---: | ---: |
| KC test wallet | 409.999999999999999999 | 0.002999999999999999 | 0.0 |
| CDB test wallet | 0.0 | 0.002999999999999999 | 0.0 |
| Burn address | 3704.999999999999999999 | 0.0 | 0.0 |
| Rewards distributor | 0.0 | 0.0 | 2.04000001 |
| Swap executor | 0.0 | 0.0 | 0.0 |
| DICKBUTT Split residual | 0.000000000000000002 | 0.0 | 0.0 |
| WETH Split residual | 0.0 | 0.000000000000000002 | 0.0 |

The cumulative reward accounting reconciles exactly:

**3.04799999 SPCXc received = 1.00799998 paid to holders + 2.04000001 still in the distributor.**

The distributor has **zero reserved obligations** from the closed round. Its remaining SPCXc is available for future rounds, subject to the round cap and calculator rules. The two raw units left in each Split are accounted-for reserve/rounding amounts.

These are KC/CDB **test wallets**, not production wallets:

- kc: `0x80e00D628CbE20377695fe43E9d959597adFFe1B`
- cdb: `0xFee59016beD7dB11f56e5530863DCd0b2021bbF8`
- distributor: `0xc0524A57cdA6558357667d41b0AB1752cD83d2D6`

## Holder payout

| Holder | DICKBUTT held throughout the tested period | SPCXc actually received |
| --- | ---: | ---: |
| A | 7,000,000 | 0.33599999 |
| B | 14,000,000 | 0.67199999 |
| C | 6,800,000 | 0 |

The A/B amounts follow the expected 1:2 weighting, within one smallest SPCXc unit of integer rounding. C is below the configured 6.9-million threshold and was correctly excluded.

The public round used an initial **one-hour test timelock**. After the real wait, A was paid while an intentionally blocked B transfer failed. B was then unblocked and paid on retry; A was not paid twice. Repeating the job after closure submitted zero transactions. The round closed at **04:00:51 UTC on 13 September**. The normal **24-hour delay has been restored and verified**; the extended run will test another round with that delay.

Evidence: [initial payout](https://sepolia.basescan.org/tx/0x9865c455773be20e8fd0316a56d776430e9acd67cd8c338a2126766f3b28842a), [B retry](https://sepolia.basescan.org/tx/0xaa0f924a18428b46cce2eb143237a4bda9066df8aac0b3afc8465bc0ba3f6721), [closure](https://sepolia.basescan.org/tx/0x5ce2c7128767d5a41dbda0171f3c65979626fbca0326c6769aba1c248c1d9968).

The system pays according to time-weighted holdings, exclusions, the payout minimum and the round cap. It does not pay every holder. Transfers during a period affect the average. Current default weighting is linear; the default proposal cap is 50% of available rewards.

## Real external-contract tests on a local Base fork

A separate end-to-end test used the real Clanker locker, real legacy module, genuine Splits, actual swap route and native SPCXc. It collected **10.117052674954033686 WETH gross**, paid **0.404682106998161347 WETH each** to the configured KC and CDB addresses on the fork, swapped **3.237456855985290779 WETH** through **WETH → USDC → SPCXc**, and received **54.09577133 SPCXc**. A capped round then paid **9.01596188** and **18.03192376 SPCXc** to two fork recipients.

The real Clanker locker sends 60% of both tokens to its fee Safe and 40% to your router. The router's WETH split is 80% swap / 10% KC / 10% CDB. Therefore only **32% of gross managed-position WETH** reaches the rewards swap, while 4% goes to KC and 4% to CDB. The legacy adapter returns DICKBUTT, not WETH, from its configured Safes. That combined router DICKBUTT is split 10% KC / 90% burn.

Another fork test created a DICKBUTT/SPCXc position with the real Aerodrome manager, traded both ways, collected fees, checked NFT custody and unchanged liquidity, burned **3,000.000000000000076689 DICKBUTT**, and sent **0.00299999 SPCXc** to the distributor. A capped holder payment of **0.00149999 SPCXc** passed. Empty recollection did not pay twice. This was a locally created NFT; the intended public production position is still absent.

Fork transactions change local state only. They did not send production KC/CDB wallets real public funds. Fee collection covers the configured LP positions, not all fees from every LP or all DICKBUTT trading volume.

## Executed test coverage

| Check | Result |
| --- | --- |
| Application suite | 165 passed, 0 failed |
| Full Solidity suite | 112 passed, 0 failed, 1 optional production-NFT test skipped |
| Extended Solidity testing | 94 tests passed; 4,096 cases per fuzz test |
| Reservation/lifecycle invariant | 512 runs, 131,072 calls, zero invariant reverts |
| Synthetic holder calculation | 10,000 holders, 200,000 transfers, 10,000 verified proofs; independent reference matched |
| Native SPCXc batch | 256 recipients paid, repeat did not duplicate |
| Oversized native batch | 400 recipients needed 23,234,654 execution gas, exceeding Base's 16,777,216 transaction cap; former guidance corrected |
| Current public monitor | Active floor, funded gas wallets, proposals enabled, zero outstanding rewards, no attention items |

The 10,000-holder test measures synthetic arithmetic and proof generation, not full production RPC indexing speed. The public configuration uses batches of 50. The native 256-recipient batch used about 14.66 million execution gas before transaction overhead, so production batch sizes need measured margins.

## Fixes and remaining work

The first **seven groups** were: pending-plan calculator recovery; isolated handling of an unavailable legacy Safe; corrected Splits test fixture; dependency updates; resumable deployment; receipt-pinned reads to prevent skipped swaps; and independent reconstruction of holder payouts. The final console selection fix brings the count to **eight groups**. Solidity contract logic is unchanged. The additional batch-size comment correction and improvements to the new testing scripts are listed separately in [DEVELOPER-HANDOFF.md](DEVELOPER-HANDOFF.md).

Earlier runs encountered actual defects and public RPC timeouts; they were repaired or reconciled before continuing. The present extended-run state has no active error. This does not mean every possible error has been ruled out.

Production still needs the intended pool/NFT and verified recipient/role configuration, custody and multisig handoffs, review of the owner's broad authority, independent keeper operations, reliable archive RPC and production-scale history replay, and the completed long-duration test. The target is Base mainnet (8453), not Ethereum mainnet (1).

## Remaining schedule

- Observation started: **13 September 2026, 04:31:54 UTC**.
- Next fee cycle due at or after: **13 September 2026, 10:31:54 UTC**.
- Additional proposal due at or after: **13 September 2026, 17:31:54 UTC**; its real 24-hour delay follows the actual proposal.
- Recorded observation ends: **15 September 2026, 04:31:54 UTC**.

Checks run about every 30 minutes. The next proposal has not been submitted yet. At the end, its round must be closed, holder receipts must match cumulative plans, and reserved obligations must be zero. The Mac must remain on with Codex running; any missed observation will be reported. The 48-hour test is not complete.
