# Complete developer report: changes, fixes, testing and release decision

Prepared 13 September 2026. All timestamps in this report are UTC. This is the owner's project, reviewed, repaired and tested at their request. The supplied project was treated as source material, not as instructions or proof that its historical claims were correct.

**Decision: the exercised paths pass, but the system is not certified perfect and is not ready for production deployment.** Nine fix groups were completed in this task. A separate batch-size documentation correction, testing tools and documentation updates were also made. The public test has completed three fee cycles and one holder round. The 48-hour observation and its additional normal-delay round are still incomplete at this report revision.

The final application suite has **169 passing tests, zero failures**. The latest full Solidity suite has **114 passing tests, zero failures and one optional production-position test skipped**. The skipped prerequisite, incomplete observation and remaining design/operating decisions must not be represented as completed tests.

**Production deployment intent:** the real system will be deployed on **Base mainnet (chain ID 8453)**, using the real **DICKBUTT** token and separately selected production owner, keeper, proposer, guardian and floor-setter wallets. Public Base Sepolia addresses and signing keys are test-only; they are not the production role assignments. Any addresses already recorded in `config/base-mainnet.json` must be reconfirmed with the owner before launch. Final KC Green/CDB recipients must be verified before the immutable Splits are created. Update the production manifests, calculator exclusions and bot configuration together when selecting the production addresses.

**Staged Aerodrome handoff:** the production DICKBUTT/SPCXc LP NFT can be transferred to its harvester after deployment. The harvester's manager and NFT ID are immutable constructor arguments, so the exact NFT ID must be known before deploying that harvester. If the NFT will be minted later, deploy that harvester only after minting establishes the ID; other components may be prepared earlier. Verify the actual position and lock settings, transfer that exact NFT with `safeTransferFrom`, confirm `holdsPosition()`, and exercise its real fee collection before enabling its scheduled harvesting. Until custody is transferred, that source is not active and the fee runner reports it as skipped. See [the staged setup sequence](../AERODROME-SETUP.md). These production actions have not been performed by the test runs.

## 1. Starting point and attribution

A separate working copy was created from the user-supplied `dickbutt-main 2` project. The original supplied directory and the existing sibling workspace were preserved. This was a filesystem copy, not a Git checkout with a verified commit/PR history. The package's `changes.patch` is a direct comparison with the supplied files; its source manifest lists checksums. Historical claims about merged PRs or earlier deployments are not evidence of work performed in this task.

The original already contained the main Solidity architecture: locked-position collection, legacy returned-DICKBUTT claims, real immutable Splits routing, a bounded price-floor setter, a two-hop WETH swap executor, an Aerodrome NFT harvester, and a Merkle push distributor with proposer/keeper/guardian roles. It also already contained the TWAB calculator, journal, bootstrap mode, foreign-round handling/recredit, execution locks, floor bot, monitor, schedule renderer, Sepolia deployment tooling and control console.

Those features were inspected and exercised. They were **not all written or fixed in this task**. In particular, the floor-setter role, proposer/guardian design, bootstrap support, foreign-root recovery, mainnet execution gates, console session authentication and provider shutdown helper were already present. The original handoff is preserved as clearly labelled historical material with relative links rebased in `docs/history/HANDOFF-SUPPLIED.md`.

The work began by reading the README, startup/setup instructions, contract sources, calculator/keeper/operations code, configuration and supporting documents. Baseline tests and the normally optional fork suites were then run, followed by focused reproductions, fixes, repeated full tests, signed local wallet rehearsals, fresh public-testnet deployment, native-contract integration tests, capacity tests, timed public payouts and the extended observation.

## 2. Exact fix count and classification

There are **nine fix groups**, grouped by underlying problem rather than edited lines or individual assertions:

| ID | Area | Classification |
| --- | --- | --- |
| F1 | Calculator cannot progress after a delayed/rate-limited proposal | Runtime recovery fix |
| F2 | One unavailable legacy Safe stops unrelated fee processing | Runtime fee-cycle fix |
| F3 | Genuine-Splits fork fixture passes an EOA as distributor | Test fixture fix |
| F4 | Outdated dependency tree with known package advisories | Dependency maintenance |
| F5 | Interrupted public deployment cannot resume reliably | Deployment/recovery fix |
| F6 | Older RPC balance response causes a funded swap to be skipped | Runtime fee-cycle fix |
| F7 | Keeper trusts a consistently rewritten payout journal | Payout-verification fix |
| F8 | Console displays and defaults to the historical test deployment | Console/configuration fix |
| F9 | Production preflight omits required roles and misses role conflicts | Configuration-validation fix |

The count progressed from seven to eight when F8 was found, then to nine when the requested final alignment review found F9. These are **not nine Solidity logic defects**. Executable Solidity logic under `src/` remains unchanged from the supplied project. The only active `src/` edit is the batch-gas guidance comment. Comments can change compiler metadata hashes, so “logic unchanged” is not a claim that every newly compiled artifact is byte-for-byte identical to the deployed artifact.

### F1 — Recovery when a plan exists but the proposal has not landed

**Before:** the calculator threw when its journal already reserved the next on-chain round ID. This is the ordinary state after calculation succeeds but proposal is rate-limited or delayed. Because scheduled proposal execution follows a successful calculation, later runs could repeatedly fail before reaching the proposal that would clear the condition.

**Change:** `calculator/engine.js` now returns the existing unsettled plan as `pendingPlan`, without journaling another period or accruing the same rewards again. A contradictory settled plan still occupying the next ID remains an error. `calculate-rewards.js` prints a specific pending-plan result instead of treating it as failed calculation.

**Verification:** the regression repeatedly advances the simulated boundary while the proposal remains delayed, checks that the same root is retained and only one period exists, then advances the on-chain ID and verifies normal progress and correct reservations. The recorded reproduction failed before this fix and passed afterward. Full calculator, keeper and signed-wallet tests subsequently passed.

### F2 — Continue unaffected work when one legacy Safe cannot be claimed

**Before:** a definite gas-estimation revert from one `harvestFrom` call stopped the other Safe and all subsequent splits/swapping.

**Change:** `operations/fees.js` permits an optional legacy claim to be skipped only when ethers reports `CALL_EXCEPTION` specifically during `estimateGas`, which establishes that this attempted call was not broadcast. The result records the affected source, an attention item and a `legacyStatus` such as partial or failed. Other sources and downstream splits/swap can proceed. `script/run-fees.mjs` returns attention exit status 2 if a claim was skipped; the UI explains that status.

**Boundary:** a network timeout, uncertain broadcast, or failed mined transaction still stops the cycle for inspection. These are not silently skipped or blindly retried. A successful claim call may also collect zero when the Safe is empty; “confirmed” is not proof of a positive balance transfer.

**Verification:** fee-operation tests cover optional estimation failures, continuation, attention reporting and fatal uncertain outcomes. Public cycles exercised funded legacy Safes initially, then empty Safe claims later. The native fork tests separately exercised the real module/Safes.

### F3 — Repair the real-Splits test fixture

**Before:** `test/SplitsBaseFork.t.sol` supplied an externally owned address as the executor's distributor. The executor requires a contract address, so enabling the normally skipped real-Splits suite failed during setup.

**Change:** the fixture deploys a real `DickbuttRewardsDistributor` and supplies its address.

**Verification:** all eight tests in that genuine-Splits suite pass when enabled. This corrected the test setup; the constructor requirement was appropriate and was not removed.

### F4 — Update the dependency tree

**Change:** ethers **6.13.4 → 6.17.0**; `@openzeppelin/merkle-tree` **1.0.7 → 1.0.8**; scoped `@metamask/utils` override to **uuid 11.1.1**. `package-lock.json` was regenerated. `@openzeppelin/contracts` remains **5.0.2** and dotenv remains **16.4.5**. A `wallets:check` package command was also added as a testing convenience.

**Verification:** the saved post-update npm audit reports zero known advisories. Merkle golden vectors, all application tests and signed wallet flows pass with the updated packages. That audit is a package-database check, not a Solidity review or a guarantee against unknown dependency defects.

### F5 — Resume interrupted deployments without duplicating components

**Before:** partial state did not identify every deployed component and configuration transaction sufficiently for reliable restart. Starting over risked producing duplicate contracts and losing track of earlier deployments.

**Change:** `script/deploy-sepolia.mjs` adds explicit `--resume`, refuses a new run over existing partial progress, and checks chain, deploying address and role identity. Progress is written through a temporary file and rename. Every deployment records its transaction hash and predicted address before waiting; its identity includes sequence index, contract name and arguments, so two otherwise identical Safe deployments stay distinct. Configuration calls are deferred callbacks and their hashes are persisted before waiting. Resume checks receipts and deployed code instead of automatically redeploying or resending known actions. The Aerodrome unlock timestamp is persisted so constructor arguments do not drift between attempts. Router/quoter addresses and the token's actual deployment block are retained. Completed receipt evidence is saved alongside the final manifest. A resumed run uses a lower test-ETH admission threshold than a new deployment.

Public RPCs briefly disagreed about whether confirmed code was readable. Deployment now waits for confirmations and retries only the code read. It does not use that condition to blindly resubmit a transaction. Errors expose useful code/action information while redacting configured credentials.

**Recovery actually performed:** the first eight already-deployed contracts were reconciled from sender nonces, predicted addresses, creation blocks and receipts. Existing deployment progress was migrated into the recovery ledger. Later interruptions were resumed with verified progress. The completed ledger records **17 directly deployed contracts**, plus the **two genuine PushSplit clones** created by the router, and **14 configuration transactions**. The existing Splits factory was reused.

**Remaining boundary:** a process can still fail between broadcasting a transaction and persisting its hash. Such an uncertain outcome requires nonce/receipt reconciliation; `--resume` is not an exactly-once guarantee across every possible crash.

### F6 — Use confirmed-block reads before deciding whether to swap

**Observed public failure:** a WETH split confirmed, but a later `latest` balance response came from an older RPC backend. The fee runner saw zero executor WETH and reported an empty swap stage, despite the executor having just been funded.

**Change:** `operations/fees.js` tracks confirmed receipt blocks and pins dependent balance, keeper-role, floor, interval, cap and quote reads to the confirmed block. The quote callback in `script/run-fees.mjs` accepts the same snapshot. Failure to serve the required block is an error rather than a false empty balance.

**Recovery and verification:** a regression reproduces the stale response and fails before the fix. The retained WETH from the first public cycle was swapped separately without collecting the same sources again. The following cycles processed their swaps and reconciled exact recipient deltas. A separate timeout during the second cycle was resolved by checking which claims had already confirmed and completing only the remaining steps.

### F7 — Independently derive holder payouts before signing

**Before:** the keeper validated journal hashes, arithmetic and Merkle consistency, but those checks did not independently establish that the recipients actually held DICKBUTT. A consistently rewritten journal could contain a coherent but incorrect payout.

**Reproduction:** on a disposable local chain, the original keeper paid **5,000 raw reward units** to a wallet with zero DICKBUTT after the journal was consistently rewritten. This was a controlled local reproduction, not a public/mainnet transfer.

**Change:** new `keeper/verify-history.js` reconstructs every period from historical blockchain events and contract state, using the keeper's separately reviewed configuration. It verifies block identity, rejects periods beyond the selected finality boundary, replays the calculator into a temporary journal and compares the reconstructed records. It does not accept journal-supplied balances, allocations or reserves as authoritative calculation inputs. Temporary data is removed afterward. `keeper/engine.js` runs this verification before any proposal, activation or payment mutation and reports the verified period count.

**Verification:** valid history is accepted. A coherent incorrect payout, invented initial balance, changed block hash, future period and unavailable archive data are rejected. The wrong-recipient reproduction is rejected both before proposal and after its incorrect root has been directly proposed on-chain. The corrected keeper sends zero transactions and the wrong wallet receives zero. The full legitimate signed rehearsal and public proposal/payout passed this actual reconstruction path.

Lifecycle-only unit fixtures inject a clearly labelled verification stub because they do not model historical RPC state. Dedicated reconstruction tests, the real local reproduction and the full wallet/public runs exercise the real verifier. The fixture stub is not used by the normal CLI.

**Remaining boundary:** this is an off-chain check. It depends on the keeper's code, configuration and historical RPC being independently controlled and correct. The on-chain owner can appoint another keeper and propose another root; this change does not remove that authority. Full replay also needs a production-scale archive/indexing performance assessment.

### F8 — Make console state and commands select the same deployment

**Found during final reporting:** the fresh test ran against `deployment-sepolia-new.json`, but the console still loaded the historical manifest and offered historical calculator/journal defaults. A user could inspect the wrong addresses or run a command against the wrong test deployment.

**Change:** `config/console-deployment.json` explicitly selects the current manifest, calculator configuration and journal. New `ui/deployment-paths.js` validates those repository-relative paths. Both `ui/state.js` and the command registry use the selection, and `ui/server.mjs` passes its actual project root to both. Displayed input defaults and resolved execution arguments therefore agree. An installation without a selector keeps its historical defaults; malformed selectors fail rather than silently falling back. Explicit user input still overrides a form default, and the mainnet preflight configuration remains unchanged. Fee exit-status text and the stale deployment-count wording were also corrected.

**Verification:** three new tests cover state/form/execution agreement, fallback behavior and invalid-path rejection. The full application suite at the F8 stage passed **165 tests**; the latest alignment review passes 169. This fix sent no transaction and changed no deployed contract. Restart an existing console process to load the updated modules.

### F9 — Match production preflight to deployment role validation

**Before:** `operations/preflight.js` used a separate validator that did not require proposer/guardian addresses and could accept keeper/admin and treasury/bot conflicts rejected by the deployment checker. Two new regression cases failed against that code.

**Change:** production preflight now reuses `validateRoles` from `operations/deployment.js`, mapping `floorSetter` to `ops`. It requires the complete role set and rejects the existing policy's conflicts; an owner/guardian shared multisig remains permitted.

**Verification:** both new regressions and the complete preflight test file pass. The final full application suite passes **169/169**. Fresh finalized production preflight correctly reports all four unfilled roles and the pending pool/NFT; no production address was selected or transaction sent. This is a preflight validation fix, not a Solidity change. Evidence and every new test are in [ALIGNMENT-RETEST-REPORT.md](ALIGNMENT-RETEST-REPORT.md).

## 3. Additional work, separate from the nine fix groups

- Added reusable RPC connections with at most four concurrent sockets, a 30-second request timeout, disabled response caching/batching by default and optional `RPC_IPV4_ONLY=1`. Calculator, deployer, fees, keeper, floor and monitor use it. It improves transport behavior but does not guarantee public RPC availability. The original `closeProvider` shutdown workaround was retained, not newly invented here.
- Changed the local rehearsal's signing roles from unlocked-node signers to five separate HD wallets that sign locally. Nine wallet roles are reported. The public development mnemonic is used only on the disposable local chain; it is not a public-funded wallet seed.
- Added local Foundry discovery, explicit binary overrides and `--keep-alive`. The persistent mode records a local manifest and writes disposable keys only to a mode-0600 local file, excluded from the handoff.
- Increased local Anvil retained history to 4,096 states. Independent replay exposed insufficient historical state in a later rehearsal stage; retaining enough history resolved the local-node configuration problem.
- Added the local Wallets tab, authenticated read-only wallet API, block-consistent balance reads, raw/decimal reward display, manual refresh and a scrolling table. Final handoff cleanup also corrected the table to use the existing border-color variable and qualified the text to say eligible holders. Its RPC is restricted to loopback and chain 31337. The API does not load keys. The network view can resolve the persistent local manifest.
- Added `script/check-wallets.mjs` to derive public test addresses internally, compare role configuration and check test-ETH funding without sending transactions or printing keys. Its new-deployment funding threshold should not be confused with the lower continuing-operation monitor threshold.
- Added resumable public validation, the finite extended-test tick, the synthetic calculator stress test and three native Base fork integration/capacity test files.
- Added source/evidence packaging, a complete file inventory, checksums and a patch checked against the original supplied files. Private configuration, signing keys, local wallet files, node_modules and downloaded binaries are excluded.
- Installed/used Base-compatible Foundry locally and its required runtime dependency, verified the downloaded release archive against recorded release metadata, and retained the test toolchain identity. Tested runtime: Node 25.5.0, Solidity 0.8.24 with the project's optimizer/viaIR settings, Base Foundry commit `98e7839c65f64aee9627b69a9b98b79afaeb1fae`. The package's declared minimum Node version remains 18; this task is not a test matrix across every supported Node version.
- Corrected documentation about owner authority, off-chain payout validation, managed-position fee scope, legacy WETH treatment, local versus public receipts, the current deployment, existing versus newly added features, and still-open production work. All authored report timestamps now use UTC.

A separate measured documentation correction concerns `distributeBatch`: the original comment suggested 250–400 recipients based on the block gas limit. Native SPCXc transfers to 256 fresh recipients used about **14.66 million execution gas**, before transaction overhead. A 400-recipient call used **23,234,654 execution gas**, exceeding Base's **16,777,216 per-transaction cap**. The comment and keeper guidance now require actual gas estimates with margin. The active public test uses 50-recipient batches. This is a correction to an unsupported recommendation, not an on-chain algorithm change or an automatic adaptive-batching feature. [Base configuration changelog](https://docs.base.org/base-chain/network-information/configuration-changelog).

## 4. What the contracts actually distribute

The real Clanker locker collects fees belonging to the configured DICKBUTT/WETH LP NFT. It deducts 60% of both tokens to its fee Safe and sends 40% to the router. The separate legacy module can return DICKBUTT from the configured current/historical Safes; it does **not** return their WETH. When all those claims are available, the router can receive effectively all of the managed position's collected DICKBUTT and 40% of its WETH.

The DICKBUTT reaching the router is split **10% KC / 90% burn**. The WETH reaching the router is split **10% KC / 10% CDB / 80% swap**. Therefore the swap receives **32% of gross managed-position WETH**, KC receives 4%, CDB receives 4%, and 60% remains on the Clanker side, before integer rounding.

The executor follows **WETH → USDC → SPCXc**, with a quote/minimum, deadline, size cap, keeper role and bounded price floor. SPCXc goes directly to the reward distributor. The tests check actual spent input/received output and temporary allowance cleanup. The administrative floor is not an independent oracle.

The separate managed DICKBUTT/SPCXc Aerodrome NFT sends **all its DICKBUTT fee proceeds to the burn address** and **all its SPCXc fee proceeds to the distributor**. There is no additional KC/CDB split on this branch in the current design. Sending DICKBUTT to the dead address is a transfer, not a call that reduces token totalSupply. CDB receives WETH; bridging or NFT purchases are outside this code.

The off-chain calculator assigns SPCXc to eligible wallets based on time-weighted holdings. The current public test uses a **6.9-million-DICKBUTT minimum**, linear weighting, explicit exclusions and the configured payout minimum. A wallet holding twice the qualifying balance for the same period receives twice the weight, subject to integer rounding. Transfers during the period affect the average. Holders do not connect a wallet or sign a claim; the keeper pushes payments after the verified proposal and timelock.

This does **not** mean every DICKBUTT holder receives rewards, every LP's fees are collected, all trading volume routes through these pools, or every incoming reward token is immediately paid. The default 50% round cap deliberately retains part of the available pot. Finality and below-minimum accrual can defer rewards too.

## 5. Local testing and real-contract fork evidence

### Signed orchestration rehearsal

The complete rehearsal uses genuine Splits on a local Base fork, with mock tokens, fee sources and router. It deploys and wires the architecture, claims all sources, checks exact split dust, swaps, bootstraps/calculates, proposes, advances local time, pays partially, retries, closes, repeats, handles a foreign commitment, cancels it and recredits once. Recovery explicitly raises and restores the cap for one proposal; that administrative intervention is part of the test.

The latest fresh signed rehearsal also passed (`.context/rehearsal-run-Rxoi5i/report.json`), with 59 distinct transaction hashes and the same 538/1,077 raw-unit final payouts. It uses the real calculator and independent keeper replay. The native pipeline now additionally verifies 8,129.365695 USDC moving between the actual swap pools.

An independently checked local run recorded **59 distinct successful receipts from five signers**, nine wallet roles and zero reserved rewards. The final post-verification rehearsal also passed; its report contains 79 transaction/event entries but **59 unique hashes**, so those entries must not be described as 79 separate transactions. The final local holder balances were 538 and 1,077 raw reward units, totaling 1,615.

### Native Clanker → legacy → Splits → real swap → holder push

At pinned Base block **51,223,062**, the new continuous native test used the actual locker, legacy module, Splits, swap route and native SPCXc. It collected **10.117052674954033686 WETH gross**, paid **0.404682106998161347 WETH each** to KC and CDB on the fork, swapped **3.237456855985290779 WETH**, and received **54.09577133 SPCXc**. A capped round paid **9.01596188** and **18.03192376 SPCXc** to two recipients; reserved obligations returned to zero.

Actual DICKBUTT collection and legacy claim amounts, KC allocation and burn amount are retained as exact raw integers in `native-pipeline.log`. The native integration test uses a constructed test Merkle plan; TWAB calculation is covered by the separate calculator/signed/public flows. Do not imply the two native fork recipients were selected by a production holder scan.

### Native Aerodrome position

A new local position was created using the real manager and native tokens, then traded both directions. At that pinned state, tick spacing was 200, observed swap fee was 3,000 pips (0.3%), and observed unstaked fee was zero. Harvesting burned **3,000.000000000000076689 DICKBUTT** and forwarded **0.00299999 SPCXc**. A capped test payment of **0.00149999 SPCXc** passed. NFT custody and liquidity were unchanged, and empty recollection did not pay again.

This NFT exists only inside that local test. The intended public production pool/NFT is still absent from the production configuration and was absent at the recorded preflight. Actual production fee modules, issuer restrictions, price and liquidity must be rechecked.

### Extended and capacity tests

- Latest full application suite after F9: **169 passed, zero failed** (`alignment-npm-final.log`).
- Latest full Solidity suite: **114 passed, zero failed, one skipped** across 18 suites (`alignment-forge-expanded.log`), including new replacement-wallet, delayed-NFT and permanent-lock tests. Nine fuzz tests each used 4,096 cases; the invariant used 512 runs at depth 256, totaling 131,072 calls with zero invariant reverts. The optional skipped test needs the intended production Aerodrome NFT.
- Extended non-fork run: **94 tests passed**, **4,096 cases per fuzz test**, and **512 invariant runs at depth 256**, totaling **131,072 lifecycle calls**, with zero invariant reverts.
- Synthetic calculation: **10,000 holders**, **200,000 transfers**, **10,000 checked proofs**, 200 batches of 50. TWAB and ending balances matched a separate time-integral reference. Payouts of 1,234,567,885,155 raw units plus 4,968 raw dust exactly matched a pot of 1,234,567,890,123. Recorded arithmetic time was about 2.5 seconds plus 3.6 seconds for planning/proof verification, using about 111 MiB heap. This is not a production archive-RPC benchmark.
- Native token batches: 256 recipients and repeat suppression passed; the 400-recipient measurement demonstrated an oversized public transaction rather than proving that size usable.

## 6. Public Base Sepolia work actually completed

A fresh deployment was made on **chain 84532**, using the user's funded test wallets. Current distributor: `0xc0524A57cdA6558357667d41b0AB1752cD83d2D6`. The manifest, calculator configuration and deployment receipt ledger are included. Public test wallets are separate from the disposable local mnemonic wallets. The public owner, deployer and guardian share one test identity; keeper, proposer and floor setter are separate. The local rehearsal used a separate guardian signer. Neither arrangement substitutes for a production multisig exercise.

The public deployment uses genuine Splits. DICKBUTT, WETH, USDC and SPCXc are test tokens; locker, legacy module/Safes, position manager, swap router and quoter are test stand-ins. The router mints fixed-rate test output. These receipts establish orchestration/accounting and real-time operation, not production liquidity or slippage performance. On-chain mint faucets also mean unrelated third parties could alter test balances; unexplained changes must be investigated, not assumed to be generated revenue.

Three fee cycles have completed. The first includes 600 and 500 DICKBUTT seeded in the two legacy Safes. The next two show successful empty legacy calls after those balances were claimed. In the latest cycle: 1,000 DICKBUTT and 0.01 WETH reached the router; KC received 100 DICKBUTT and 0.001 WETH; CDB received 0.001 WETH; the DICKBUTT Split sent 900 DICKBUTT to burn; the executor spent 0.008 WETH and produced 0.016 SPCXc; Aerodrome added 5 DICKBUTT to burn and 1 SPCXc to rewards. Total cycle rewards were **1.016 SPCXc** and total DICKBUTT burned was **905**. All seven receipts succeeded.

The cumulative finalized balances checked at block **46,754,244** were:

| Destination | DICKBUTT | WETH | SPCXc |
| --- | ---: | ---: | ---: |
| KC test wallet | 409.999999999999999999 | 0.002999999999999999 | 0 |
| CDB test wallet | 0 | 0.002999999999999999 | 0 |
| Burn address | 3704.999999999999999999 | 0 | 0 |
| Rewards distributor | 0 | 0 | 2.04000001 |
| Swap executor | 0 | 0 | 0 |

Each Split retains two raw units. Cumulative rewards reconcile exactly: **3.04799999 received = 1.00799998 paid + 2.04000001 remaining**.

KC test wallet: `0x80e00D628CbE20377695fe43E9d959597adFFe1B`. CDB test wallet: `0xFee59016beD7dB11f56e5530863DCd0b2021bbF8`. These are not the production recipient wallets. No public production KC/CDB payout or custody handoff was performed.

### First public holder round

The initial public test deliberately used a **one-hour delay**, waited through actual block time, and completed at **2026-09-13 04:00:51 UTC**. The 7-million-DICKBUTT holder received **0.33599999 test SPCXc**, the 14-million holder **0.67199999**, and the 6.8-million holder **zero**. The B recipient was deliberately blocked: A succeeded, B remained unpaid, B was unblocked and paid on retry, and A did not receive a duplicate. Repeating the closed round submitted zero transactions. The round closed with zero reserved obligations.

The normal **24-hour delay** was restored and independently checked at finalized state. The initial one-hour test is not evidence that the additional 24-hour round has already passed.

- [Proposal](https://sepolia.basescan.org/tx/0xa567d305b67c941e5b32c07ae569656addae49769812a71e1e9c2a5a2aa8e20f)
- [Initial partial payout](https://sepolia.basescan.org/tx/0x9865c455773be20e8fd0316a56d776430e9acd67cd8c338a2126766f3b28842a)
- [Successful B retry](https://sepolia.basescan.org/tx/0xaa0f924a18428b46cce2eb143237a4bda9066df8aac0b3afc8465bc0ba3f6721)
- [Round closure](https://sepolia.basescan.org/tx/0x5ce2c7128767d5a41dbda0171f3c65979626fbca0326c6769aba1c248c1d9968)
- [Latest fee-cycle swap](https://sepolia.basescan.org/tx/0x63dd68f818cd72235d0df9b44c3f5edd343bdbca5d1562bd096518f041660e19)

Test ETH was also moved from the test owner to top up proposer and floor-setter wallets to 0.003 each, with saved receipts. Only test ETH was used. The latest saved monitor reported a live floor, adequate gas, proposals enabled and zero outstanding rewards, without attention items.

## 7. Extended observation and unresolved work

The recorded observation window is **2026-09-13 04:31:54 UTC through 2026-09-15 04:31:54 UTC**. It started about 31 minutes after initial validation completed; that gap is outside the 48-hour window. A recurring follow-up invokes one finite tick about every 30 minutes. Fee cycles occur every six hours; floor checks/refreshes occur every six hours as needed. One additional proposal becomes due after 13 hours so its actual 24-hour delay can finish within the observation window.

The initial extended tick passed fee collection, splits, swap, a payout repeat and monitoring. Subsequent recorded ticks also passed with no additional payout. The latest check completed at **2026-09-13 06:02:02 UTC**, with no monitor attention items. There was approximately a **55-minute interval** between the preceding completed monitor check and this one, so the evidence does not establish a continuously maintained 30-minute cadence. That interval did not cross the next recorded fee/proposal due time. It is recorded as an observation gap, not silently counted as continuous monitoring. The next planned fee cycle is due at or after **2026-09-13 10:31:54 UTC**; the extra proposal is due at or after **2026-09-13 17:31:54 UTC**. It was not submitted at the reporting snapshot. The extra round's actual ready time depends on its eventual proposal receipt.

The runner guards chain/deployment identity, isolates each child's role key, records jobs, refuses blind replay of uncertain actions and uses an exclusive lock. Mutable progress is read after acquiring the lock so a competing invocation cannot overwrite another run's state. A dry run or rejected competing invocation does not write a new failure into the active run. This is a test harness, not a production daemon or independent-host demonstration.

**Still open before production:**

1. Finish the real observation and extra normal-delay round; require matching cumulative holder receipts, closed planned rounds and zero reserved obligations. Elapsed time alone is not evidence of uninterrupted service.
2. Complete the production owner/proposer/guardian/floor-setter and recipient configuration; prove control of immutable recipient destinations. Rehearse multisig acceptance, not merely EOA signing.
3. Create/configure/fund the intended rewards pool/NFT and verify its actual pair, fee, range, liquidity, manager and unstaked treatment. The harvester checks manager and ID on receipt, not every economic property of the NFT.
4. Review the three distinct production custody handoffs. Locker ownership and the legacy creator role have serious migration constraints; the legacy adapter has no editable Safe list, module or destination and cannot relay creator authority onward. The NFT's withdrawal behavior depends on its configured lock and any permanent-lock choice.
5. Review owner authority. The owner can appoint a keeper and propose a root, so absence of a reward-withdraw function does not remove the possibility of owner-directed payouts. Off-chain verification does not constrain a replacement keeper chosen by the owner.
6. Operate separately controlled keeper code/configuration/RPC and test full production history replay at scale. A single test machine with role-specific child environments is not equivalent to independent hosts, backups and monitoring.
7. Validate current real quotes, floor settings, actual gas margin, liquidity and native SPCXc issuer restrictions. A valid but stale administrative floor can allow a worse market execution; future token policy can stop transfers.
8. Plan carry/recredit recovery. Accrued obligations can exceed the next round cap and deliberately stop calculation; the tested local recovery used a reviewed temporary cap change. Exact 12-hour scheduling can also encounter rate-limit jitter; this extended test schedules its extra proposal after 13 hours.
9. Understand differing failure behavior: a blocked upstream Split recipient can revert an entire split transaction, whereas distributor batches isolate individual reward-transfer failures. Unexpected tokens sent to the narrow fee router have no recovery method.
10. Complete independent review and a separately reviewed production deployment/operation mode. The current operating tools reject mainnet writes. This project targets **Base (8453)**; Ethereum mainnet (1) is not supported by merely changing an RPC URL.

## 8. Limitations and failures disclosed

The final alignment review initially omitted `FOUNDRY_BASE=true`: six native SPCXc tests failed with unsupported execution, while 106 tests passed. All six passed with the documented native mode restored, and the expanded full run subsequently passed 114 tests. This test invocation error and the failing F9 before-fix regressions are preserved in the evidence. No contract logic change was used to resolve the native runtime failure.

The new native tests confirm two-step owner acceptance, explicit revocation of old keeper approvals, replacement bot operation, claim-order dependency, USDC hop transfers, later NFT transfer, continued harvesting under permanent locks and unchanged DICKBUTT total supply after burn-address transfers. They do not establish actual multisig operation or permanent uptime. See [the alignment report](ALIGNMENT-RETEST-REPORT.md) for the detailed immutability/migration boundaries and remaining production work.

Earlier runs had genuine defects, expected negative-test reverts, provider connection timeouts, temporarily stale RPC data and a local history-retention problem. The remedies above are recorded; this report does not erase those failed attempts. Historical `lastError` data in initial validation predates later confirmed recovery/completion and must be interpreted by timestamp rather than treated as a new unresolved failure.

The final application rerun initially could not bind its disposable localhost test servers under the filesystem/network sandbox and returned `EPERM`. After approval for localhost test servers, the full suite passed 165/165. This was an execution-environment restriction, not a contract revert.

Automated visual browser inspection of the authenticated console was rejected by automatic approval review because the connector could expose session and wallet data. That route was not bypassed. HTTP/API behavior, authentication, cross-origin rejection, wallet balances and the new deployment-selection tests were checked. The visual appearance remains unverified by automated browser inspection.

No formal proof, independent external review, public mainnet deployment, production multisig exercise, real production rewards NFT, multi-host weekend run or completed 48-hour observation is claimed. The correct answer to “does it work perfectly?” is **no such conclusion has been established**. The measured paths work within the stated tests, nine concrete fix groups were addressed, and the remaining conditions are material.

## 9. Files and reproduction

`docs/FILE-CHANGE-INVENTORY.md` lists every changed/added deliverable with its purpose. `changes.patch` gives exact differences against the supplied project. The packager applies the patch to a temporary copy and verifies that every resulting source file exactly matches the shipped file. `SOURCE-MANIFEST.json` identifies included file hashes. The prepared source folder and ZIP contain public test evidence but exclude configured credentials, private local wallet files, downloaded executables and dependencies. Historical manifests are preserved and clearly distinguished from the active selector.

Install dependencies with `npm ci`, provide a compatible Foundry installation, and use the unchanged project build settings. Native B20 tests require Base-compatible Foundry; a vanilla EVM test runner cannot establish native compatibility. The exact tested Foundry commit is recorded above. Public-test validation scripts are tied to the existing test deployment and should not be launched concurrently or with unrelated wallet keys. Do not execute mainnet writes by removing a guard as part of reproduction.

```sh
npm ci
npm test
FOUNDRY_BASE=true BASE_NATIVE_TESTS=true BASE_RPC_URL=https://mainnet.base.org LIVE_SPCXC_HOLDER=0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E forge test
FOUNDRY_INVARIANT_RUNS=512 FOUNDRY_INVARIANT_DEPTH=256 FOUNDRY_FUZZ_RUNS=4096 forge test --no-match-path 'test/*Fork.t.sol'
node script/stress-calculator.mjs
BASE_RPC_URL=https://mainnet.base.org npm run rehearse
```

`FORGE_BIN` and `ANVIL_BIN` can select compatible binaries for the rehearsal. On the testing machine they were installed under `.tools/foundry/`, which is intentionally not shipped. `npm run rehearse -- --keep-alive` retains its disposable local node for the Wallets panel. The prepared developer ZIP is a snapshot: later scheduled public progress requires a refreshed package.

Latest public recheck completed 2026-09-13 06:51:32 UTC: closed round, successful independent history verification, zero new payout transactions and monitor exit 0. The preceding check was about 49.5 minutes earlier; this is another disclosed observation gap. The recorded 48-hour test remains incomplete.

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
