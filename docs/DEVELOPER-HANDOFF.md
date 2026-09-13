# Developer handoff — testing and fixes

A detailed snapshot checked at **05:36:52 UTC on 13 September** is in [RUNNING-RESULTS.md](RUNNING-RESULTS.md), including exact wallet balances and decoded fee receipts.

Updated 13 September 2026. Full history and all limitations: [COMPLETE-DEVELOPER-REPORT.md](COMPLETE-DEVELOPER-REPORT.md). This is the owner's project, being tested and repaired at their request. Changes are in `tested-project/`, a separate copy of the supplied `dickbutt-main 2` folder. The original folders were preserved.

**Production deployment intent:** the real system will be deployed on **Base mainnet (chain ID 8453)**, using the real **DICKBUTT** token and separately selected production owner, keeper, proposer, guardian and floor-setter wallets. Public Base Sepolia addresses and signing keys are test-only; they are not the production role assignments. Any addresses already recorded in `config/base-mainnet.json` must be reconfirmed with the owner before launch. Final KC Green/CDB recipients must be verified before the immutable Splits are created. Update the production manifests, calculator exclusions and bot configuration together when selecting the production addresses.

**Staged Aerodrome handoff:** the production DICKBUTT/SPCXc LP NFT can be transferred to its harvester after deployment. The harvester's manager and NFT ID are immutable constructor arguments, so the exact NFT ID must be known before deploying that harvester. If the NFT will be minted later, deploy that harvester only after minting establishes the ID; other components may be prepared earlier. Verify the actual position and lock settings, transfer that exact NFT with `safeTransferFrom`, confirm `holdsPosition()`, and exercise its real fee collection before enabling its scheduled harvesting. Until custody is transferred, that source is not active and the fee runner reports it as skipped. See [the staged setup sequence](../AERODROME-SETUP.md). These production actions have not been performed by the test runs.

**Release decision: not ready for production.** The verified paths work in the tests described below. The initial public holder payment passed. The extended run must finish, and the production configuration and operating decisions below remain open. No test can certify zero possible future errors.

## Nine fix groups

This count groups related changes by their underlying problem. It does not count every edited line, dependency advisory, added test, or user-interface improvement as a separate bug. Solidity contract logic in `src/` has not been changed.

| ID | Problem and effect | Change | Evidence |
| --- | --- | --- | --- |
| F1 | After a rate-limited proposal, an uncommitted local plan made subsequent calculator runs fail, preventing the scheduled proposal step from recovering. | Return the existing pending plan without accruing the period twice. | `calculator/engine.js`, `calculate-rewards.js`; regression failed before the fix and passed afterward. |
| F2 | One legacy Safe's estimation revert stopped all remaining fee sources and the split/swap cycle. | Skip and report only a definite pre-broadcast estimation revert; continue the other Safe and downstream actions. Unknown send outcomes and failed receipts remain fatal. CLI returns attention status for the skipped claim. | `operations/fees.js`, `script/run-fees.mjs`, nine original fee-operation tests plus the F6 regression. |
| F3 | The real-Splits fork fixture supplied an EOA where the executor constructor requires a contract distributor. The normally skipped suite failed when enabled. | Deploy an actual distributor in the fixture. | `test/SplitsBaseFork.t.sol`; eight genuine-Splits fork tests pass. This was a test fixture problem. |
| F4 | The dependency tree contained known package advisories. | Pin ethers 6.17.0 and Merkle Tree 1.0.8; use a scoped UUID 11.1.1 override. | Zero known advisories in the saved npm audit; Merkle golden vectors and wallet tests pass. This does not assess Solidity or eliminate unknown package defects. |
| F5 | A partial public deployment could not be resumed and did not persist every deployed component or transaction. Restarting could duplicate contracts. | Add explicit `--resume`, deployment/argument identity, transaction records, completed configuration steps, retained receipt evidence, and a guard against accidentally starting over a partial deployment. Wait for deployed code to become readable. | The first eight deployments and later Splits deployment were recovered without duplication; the full public deployment completed. See `config/deployment-sepolia-new.json.receipts.json`. |
| F6 | A confirmed WETH split was followed by an older `latest` RPC response. The runner incorrectly reported an empty executor and skipped the swap. | Pin dependent balance, limit, role and quote reads to the confirmed split receipt's block. | Reproduced on public Base Sepolia; regression fails before and passes after the fix. The retained WETH was subsequently swapped, and a second cycle's split and swap completed with the fix. |
| F7 | The keeper checked that a payout journal was internally consistent, but did not independently derive holder eligibility and amounts from blockchain history. A consistently rewritten journal could pay a wallet with no DICKBUTT. | Independently rebuild every period from historical chain data and a separately reviewed configuration before proposal or payout. Reject any mismatch and any period beyond the selected finality boundary. | Local reproduction paid 5,000 raw units to a wallet with zero DICKBUTT before the fix. Afterward, the valid journal passed, the incorrect journal was rejected even after direct on-chain proposal, no keeper transaction was sent, and the wrong wallet received zero. The complete legitimate wallet rehearsal also passes. |
| F8 | The console still displayed the historical Sepolia manifest and used its calculator/journal defaults while current testing used a new deployment. | Add one explicit `config/console-deployment.json` selection shared by state, displayed forms and resolved commands; reject invalid paths and retain an explicit fallback for installations without a selector. | Three new regression tests pass; application suite at F8 was 165/165; the latest suite passes 169/169. No transaction was sent by this change. |
| F9 | Production preflight omitted proposer/guardian and missed keeper/admin or treasury/bot role conflicts. | Reuse deployment role validation with the floorSetter/ops field mapping. | Two new regressions failed before the fix and pass afterward; full application suite 169/169. Fresh strict preflight lists all four missing production roles and the pending NFT. |

Additional development improvements, excluded from the nine-group count: bounded reusable RPC connections with optional IPv4-only transport; retaining sufficient Anvil history for replay tests; persistent local rehearsal and wallet display; a read-only wallet checker; resumable public validation, larger-holder tests, and the extended test runner. The initial replay failure late in the local rehearsal was resolved by retaining its historical states; this is a local-node test configuration requirement.

## What the fee flow actually means

1. **Clanker/Uniswap position:** collect both DICKBUTT and WETH from the configured locked NFT. The real locker deducts 60% of each token to its fee Safe and sends 40% to the fee router.
2. **Legacy claim:** the configured legacy creator role can claim DICKBUTT from the listed Safes into the same router. It does not claim their WETH. Existing historical Safe balances are included when present. A disabled module prevents that Safe's claim and must be reported.
3. **DICKBUTT split:** the router sends its combined DICKBUTT to a genuine immutable PushSplit: 10% KC Green and 90% burn, subject to the protocol's raw-unit reserve and rounding.
4. **WETH split:** the router's received WETH is split 10% KC Green, 10% CDB, and 80% swap executor. Therefore, before rounding, only **32% of the gross WETH collected by the managed Clanker NFT** reaches the reward swap; 4% goes to KC, 4% to CDB, and 60% remains on the Clanker side.
5. **Swap:** the executor spends the WETH allocation through WETH → USDC → SPCXc. SPCXc goes directly to the rewards distributor. Tests check actual input spent, actual output received, the minimum output, and cleared token allowance.
6. **Aerodrome position:** the configured DICKBUTT/SPCXc NFT collects both fee tokens. Its DICKBUTT fees go entirely to burn; its SPCXc fees go entirely to the rewards distributor. KC and CDB do not receive an additional cut from this branch under the current design.
7. **Holder payments:** the off-chain calculator derives time-weighted balances and a Merkle plan. The keeper now independently recalculates that history. After proposal and the timelock, it pushes SPCXc to the planned recipients. A failed recipient remains unpaid for retry; successful recipients are not paid twice.

This collects the fees earned by the **specific managed LP positions**. It does not collect all fees from every LP or guarantee that all DICKBUTT trading volume chooses these pools. Legacy DICKBUTT is split/burned; it is not converted into SPCXc.

The current eligibility threshold is a **6.9 million DICKBUTT time-weighted balance**, with configured exclusions and payout minimums. Small holders do not qualify. Linear weighting gives twice the reward weight for twice the qualifying balance, before integer rounding. The default 50% proposal cap retains part of the available pot for later rounds. Finality can also leave recently collected income for a later period. Thus 'every holder immediately receives all trading fees' is not the implemented behavior.

## Executed evidence

- Application suite: **169 passed**, zero failed (`.context/test-results/alignment-npm-final.log`).
- Full Solidity suite: **114 passed**, zero failed, one optional production-NFT test skipped (`alignment-forge-expanded.log`). The gas measurements are recorded in `native-batch-expanded.log`.
- Extended local Solidity run: **94 passed**, zero failed; **4,096 cases per fuzz test** and **512 invariant runs, 131,072 lifecycle calls**, zero invariant reverts (`extended-fuzz-invariants.log`).
- Complete signed local wallet rehearsal passed after independent history verification, including partial transfer failure, retry, duplicate prevention, foreign-root handling, cancellation and recredit (`rehearsal-rerun-3.log`). It uses real Splits with mock assets and sources.
- Synthetic calculator capacity test: **10,000 holders, 200,000 transfers, 10,000 verified proofs**, 200 batches. TWAB and ending balances match a separate time-integral reference; shares plus rounding equal the pot (`calculator-stress.json`). This is not a production RPC/indexing benchmark.
- New continuous native Base fork: actual Clanker collection, actual legacy module claim, genuine Splits, actual swap, and native SPCXc pushes all pass together (`native-pipeline.log`).
- New Aerodrome fork: create a new position locally using the real manager and tokens, trade both directions, collect real fees, burn DICKBUTT, pay SPCXc, verify unchanged LP liquidity and NFT custody, then verify empty recollection (`native-aero-position.log`). The locally created NFT does not exist on public mainnet.
- Native SPCXc capacity: 256 recipients were paid correctly and an identical batch did not pay twice; execution alone used about **14.66 million gas** (`native-batch.log`). Transaction overhead is additional. Base currently caps each transaction at **16,777,216 gas**, irrespective of its larger block limit ([Base configuration changelog](https://docs.base.org/base-chain/network-information/configuration-changelog)). An additional 400-recipient test measured **23,234,654 execution gas**, already above that cap (`native-batch-expanded.log`). The old contract comment recommending 250–400 recipients was corrected; this is a documentation correction, separate from the nine fix groups. Estimate actual token transfers and proof sizes, with margin; the public test uses 50 recipients per batch.

### Real-contract local fork amounts

At Base block 51,223,062, the continuous Clanker path collected **10.117052674954033686 WETH gross**. It paid **0.404682106998161347 WETH each** to the configured KC and CDB addresses on the fork, swapped **3.237456855985290779 WETH**, and received **54.09577133 SPCXc**. A capped test round paid **9.01596188** and **18.03192376 SPCXc** to two fork recipients, leaving the unallocated balance in the distributor. Reserved obligations returned to zero.

The new local Aerodrome position used tick spacing 200, an observed swap fee of 3,000 pips (0.3%), and an observed unstaked fee of zero at that test state. Two-way trades produced **3,000.000000000000076689 DICKBUTT** for burn and **0.00299999 SPCXc** for the distributor; its capped test payment was **0.00149999 SPCXc**. Fee rates and unstaked treatment must be checked again for the eventual production pool.

These mainnet-fork payments are local state changes, not public transfers to KC, CDB or holders.

### Public Base Sepolia deployment

Manifest: `config/deployment-sepolia-new.json`. Chain: **84532**. Distributor: `0xc0524A57cdA6558357667d41b0AB1752cD83d2D6`.

The deployment and first two fee cycles have confirmed public receipts. Claims, DICKBUTT split, WETH split, retained-input recovery and the following swap were checked against exact recipient deltas. The first holder round completed on **13 September 2026 at 04:00:51 UTC** after its real on-chain wait. Holder A (7 million DICKBUTT) received **0.33599999 test SPCXc**, holder B (14 million DICKBUTT) received **0.67199999**, and holder C (6.8 million DICKBUTT) received **zero**. The deliberately blocked B transfer failed while A succeeded; unblocking and retry paid B without paying A twice. Repeating the completed job sent **zero transactions**. The round closed with **zero reserved obligations** and **1.02400001 test SPCXc** left unallocated for future rounds. The normal **24-hour delay** was restored. Receipts, balances and settings were independently checked again at finalized block **46,752,373**; see `.context/test-results/public-payout-verification.json` and `.context/public-sepolia/validation.json`.

- [First holder payment, with the intentional B failure](https://sepolia.basescan.org/tx/0x9865c455773be20e8fd0316a56d776430e9acd67cd8c338a2126766f3b28842a)
- [Successful B retry](https://sepolia.basescan.org/tx/0xaa0f924a18428b46cce2eb143237a4bda9066df8aac0b3afc8465bc0ba3f6721)
- [Round closure](https://sepolia.basescan.org/tx/0x5ce2c7128767d5a41dbda0171f3c65979626fbca0326c6769aba1c248c1d9968)
- [Round proposal](https://sepolia.basescan.org/tx/0xa567d305b67c941e5b32c07ae569656addae49769812a71e1e9c2a5a2aa8e20f)
- [First-cycle retained WETH swap](https://sepolia.basescan.org/tx/0xccabd1c10ca4360ee943b0df46bf936ad96b30e5a15f3b2e08eef47585b51dcc)
- [Second-cycle WETH split](https://sepolia.basescan.org/tx/0xdcdea00e61b6ab618c91331d41d6a533926e110e1bcdf1134de6dadb10dbc6a7)
- [Second-cycle swap](https://sepolia.basescan.org/tx/0xfc8f021f8904158dd18f61c5a21d7861d775354e76178edaa9b71a280be38859)

Sepolia's Splits are genuine. Its tokens, Clanker/legacy sources, Aerodrome position manager, router and quoter are test stand-ins. KC test recipient: `0x80e00D628CbE20377695fe43E9d959597adFFe1B`; CDB test recipient: `0xFee59016beD7dB11f56e5530863DCd0b2021bbF8`. These are not the production recipient addresses.

### Extended observation

An active Codex follow-up named **Base Sepolia extended validation** checks this task every 30 minutes. The initial runner first tests a failed recipient, retry, duplicate prevention and closure, then restores the normal **24-hour** round delay. After that, `script/soak-sepolia.mjs` records a 48-hour observation window in `.context/public-sepolia/soak.json`, collects and verifies fees every six hours, checks and refreshes the floor as needed every six hours, and checks payout/monitor status on each tick. It proposes one additional round after 13 hours so its real 24-hour wait can finish within the observation window. No testnet time travel is used.

The first extended tick passed all four jobs: floor check, fee cycle, payout repeat and monitor. This is the **third public fee cycle overall**. Its verified deltas were **100 test DICKBUTT and 0.001 test WETH to KC**, **0.001 test WETH to CDB**, **905 test DICKBUTT to burn**, and **1.016 test SPCXc to the distributor**. The swap executor retained zero WETH; the distributor now holds **2.04000001 test SPCXc** for future rounds. Holder balances are unchanged from the completed first round. All seven fee transaction receipts succeeded, and the monitor reported no attention items. Evidence: `.context/public-sepolia/soak.json` and `soak-1-fees.log` through `soak-3-monitor.log`.

The extended run is **running, not yet completed**, with its recorded window from **13 September 04:31:54 UTC to 15 September 04:31:54 UTC**. Initial public payment is complete. This start was about 31 minutes after the initial runner completed; that gap is outside the recorded 48-hour window. The run must finish after its recorded end with the extra round closed, every holder balance matching the journal's cumulative payouts, and zero reserved obligations. Unallocated SPCXc can correctly remain for future rounds. Unknown transaction outcomes stop further writes until receipts and processes are reconciled. Local scheduled tasks require this Mac to remain on and Codex running ([official scheduled-task guidance](https://learn.chatgpt.com/docs/automations?surface=app)); downtime must be reported as a test gap.

## Remaining production work and limitations

1. **Target chain:** this project targets Base (8453). Ethereum mainnet (1) does not have these same configured tokens and Aerodrome paths. The deployment and operating CLIs currently allow only local/testnet writes. A production operating mode needs its own review; removing a chain guard is not enough.
2. **Production setup:** owner, proposer, guardian and floor-setter configuration is incomplete. The intended rewards pool and funded NFT are absent. Verify actual recipient control before creating immutable Splits, and rehearse multisig acceptance and the separate locker, legacy-creator and NFT handoffs. None of those public production handoffs occurred here.
3. **Owner authority:** the owner can appoint a keeper and propose a root, so the claim that no single administrative key can lose funds is incorrect. Use reviewed multisig ownership. The keeper's new off-chain verification does not constrain a different keeper appointed by the owner.
4. **Operating assumptions:** keep the keeper's reviewed config, executable code and RPC access separately controlled. Full historical replay needs reliable archive data and production-scale performance validation. The synthetic arithmetic test does not cover a full real-holder event scan. This Mac run does not demonstrate four independent hosts or weekend uptime.
5. **Price and token behavior:** the floor is an administrative price bound, not an independent price oracle. Market movement within its lifetime, quote quality and issuer restrictions remain relevant. Actual SPCXc transfer behavior passed at the tested fork state; future issuer policy changes can cause retries or stopped swaps.
6. **Legacy lifetime:** the adapter cannot change its module, destination or Safe list and cannot relay creator authority onward. Decide how future Clanker Safe changes or migration will be handled before permanently assigning that role. Safe owners can also disable the module.
7. **Carry and scheduling:** large recredited or below-threshold accrued rewards can exceed the next round cap and stop calculation until reviewed recovery. The local recovery test explicitly raised and restored the cap. A 12-hour scheduler against an exact 12-hour contract interval can also be rate-limited by timing jitter; the extended test uses a 13-hour proposal interval.
8. **Position identity and stray tokens:** the harvester checks manager and NFT ID on receipt, but does not itself validate the NFT's token pair or range. Validate these before custody transfer. Unexpected tokens sent to the narrow immutable fee router have no recovery function. These remain configuration/design constraints.
9. **Recipient failures differ by stage:** a blocked recipient can revert an entire upstream Split transaction. Holder payout batches instead isolate failed token transfers. Do not assume the whole fee system has the same per-recipient retry behavior as the distributor.
10. **Longer observation:** the public partial-payment/retry test passed; finish the ongoing extended run. Only mark the extended run complete after its recorded end, expected additional normal-delay payout, matching holder receipts and zero reserved obligations. Report outages or skipped work rather than treating elapsed time as proof of uptime.

## Reproduce

From the `tested-project` directory:

```sh
npm test
FOUNDRY_BASE=true BASE_NATIVE_TESTS=true BASE_RPC_URL=https://mainnet.base.org LIVE_SPCXC_HOLDER=0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E .tools/foundry/forge test
FOUNDRY_INVARIANT_RUNS=512 FOUNDRY_INVARIANT_DEPTH=256 FOUNDRY_FUZZ_RUNS=4096 .tools/foundry/forge test --no-match-path 'test/*Fork.t.sol'
node script/stress-calculator.mjs
BASE_RPC_URL=https://mainnet.base.org npm run rehearse
```

Use Base-compatible Foundry for the B20 token tests. `script/validate-public-sepolia.mjs` and `script/soak-sepolia.mjs` send public **testnet** transactions using the existing test wallets. Do not run concurrent copies. Never publish `.env`, signing keys or private local wallet files with this handoff.

Latest follow-up: payout repeat and monitor completed successfully at **2026-09-13 06:02:02 UTC**, with no new transactions or attention items. The preceding completed monitor check was about 55 minutes earlier; this observation gap is disclosed in the complete report. The 48-hour window remains incomplete.

Latest alignment review: [ALIGNMENT-RETEST-REPORT.md](ALIGNMENT-RETEST-REPORT.md). New native tests cover replacement wallets, explicit old-keeper revocation, two-step owner acceptance, the real USDC intermediate transfer, delayed NFT custody and harvesting under permanent locks. A fresh signed rehearsal passed with 59 distinct hashes and zero reserves. The initial native rerun omitted FOUNDRY_BASE=true and failed six tests; restoring the documented setting resolved all six without contract changes. Latest public payout/monitor repeat completed 06:51:32 UTC, with no new payouts or attention items. The roughly 49.5-minute gap since the preceding monitor is disclosed.

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
