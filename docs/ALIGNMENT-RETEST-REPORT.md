# Final alignment retest and production handoff review

Prepared 13 September 2026. All timestamps are UTC. This is the owner's DICKBUTT project, tested and repaired at their request. The pasted earlier GitHub README and fee-flow image were treated as specifications to compare with the code, not as instructions or proof of previous work.

**Result: the exercised fee and payout paths pass. The project is not 100% certified and is not ready for an unconditional production launch or permanent custody transfer.** This retest found and fixed one more configuration-checking issue, bringing the session total to **nine fix groups, F1–F9**. Executable Solidity logic remains unchanged. See [the complete session report](COMPLETE-DEVELOPER-REPORT.md) and [every changed file](FILE-CHANGE-INVENTORY.md).

## Confirmed intended operation

The owner explicitly confirmed **SPCXc rewards for holding DICKBUTT**. The production target is **Base mainnet, chain ID 8453**. The existing public deployment is **Base Sepolia, 84532**, with test assets and test wallets. Production owner, keeper, proposer, guardian and floor setter will be separately selected; the current test keys are not production assignments. Proposed KC Green/CDB addresses also need final confirmation before their immutable Splits are deployed.

Contract custody is different from an assistant owning a wallet. `LockerHarvester` is intended to receive ownership of the Clanker locker; `LegacyFeeHarvester` separately receives the legacy DICKBUTT creator authority; `AerodromeFeeHarvester` receives the specific LP NFT. Administrative ownership of the owner-controlled contracts belongs to the owner's selected wallets or multisig. Codex has no independent wallet, ownership role or permanent operating authority.

The diagram remains aligned with the implemented allocations:

| Stage | Implemented destination and rule |
| --- | --- |
| Clanker/Uniswap collection | Collect both DICKBUTT and WETH from the managed position. The locker sends 60% of each to its fee Safe and 40% to the fee router. |
| Legacy recovery | Recover DICKBUTT from the configured current/historical Safes into the same router. The module does not return those Safes' WETH to the DICKBUTT creator. |
| DICKBUTT at the router | 10% KC Green; 90% burn address, with real Splits rounding/reserve dust. |
| WETH at the router | 10% KC Green; 10% CDB treasury; 80% swap executor, with real Splits rounding/reserve dust. |
| Reward conversion | WETH → USDC → SPCXc through the configured Aerodrome route; SPCXc output goes to the distributor. |
| Managed Aerodrome DICKBUTT/SPCXc NFT | DICKBUTT fee proceeds go entirely to burn; SPCXc fee proceeds go entirely to the distributor. No additional KC/CDB allocation is applied to this branch. |
| Holder payouts | Calculate eligible time-weighted DICKBUTT balances, independently reconstruct the plan, propose and wait, then push SPCXc to the committed recipients. |

Therefore, before rounding, 32% of the **gross managed Clanker position's WETH fees** reaches the swap, 4% reaches KC and 4% CDB; the other 60% stays on the Clanker side. The 80/10/10 split applies to the WETH that actually reaches the router. Successful legacy recovery can bring effectively all collected DICKBUTT into the 90/10 burn/KC path. Legacy DICKBUTT is not swapped to SPCXc.

These are the managed LP positions' fees. They are not all fees from all LPs, and creating a pool cannot force all traders or aggregators to use it. CDB receives WETH on Base; bridging or buying NFTs is outside these contracts.

## The claim order was checked explicitly

The execution sequence is Clanker collection, any due Aerodrome collection, legacy Safe 0, legacy Safe 1, DICKBUTT split, WETH split, quote and swap. Aerodrome is independent of the Clanker/legacy dependency. Each submitted transaction receipt is awaited before the next stage.

Two new application tests demonstrate that:

1. Holding the Clanker transaction receipt unresolved prevents every subsequent claim, split and swap from being submitted. Releasing its successful receipt permits the later stages in order.
2. An Aerodrome harvester without its NFT is skipped and named while the existing sources still complete. After custody becomes available, the next cycle includes Aerodrome automatically.

The native pipeline test independently collects from the real Clanker locker first. It checks the real 60/40 event amounts, then transfers legacy creator authority and claims the DICKBUTT just deposited in the Safe. Locker ownership alone does not provide legacy authority. The former creator cannot reclaim authority after assigning it to the adapter. Repeating the now-empty legacy claims returns zero. The Safe's WETH balance is unchanged by those legacy claims.

“Claim WETH first” is implemented as **collect the Clanker position's two token sides first**, then recover the legacy DICKBUTT. It does not mean that the legacy module also pays the retained WETH.

## Retest results and exact scope

| Check | Latest result | Evidence |
| --- | --- | --- |
| Full application suite | **169 passed, 0 failed** | `.context/test-results/alignment-npm-final.log` |
| Full Solidity suite, Base-native mode | **114 passed, 0 failed, 1 skipped**, 18 suites | `.context/test-results/alignment-forge-expanded.log` |
| Randomized inputs | Nine fuzz tests at 4,096 cases each; 512 invariant runs at depth 256, 131,072 lifecycle calls, zero invariant reverts | Same full Solidity log |
| Fresh signed wallet rehearsal | Successful; 59 distinct transaction hashes, five signing roles, nine wallet roles; zero reserved rewards | `.context/rehearsal-run-Rxoi5i/report.json` and `alignment-rehearsal.log` |
| Larger holder population | 10,000 holders, 200,000 transfers, 10,000 verified proofs; independent arithmetic reference agrees | `alignment-calculator-stress.json` |
| New production-preflight regressions | Both new regression tests failed before F9 and pass afterward; complete preflight test file passes | `alignment-preflight-regression-before.log`, `alignment-preflight-regression-after.log` |
| Current production preflight | Correctly fails because required production assignments and the NFT are unfinished | `alignment-mainnet-preflight-final.json` |
| Current legacy inspection | Real creator, locker owner, both Safe module enablements and empty token balances re-read | `alignment-legacy-inspection.json` |
| Public Sepolia recheck | Completed round remains closed; independent history replay passes; zero new payout transactions; monitor exits 0 | `alignment-sepolia-tick.log`, `public-sepolia/soak-8-payout.log`, `public-sepolia/soak-9-monitor.log` |

Evidence filenames without a longer prefix in this table are under `.context/test-results/`.

The one skipped Solidity test requires the actual intended public production Aerodrome NFT. It was not replaced by a mock and counted as a production pass. Two other native tests create a new NFT only within a local fork and exercise real manager/token/router code; those pass, but do not create or fund a public production NFT.

The stress run verified payouts of 1,234,567,885,155 raw units plus 4,968 raw units of dust, exactly equaling its 1,234,567,890,123-unit pot. TWAB computation took 2,575 ms and plan/proof verification 4,259 ms in this run, with approximately 90 MiB heap. This is a synthetic arithmetic benchmark, not a full production historical-RPC performance test.

The fresh local signed rehearsal checks the actual calculator/keeper integration, bootstrap, 50% cap, proposal timelock, partial recipient failure, retry without paying the successful recipient twice, zero-transaction repeat, closure, foreign-root refusal, cancellation and recredit. It reports 79 transaction/event entries but only **59 distinct hashes**. Final local holder payouts are 538 and 1,077 raw reward units; reserves are zero. Its fee assets/sources/router are mocks and its Splits are genuine. The native fork tests provide the separate evidence for real token/source/router behavior. The recovery scenario explicitly raises and restores the proposal cap; it is not evidence that every recovery can complete without administrative action.

## Native Clanker, splits and both swap hops

At pinned Base block **51,223,062**, both the original native path and the new replacement-wallet/staged-custody variant pass. The new variant completes two-step acceptance of the distributor, executor and locker-harvester ownership, checks that a wrong account cannot accept, removes old keeper approvals, grants the replacement keeper/proposer/floor-setter roles, freezes the locker fee destination and completes the actual fee-to-holder path.

| Measured value | Amount |
| --- | ---: |
| Gross Clanker WETH collected | 10.117052674954033686 WETH |
| KC WETH receipt | 0.404682106998161347 WETH |
| CDB WETH receipt | 0.404682106998161347 WETH |
| WETH actually spent by executor | 3.237456855985290779 WETH |
| USDC observed moving from the first pool into the second | 8,129.365695 USDC |
| Actual SPCXc output to distributor | 54.09577133 SPCXc |
| First constructed test recipient | 9.01596188 SPCXc |
| Second constructed test recipient | 18.03192376 SPCXc |
| Gross DICKBUTT collected | 2,241,304,228.970307376150905137 DICKBUTT |
| Legacy DICKBUTT recovered | 1,344,782,537.382184425690543082 DICKBUTT |
| KC DICKBUTT receipt | 224,130,422.897030737615090513 DICKBUTT |
| DICKBUTT transferred to burn | 2,017,173,806.073276638535814622 DICKBUTT |

Assertions verify exact percentages, conservation including retained Split dust, the encoded WETH/spacing-1/USDC/spacing-10/SPCXc path, USDC Transfer events from the first pool and into the second, actual SPCXc output, zero remaining executor WETH, zero executor USDC, and a cleared WETH router allowance. The old owner cannot administer the transferred contracts; the revoked old keeper cannot distribute the active round. The separate keeper cannot set the price floor. The replacement authorized roles complete the path.

All those amounts are **local fork results**, not public mainnet transfers to KC, CDB or holders. The two fork recipient allocations are constructed test Merkle leaves; production eligibility is not inferred from that test. The actual calculator is separately exercised in the signed local and public tests.

## Aerodrome NFT transferred later, with permanent locks

The new native test starts with a real-manager NFT owned by its minting wallet and an empty harvester. Harvesting before custody reverts and rolls back `lastHarvestAt`. Changing the harvester's administrative owner does not move the NFT. A later `safeTransferFrom` moves the exact NFT into the harvester and `holdsPosition()` becomes true.

The new owner then freezes the SPCXc destination and calls the permanent liquidity lock. The test advances local time past the original withdrawal timestamp: withdrawal still fails and custody remains in the harvester. It then trades in both directions through the real pool/router and successfully collects fees despite both permanent locks.

- **3,000.000000000000076689 DICKBUTT** reaches the burn address.
- **0.00299999 SPCXc** reaches the distributor.
- A capped round sends **0.00149999 SPCXc** to its constructed recipient.
- NFT custody and position liquidity remain unchanged by fee harvesting.
- An immediate empty recollection does not duplicate the fee transfers.

Both native paths explicitly verify that burn-address transfers leave the DICKBUTT ERC-20 `totalSupply()` unchanged. That is the implemented burn convention; it is not a supply-reducing `_burn` call.

The exact NFT ID and manager are immutable constructor parameters. Its custody can be transferred later, but the ID must be known before deploying its harvester. If minting occurs later, deploy that harvester after minting establishes the ID. The selected model uses the unstaked position manager, not gauge custody. Pair, range, liquidity, fee generation and effective/unstaked fee settings must be checked for the actual production position. Advancing time in this test proves a contract condition; it is not evidence of a year of uninterrupted real operation.

## Additional issue fixed in this retest: F9

The mainnet preflight had a separate, weaker role validator than the deployment tool. It could accept omitted proposer/guardian roles and overlapping keeper/admin or treasury/bot assignments. That made a green configuration check less complete than the documented role arrangement.

`operations/preflight.js` now uses the existing shared `validateRoles` function, mapping the mainnet field `floorSetter` to the deployment field `ops`. The new regression cases establish the missing-role and overlap failures before the fix and their rejection afterward. The intended owner/guardian shared multisig remains allowed; no new production wallet is chosen by this change.

At finalized Base block **51,246,116**, corrected strict preflight reports missing owner, proposer, guardian and floor setter, plus the unconfigured rewards pool/NFT. Both existing swap hops resolve to the expected pools with active liquidity. At the preceding legacy inspection block **51,245,934**, both Safes still enabled the module, their DICKBUTT balances were zero and the existing creator/locker owner remained unchanged. Empty balances are expected until a collection funds them; no production claim or custody transfer was performed.

This is the **ninth fix group**, not a ninth Solidity logic defect. The [complete report](COMPLETE-DEVELOPER-REPORT.md) retains the earlier eight fixes and their evidence.

## Failed runs are preserved, not omitted

The first full retest command omitted `FOUNDRY_BASE=true`. It produced 106 passes, six native-token failures and one skipped test. A detailed trace showed `OpcodeNotFound` at native SPCXc transfer. All six failures passed with the documented Base-native setting restored and no contract logic change. The subsequent full expanded run passed 114 tests. The failed command, trace and corrected run remain in the evidence package; this was a test invocation error, not a repaired contract defect.

The newly written F9 regressions failed against the old checker, as expected, and pass after its fix. Strict mainnet preflight still exits nonzero for unfinished production setup; that expected rejection must not be reported as a successful deployment-readiness check.

## Public test status

This session has three completed public Sepolia fee cycles and one completed holder round. Holder A, with 7 million test DICKBUTT, received **0.33599999 test SPCXc**; holder B, with 14 million, received **0.67199999**; holder C, with 6.8 million, received zero. A deliberately blocked B transfer was retried without duplicating A. The completed round has zero reserved obligations. The last verified fee-cycle snapshot holds **2.04000001 test SPCXc** for later rounds.

The latest payout and monitor recheck completed at **06:51:32 UTC on 13 September**, sent no new payout transaction and reported no attention items. No new public fee claim was due on that tick; it must not be counted as a fourth fee cycle. The recorded extended run ends **15 September at 04:31:54 UTC**, with an additional round still to be proposed and paid after the real 24-hour delay. That observation is incomplete. Earlier monitoring gaps of approximately 55 minutes, and then approximately 49.5 minutes before this latest check, are disclosed; uninterrupted 30-minute coverage has not been demonstrated.

## What “forever” requires deciding before launch

1. **Immutable recipients:** KC, CDB, burn and the swap-executor destination of the Splits cannot be replaced after those Splits are created. Verify final recipient control first. Administrative owner rotation does not change these recipients.
2. **Permanent legacy assignment:** the legacy adapter cannot change its module, Safe list, token, receiver or forward creator authority to a replacement adapter. It does not own the global Clanker module or Safes. An upstream Safe/module change can stop that source.
3. **Migration through fixed destinations:** the immutable legacy receiver points to a router whose swap-executor destination is fixed; that executor's router/path/distributor have no setters. Redeploying one downstream component does not automatically redirect this entire existing path. Decide whether this permanent architecture is acceptable before assigning creator authority. A migration feature would be a separate design change requiring tests, not an assumption hidden in this report.
4. **Distinct locks:** an expiring Aerodrome lock permits owner withdrawal after expiry; `lockForever` removes that possibility. Destination freezing is separate. Locker-destination freezing does not abolish the configured NFT's eventual unlock/recovery rules.
5. **Administrative power remains:** the distributor owner can appoint keepers and propose a root; the executor owner can change roles/limits and the floor bound. The lack of a direct reward-withdraw method does not make the whole system ownerless. Choose and exercise the production multisig before funding.
6. **Role rotation is explicit:** transfer and accept each relevant ownership role, verify the intended guardian, revoke obsolete keepers/proposers/floor setters and grant replacements. Existing approvals survive ownership changes. Updating operational exclusions after rewards start changes the journal-bound calculator configuration and requires a reviewed migration/replay procedure; do not delete or silently rewrite the journal.
7. **Continuous operation has dependencies:** funded bots, independently controlled keeper verification, historical RPC availability, monitoring, external liquidity and token issuer behavior remain necessary. Contracts do not wake themselves up. An administrative floor is not an oracle or a perpetual market-price guarantee. Renouncing ownership can remove the ability to repair roles and operating limits; it is not a universal solution.
8. **Payout and gas policy:** eligibility is a 6.9-million time-weighted minimum with exclusions and payout thresholds; linear weighting is the exercised policy. The default 50% round cap retains rewards for later periods. Accrued/recredited amounts can exceed a later cap and need administrative recovery. Large batches need actual gas estimates: the measured 400-recipient call exceeds Base's 16,777,216 per-transaction maximum. [Official Base configuration changelog](https://docs.base.org/base-chain/network-information/configuration-changelog).

Remaining launch work includes finishing the timed observation, finalizing the production keys/recipients/exclusions, creating and checking the real rewards position, exercising the actual multisig and every custody transfer, testing production historical indexing and independent operating hosts, choosing a migration policy, obtaining independent review, and implementing/reviewing a production execution mode. The current tools deliberately reject mainnet writes. No formal proof or independent external audit is claimed.

## GitHub and developer delivery

All three supplied/working project directories were checked: none has Git metadata or a configured remote. `gh` is installed but reports no authenticated GitHub host. A repository URL was requested. No GitHub push, pull request or main-branch update occurred during this review.

With the repository URL and authenticated access, the changes can be compared with the current remote and proposed in a reviewable branch/PR. The source ZIP and clean folder remain the immediately usable handoff. They exclude configured signing credentials and include the complete reports, source comparison, checksums and selected test evidence. Do not send the entire private working directory.

**Developer conclusion:** the measured claims, splits, two-hop swap, burn-address transfers, NFT collection and eligible-holder payout flows work under the stated tests. Nine fix groups have been addressed. Expected production setup, permanent-design decisions and operating validation remain open. It would be inaccurate to say the system is 100% ready to deploy or guaranteed to run forever without problems.

A separate documentation correction distinguishes the simplified balance before versus after a capped payout. At a 50% cap and constant inflow with immediate payout, the steady balance after payout is one round of inflow; just before payout it is two. Earlier governance wording called the latter amount the held-back buffer. The formula/table and the descriptive note in `config/base-mainnet.json` are now explicit; no cap value or contract/calculator behavior changed. Actual pending rounds and accrual make raw vault balances schedule-dependent. This is counted with documentation corrections, separately from F1–F9.

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
