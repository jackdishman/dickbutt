# Current test results — 13 September 2026

A detailed snapshot checked at **05:36:52 UTC on 13 September** is in [RUNNING-RESULTS.md](RUNNING-RESULTS.md), including exact wallet balances and decoded fee receipts.

This is the owner's project, tested and repaired at their request. The original supplied folders are preserved; changes are in `/Users/m4mini/Downloads/dickbutt-main/tested-project/`.

**Production deployment is not approved by these results.** The complete findings, nine fix groups, fee percentages, exact native-token amounts and remaining work are in [DEVELOPER-HANDOFF.md](DEVELOPER-HANDOFF.md). This report replaces earlier results that described the public test wallets as unfunded. They were subsequently funded and used for a fresh Base Sepolia deployment.

| Check | Verified result | Evidence under `.context/` |
| --- | --- | --- |
| Application tests | 169 passed, zero failed | `test-results/alignment-npm-final.log` |
| Full Solidity suite | 114 passed, zero failed; one optional test skipped because the production rewards NFT is absent | `test-results/alignment-forge-expanded.log` |
| Extended generated cases | Full 114-pass suite includes nine fuzz tests with 4,096 cases each; 512 invariant runs and 131,072 lifecycle calls, zero invariant reverts | `test-results/alignment-forge-expanded.log` |
| Fresh signed local wallet cycle | Passed claims, real Splits, swap, calculator, proposal, partial payout, retry, duplicate prevention, cancellation and recredit | `test-results/alignment-rehearsal.log`, `rehearsal-run-Rxoi5i/` |
| Independent payout reconstruction | Correct history accepted; an incorrect journal rejected even when its root was already proposed; wrong recipient received zero | `test-results/payout-review-fixed.json` |
| Native Base Clanker pipeline | Actual locker and legacy-module claims, genuine Splits, actual WETH → USDC → SPCXc swap and native holder transfers passed together on a local fork | `test-results/native-pipeline.log` |
| Native Aerodrome position | Real manager and router, locally created NFT, two-way trades, fee collection, DICKBUTT burn, SPCXc funding and capped payout passed | `test-results/native-aero-position.log` |
| Holder arithmetic capacity | 10,000 synthetic holders, 200,000 transfers and 10,000 verified proofs matched an independent reference | `test-results/alignment-calculator-stress.json` |
| Native transfer capacity | 256 recipient transfers and duplicate prevention passed; about 14.66 million execution gas, excluding transaction overhead. An additional 400-recipient test measured 23.23 million, exceeding Base's transaction cap | `test-results/native-batch-expanded.log` |
| Dependency check | Zero known advisories after the package updates; this does not establish absence of unknown defects | `test-results/npm-audit.json` |
| Public deployment | Fresh Base Sepolia deployment completed, with retained receipts | `../config/deployment-sepolia-new.json.receipts.json` |
| Public claims, splits and swaps | Three cycles reconciled against exact balances, including the first extended tick; retained WETH recovered after the stale-read fix | `public-sepolia/validation.json` |
| Public holder payout | **Completed at 04:00:51 UTC, 13 September**; A received 0.33599999, B 0.67199999, ineligible C zero test SPCXc. Partial failure, retry and duplicate prevention passed; reserve zero | `public-sepolia/validation.json`, `test-results/public-payout-verification.json` |
| Longer observation | **Running**, from 13 September 04:31:54 UTC to 15 September 04:31:54 UTC; normal 24-hour delay verified restored | `public-sepolia/soak.json` |

The public distributor is `0xc0524A57cdA6558357667d41b0AB1752cD83d2D6`, on chain **84532**. The public test uses genuine Splits and test stand-ins for the tokens and external fee/trading sources. Native integrations were tested separately on a local Base fork. None of the fork transfers paid public production KC, CDB or holder wallets.

After the initial public holder payout, the round had zero reserved obligations and **1.02400001 test SPCXc** available for future rounds. The first extended fee cycle then added 1.016 test SPCXc, taking the distributor to **2.04000001 test SPCXc**, with no duplicate holder payment and no monitor attention items. Before that payout, the two fee cycles left **2.03199999 test SPCXc** in the distributor. The KC test wallet received approximately **310 test DICKBUTT and 0.002 test WETH**, the CDB test wallet approximately **0.002 test WETH**, and the burn address approximately **2,800 test DICKBUTT**. Exact integer amounts and two raw units of residual dust in each Split are saved in `validation.json`; rounded figures are not the accounting assertions.

The local tests use signed disposable development wallets; fork tests also use Foundry's local state controls and time travel. The public test uses ordinary signed testnet transactions and the actual passage of time. The full Solidity suite used Base-compatible Foundry commit `98e7839c65f64aee9627b69a9b98b79afaeb1fae` and Solidity 0.8.24.

The design pays eligible holders according to their time-weighted DICKBUTT balance, subject to the 6.9-million threshold, exclusions, payout minimum and round cap. It does not pay every holder or collect every LP's fees. The target chain is **Base mainnet (8453)**; Ethereum mainnet (1) needs different integrations and configuration.

The console's HTTP/API behavior was checked locally. Automated visual inspection remains unverified: automatic approval review rejected opening its authenticated browser session because the browser connector could expose session and wallet data. This does not affect the recorded contract and CLI tests.

Read [the developer handoff](DEVELOPER-HANDOFF.md) for reproduction commands and the production prerequisites. Never include `.env`, signing keys or local private wallet files when sharing the project.

Latest follow-up: payout repeat and monitor completed successfully at **2026-09-13 06:02:02 UTC**, with no new transactions or attention items. The preceding completed monitor check was about 55 minutes earlier; this observation gap is disclosed in the complete report. The 48-hour window remains incomplete.

Latest alignment follow-up: payout repeat and monitor completed at **2026-09-13 06:51:32 UTC**, with zero new payout transactions and no attention items. The roughly 49.5-minute gap after the preceding monitor is disclosed. New tests prove staged custody, owner/keeper replacement, both actual swap hops and fee collection with permanent NFT/destination locks. F9 aligns production preflight with deployment role validation. The first native invocation omitted FOUNDRY_BASE=true and failed six tests; all six passed with native mode restored, followed by the full 114-pass run. Full details: [ALIGNMENT-RETEST-REPORT.md](ALIGNMENT-RETEST-REPORT.md).

<!-- scheduled-observation:start -->
Latest scheduled observation: **2026-09-13 16:30:43 UTC**. The keeper and monitor passed. Independent replay verified the existing two journal periods through finalized block 46,773,851. Round 1 remained closed and the execution-mode keeper submitted zero transactions. The monitor reported no attention items, an active floor, funded operating wallets and zero outstanding rewards. No additional fee cycle or proposal was due. Totals remain **four completed public fee cycles** (two extended cycles) and **one paid/closed holder round**. The last reconciled distributor balance is **3.05600001 test SPCXc**, with zero reserved obligations and zero executor WETH. The earlier **123.0-minute observation gap** between the 13:55:20 and 15:58:20 UTC checks is documented in the coverage note below, together with earlier 52.2- and 66.5-minute gaps. The 10:46 interrupted fee job and the recovery helper's later read error remain documented; their exact RPC cause is undetermined. Subsequent successful checks do not establish continuous unattended operation. The next fee/floor check remains due 13 September 16:45:10 UTC; the additional proposal remains due 17:31:54 UTC. The 48-hour observation and additional normal-delay round remain incomplete. Evidence: `.context/public-sepolia/soak-31-payout.log`, `soak-32-monitor.log`, `soak.json` and `.context/test-results/soak-1044-reviewed-recovery.json`.
<!-- scheduled-observation:end -->

## Historical-RPC interruption and recovery — 13 September 2026

At **08:27:42 UTC**, the scheduled keeper check stopped before any new transaction. Its original CLI log reported a generic RPC/signing error. A separate **keyless, read-only** diagnostic identified the cause: the endpoint `https://base-sepolia-rpc.publicnode.com` rejected historical `eth_call` requests at journal block 46,749,200, reporting that state at block 46,749,201 was pruned. The failed-job barrier correctly stopped automatic continuation. This was unavailable historical RPC state, not a reproduced fee-split, swap or payout-contract defect.

Before any recovery, the failed child was confirmed stopped; execution/journal/transaction markers were checked; the keeper's latest and pending nonces were both **25**, immediately after its previously confirmed nonce-24 swap. Thus no new keeper transaction had been submitted since that known swap. Round 1 still showed its full 100,799,998 raw reward units distributed, closed status, zero total reserved and the normal **86,400-second** delay.

The official test endpoint `https://sepolia.base.org` served the required historical block and passed a complete independent **dry-run** reconstruction of both journal periods, through finalized block 46,759,360. Its keyless monitor also passed, with no attention items, active floor, funded operating wallets and zero outstanding rewards. The extended-test runner's default RPC was changed to that endpoint; an explicit RPC override remains available. The required history checks, calculator journal, deployment addresses, fee amounts, role assignments and timelock were not changed.

Reviewed recovery was recorded at **2026-09-13 08:33:54 UTC**. Only the failed-job review barriers were cleared under the run lock. The failed job and its exact error remain in the saved history, alongside a new recovery record. **No signed job was replayed during recovery.** The next scheduled tick will use the replacement endpoint. Three public fee cycles and one paid holder round remain the totals; the 48-hour observation and additional normal-delay round are incomplete.

This is an operating/test-RPC recovery, recorded separately from the **nine source fix groups F1–F9**. The existing requirement for reliable historical-state access is now supported by an observed failure. A provider serving history now is not a guarantee that a public endpoint will retain it indefinitely or provide production reliability. Production needs historical-state availability sufficient for complete keeper replay; a missing history response must continue to stop payouts, not trigger a weaker verification mode.

Evidence: `.context/public-sepolia/soak-12-payout.log`, `soak.json`, and `.context/test-results/soak-0827-reconciliation.json`, `soak-0827-read-diagnostic.log`, `soak-0827-archive-probe.json`, `soak-0827-archive-recheck.log`, `soak-0827-archive-monitor.json`, `soak-0827-recovery.json`. Previous successful test totals remain **169 application tests and 114 Solidity tests**, with one production-NFT test skipped; these suites were not rerun for the endpoint substitution. The modified test runner passed a syntax check, and the replacement RPC was validated through the actual keyless keeper and monitor paths.

## Fourth public fee cycle: interruption, single-swap recovery and unresolved RPC cause

At **2026-09-13 10:46:02 UTC**, scheduled fee job 18 stopped after six confirmed transactions: Clanker collection, Aerodrome collection, both legacy Safe claims, DICKBUTT split and WETH split. The claim order included Clanker collection before both legacy calls. The normal floor check had passed without sending a refresh transaction. The failed job's review barrier stopped automatic continuation.

The child process was confirmed stopped. All six receipts were independently checked as successful, with keeper nonces **25 through 30**. Latest and pending keeper nonces both equalled **31**, with no pending transaction marker or active execution/journal lock. Balance reads at blocks **46,764,025** (before collection) and **46,764,038** (after the split) confirmed the exact KC, CDB and burn deltas. The executor retained **0.008 test WETH**, and the Aerodrome branch had already added **1 test SPCXc** to the distributor. The 24-hour round delay and zero reserved obligations were unchanged.

The original fee CLI retained only a generic operation error, so its exact underlying error cannot be recovered from that log. A subsequent keyless replay of the receipt-pinned balance, role, floor, interval, cap and quote reads passed. Read-only swap simulation returned **1,600,000 raw units = 0.016 test SPCXc**, and gas estimation passed. These checks supported recovery of the retained input; they do not establish the precise original failure cause.

Only the remaining swap was then signed, with explicit keeper nonce **31**, under both the extended-run lock and shared signer lock. Its hash was persisted before broadcast. No claim or split was repeated. The swap transaction **`0xc7f937afbf8835994796199b4b441b34fc7d82141c0f26c470e88d03c626bf12`** succeeded at block **46,764,169**. The recovery helper then encountered **`CALL_EXCEPTION`, action `call`, `missing revert data`** during a follow-up read, and retained its transaction marker rather than sending again.

A separate keyless verification reconciled that same hash, success receipt and `WethProcessed` event: **0.008 test WETH input**, **0.016 test SPCXc output**, **zero WETH remaining**, and **zero router allowance**. Latest and pending keeper nonces both equalled **32**. Holder balances, split dust, KC/CDB balances and burn balances matched the expected completed cycle. Six additional reads against fresh RPC blocks passed. The specific backend cause of the intermittent call failures remains undetermined; a transient RPC state-availability problem is a possibility, not a proven diagnosis. This is a remaining operational investigation, and the run cannot be described as fully unattended or error-free.

Verified amounts for this fourth public cycle:

| Destination or operation | Verified result |
| --- | --- |
| KC test recipient | +100 test DICKBUTT and +0.001 test WETH |
| CDB test recipient | +0.001 test WETH |
| Burn address | +905 test DICKBUTT; transfer to the dead address, not an ERC20 total-supply reduction |
| Remaining WETH swap | 0.008 test WETH spent; 0.016 test SPCXc received |
| Aerodrome reward contribution | +1 test SPCXc |
| Total reward-vault increase | +1.016 test SPCXc |
| Distributor balance after this cycle | 3.05600001 test SPCXc, currently unallocated |
| Reserved rewards / executor WETH / swap allowance | All zero |
| Holder A / Holder B / Holder C cumulative receipts | 0.33599999 / 0.67199999 / 0 test SPCXc; no duplicate payout |

The keeper independently reconstructed the existing two journal periods through finalized block **46,763,586**, finding round 1 closed with no transaction to send. This check concerned the existing plans; the newly collected funds have not yet been proposed for the additional round. The keyless monitor also passed with an active floor, funded operating wallets and no attention items. At **10:53:30 UTC**, the completed fee cycle and recovery evidence were recorded under exclusive locks, and only the matching reviewed barriers/marker were cleared. The failed scheduled job and the recovery helper's read error remain preserved in the evidence. No additional scheduled tick was run during recovery.

Totals are now **four completed public fee cycles**, of which **two belong to the extended observation**, and **one fully paid/closed holder round**. The normal-delay additional round remains pending its scheduled proposal; the 48-hour run still ends **15 September 04:31:54 UTC**. These results use the same test tokens and test source/router stand-ins previously disclosed, with genuine Splits; they are not production swaps or payments.

This recovery adds **no Solidity/runtime fix group** to F1–F9. The new one-use recovery helper and packaged evidence are test-harness/operating work. The saved local test totals remain **169 application tests and 114 Solidity tests passed, one optional production-NFT test skipped**; those suites were not rerun for this operating recovery. Production RPC reliability and better preservation of sanitized error diagnostics still need work. Existing production-role, custody, immutable-route and long-term operating limitations remain. **Production readiness is not established.**

Evidence: `.context/public-sepolia/soak-17-floor.log`, `soak-18-fees.log`, `soak.json`; `.context/test-results/soak-1044-reconciliation.json`, `soak-1044-swap-recovery.json`, `soak-1044-swap-recovery.log`, `soak-1044-swap-verification.json`, `soak-1044-keeper-recheck.log`, `soak-1044-monitor-recheck.json`, `soak-1044-reviewed-recovery.json`; and the one-use helper `.context/soak-1044-swap-only.mjs`. The original recovery JSON retains its interrupted status; the separate verification and reviewed-recovery records establish its final successful outcome. **Do not rerun that one-use helper or replay the completed claims.**

## Observation coverage gap — 13 September, 13:55–15:58 UTC

The tick started at 13:54 UTC did finish successfully: keeper job 27 completed at **13:55:12 UTC**, and monitor job 28 at **13:55:20 UTC**, with zero keeper transactions. Its process result was retrieved when work resumed. Follow-up prompts arrived at 14:25, 14:56 and 15:26 UTC, but no corresponding observation jobs were executed or recorded. The underlying reason for this interruption in task execution has not been established; it is not attributed to computer or app downtime without evidence.

Before resuming, the previous runner was confirmed complete, with no current error, pending job or transaction/soak/journal marker. One current tick then ran, without backfilling missed ticks. Keeper job 29 and monitor job 30 passed at **15:58:20 UTC**, leaving **123.0 minutes between successful monitor completions**. No fee collection or new proposal was scheduled during this gap, and the resumed tick sent zero transactions. Round 1 remained closed; independent historical verification and the monitor reported no new issue.

This is a real observation-coverage limitation. Later successful checks cannot establish what continuous monitoring would have reported during the gap. The recorded 48-hour end time remains **15 September 04:31:54 UTC**; elapsed time must not be presented as 48 hours of uninterrupted monitoring. The additional round and final reconciliation still need completion. No code fix or additional F1–F9 group is claimed for this gap.
