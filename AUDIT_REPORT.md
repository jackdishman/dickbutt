# Final Security Audit — internal review, 2026-09-20

> September 21 follow-up: the user supplied the actual pool and LP-holder wallet. Their checks and three new local fork tests passed; the configuration update and remaining launch requirements are documented in [selected-pool verification](docs/SELECTED-POOL-VERIFICATION.md). The September 20 results and hashes below remain the original audit snapshot.

## Executive Summary

**Review candidate, not production approval.** This fresh pass used three separate contract, accounting and operations reviewers plus a combined integration review. It reproduced and fixed **four additional findings: 3 Medium, 1 Low**, bringing the two September 20 passes to **6 Medium and 2 Low fixed findings**. Final results: **238 JavaScript tests, 163 Solidity tests, and 93 unique signed local transactions passed**. One optional historical NFT test was skipped. No Critical or High exploit was demonstrated; this is an internal AI-assisted review, not an external audit or proof that no vulnerabilities exist.

Final-pass baseline: `4a7e7a68d0ee3ac881214c77f8f82b3ca749a5de`, the published draft PR #9 candidate; upstream main was `1c11115c3365b2aad00239b6f2c22d6e79a0ede3`. [Source hashes](audit/2026-09-20-final/source-sha256.json) bind the final reviewed inputs. [Deployment build](audit/2026-09-20-final/deployment-build.json) records the regenerated six-contract build hash **`0x27dbf1dfa8f70db8b39c5de8b27912a8fe23819e5056449599d7d258407ea5b9`**. The LockerHarvester change is explanatory NatSpec only; its source/metadata hash changed and must not be mixed with old artifacts. The [previous report](audit/2026-09-20-final/previous-audit-report.md) and original evidence remain preserved.

Framework: Foundry Base build `1.6.0-v1.1.1`, commit `dccbdfd0b37d364cc50e0e15f1686ab029543c6f`; solc **0.8.24**, optimizer **200**, **viaIR**, **Cancun**. Dependencies: OpenZeppelin contracts 5.0.2, Merkle tree 1.0.8, ethers 6.17.0. Static analyzer: Slither 0.11.6 in an isolated environment.

Method: pre-change architecture/invariant mapping, baseline reproduction, manual contract and operational-path review, static analysis and triage, adversarial regression tests, fuzzing, stateful invariants, real-dependency local forks, signed local rehearsal and coverage. There were **no mainnet writes, custody transfers or real-fund transactions** during this review.

## Scope

Production contracts reviewed: `AerodromeVammHarvester`, `DickbuttRewardsDistributor`, `LockerHarvester`, `LegacyFeeHarvester`, `SplitsFeeRouter`, `SplitsV2Interfaces`, and `SpcxcSwapExecutor`. Historical `AerodromeFeeHarvester` and `FeeSplitter` remain regression/static-review scope but are not the selected deployment architecture.

Also reviewed: calculator/TWAB/journal/reconciliation, independent keeper replay, fee/floor/monitor orchestration, signer/transaction locking, schedule generation, deployment build/input binding and resumability, vAMM preflight/config selection, local console and handoff documentation. The [current attack-surface map](audit/2026-09-20-final/ATTACK_SURFACE.md) and scanner authorization/function printers support this inventory.

Exclusions: an independent audit of upstream Base, Clanker, Aerodrome, Splits or OpenZeppelin; production hosts/key custody; unknown future pool state; production market profitability/MEV protection at undecided swap limits; formal verification; uninterrupted long-term service. Prior public pilot/testnet transactions are historical evidence, not transactions performed in this review.

## Architecture

Clanker locker fees are claimed, then configured legacy Safes are claimed. The locker deducts its upstream 60% before the adapter receives fees. The legacy module returns **DICKBUTT only**, including the token-side deduction; WETH in those Safes is not made claimable by this adapter. Incoming DICKBUTT is split 10% KC / 90% burn. Incoming WETH is split 10% KC / 10% CDB / 80% executor. The executor swaps WETH → USDC → SPCXc into the distributor. Upstream Splits retains small protocol/rounding dust.

The new basic volatile DICKBUTT/SPCXc pool uses **unstaked ERC-20 LP shares**. The harvester claims its held share, sends 100% DICKBUTT fees to the burn address and 100% SPCXc fees to the distributor. It does not add/remove liquidity, stake LP or approve a spender. Later LP contributions inherit its lock and gain no withdrawal authority. Fees earned before LP transfer remain credited to the previous owner; this matches the [official Pool accounting](https://github.com/aerodrome-finance/contracts/blob/main/contracts/Pool.sol) and was verified locally against the actual factory/pool implementation.

Finalized holder history feeds inclusive **6.9M DICKBUTT period TWAB** eligibility and linear weighting. The intended schedule calculates every six hours, has no extra proposal review delay, and retries pending proposals/payouts each minute. Payments are keeper-pushed: holders need not sign. The 50% round cap, minimum payout accrual, integer dust, finality and scheduler availability affect when individual amounts are delivered.

## Trust Model

- The recognized Safe owns administrative contracts. Two-step acceptance is required; nomination alone does not complete ownership. The owner can appoint keepers/proposers and thereby authorize arbitrary rewards. A missing reward-rescue function does not remove this authority.
- Keeper, proposer and price-floor setter are separate operational roles/hosts. Keeper verification must use independently controlled code, configuration and archive RPC. Journal hashes alone do not prove correct rewards.
- Zero review delay removes the guaranteed guardian cancellation window. Anyone can activate immediately; pause stops future proposals, and the owner can close an already active round.
- The price-floor bot uses DEX quotes, not an independent oracle. The lower bound and swap cap need economic review.
- Pending fee-destination proposals survive owner acceptance: inspect and cancel unwanted proposals before funding. Freezing the Clanker adapter destination does not revoke owner recovery of its upstream NFT after unlock.
- LP and fee-destination permanent locks are irreversible. Legacy creator assignment is also effectively permanent: its immutable adapter has no relay to return that authority. Locker ownership and legacy creator authority are separate.
- Native SPCXc issuer/platform policy, Safe module permissions, upstream factory authenticity, token behavior, RPC accuracy, gas funding and ongoing bot operation remain dependencies. The adapter is not upgradeable; recovery options narrow after permanent locks.

## Critical Invariants

Tested properties include: aggregate pending/active reserves remain solvent; delivered amounts match committed accounting; duplicate batches do not double-pay; failed recipients preserve retryable credit; cancellation/closure recredits only unpaid amounts; unprivileged callers cannot redirect funds or withdraw locked LP; harvesting preserves LP principal; actual swap output/input deltas and temporary allowances are enforced; supported-token balances and claim ledgers conserve funds; calculator payouts plus carried credit equal allocated accrual; capped payouts never exceed budget; and eligibility uses finalized, time-weighted history rather than same-transaction balances.

## Findings Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| M-01 | Medium | Accrued rewards above the round cap stall calculation | Fixed; regression/property tests pass |
| M-02 | Medium | Six-hour scheduler misses a proposal slot by seconds | Fixed; separate minute proposer retry |
| M-03 | Medium | Permissionless harvest race aborts remaining fee steps | Fixed for proven cooldown races; ambiguous sends still stop |
| L-01 | Low | Active unpaid rounds can stay green indefinitely | Fixed with persisted progress observations |
| F-M01 | Medium | Generated calculator and proposer use different journals | Fixed; executable schedule regressions |
| F-M02 | Medium | Keeper checks nonce before waiting for signer lock | Fixed; fresh checks under all signer locks |
| F-M03 | Medium | Concurrent deployments overwrite recovery ledger | Fixed; output/signer locks and fresh nonce check |
| F-L01 | Low | Console rehearsal silently selects historical NFT model | Fixed; explicit model, vAMM default |

Original descriptions and pre-fix reproductions are retained in [baseline findings](audit/2026-09-20/baseline-findings.json) and [baseline PoCs](audit/2026-09-20/baseline-pocs.mjs.txt). Current machine-readable findings: [audit-findings.json](audit-findings.json).

## Detailed Findings

### M-01 — Accrued rewards exceed the round cap

**Severity:** Medium. **Confidence:** High. **Affected code:** `calculator/engine.js:21-45`, `calculator/core.js:19-40`.

**Description/impact:** With 100 funded, a 50-unit cap and payout threshold 60, the first period accrued 50. The next period tried to pay 100 against a 50 cap, threw, and did not advance the journal. Ordinary low-fee operation could stall funded rewards without any attacker.

**Scenario/PoC:** The saved baseline repeatedly reproduces the stuck state. Current `test/audit/operations-security.test.mjs` M-01 verifies a 50-unit payment with 50 retained and journal advancement. `test/audit/capped-accrual.test.mjs` exercises 5,000 deterministic portfolios for exact conservation, per-account limits, cap use and ordering independence.

**Remediation:** Pay proportional capped instalments to otherwise-eligible accrued balances, distribute raw-unit remainders deterministically and preserve unpaid credit. Preserve the previous new-share calculation and uncapped ordering for successful historical journal replay.

**Residual risk:** An instalment can be below the payout threshold; the threshold determines eligibility of accrued credit. Residual credit must reach the threshold again later. Small budgets cannot pay every holder each round. Proposer and keeper must run the same reviewed policy.

### M-02 — Proposal schedule drift

**Severity:** Medium. **Confidence:** High. **Affected code:** `operations/schedule.js:41-61,137-143`.

**Description/impact:** A proposal mined at t=10 makes the next fixed job at t=21600 too early for the six-hour on-chain interval. The payout job did not propose, so the next opportunity was six hours later.

**Scenario/PoC:** M-02 in `test/audit/operations-security.test.mjs` rejects the early attempt, then commits the same journal plan at the minute retry without calculating another period.

**Remediation:** Add `propose-pending` every 60 seconds on the existing proposer host/key. Schedule validation rejects missing, slow or misplaced retries. Key isolation remains enforced.

**Residual risk:** Scheduler/RPC delays, overlapping writer locks, journal replication and finality still affect actual delivery. Six hours is the configured earnings/proposal cadence, not a wall-clock guarantee.

### M-03 — Harvest race interrupts independent work

**Severity:** Medium. **Confidence:** High. **Affected code:** `operations/fees.js:9-64`, `script/run-fees.mjs` transaction-marker events.

**Description/impact:** Another account can harvest after the bot checks readiness. A cooldown revert then aborted legacy claims, splits and swaps for that invocation. Repeated interference could delay processing.

**Scenario/PoC:** M-03 regressions simulate an unsent estimate revert and a definitively mined failed transaction after the source cooldown advances. Both now continue later independent steps. Missing/mismatched/success receipts or unchanged cooldown still abort.

**Remediation:** Continue only after a conclusively unsent estimate failure or re-query of the exact failed receipt, together with fresh evidence of an advanced, active source cooldown. Clear the pending marker only for a confirmed/reconciled outcome. A mined race reports attention because gas was consumed.

**Residual risk:** A race can cost gas. RPC uncertainty still requires reconciliation; unrelated reverts remain failures. One-confirmation operational handling is not a finality guarantee.

### L-01 — Stalled active round appears healthy

**Severity:** Low. **Confidence:** High. **Affected code:** `operations/monitor.js:28-33,102-117`, `script/run-monitor.mjs` progress-file persistence.

**Description/impact:** Only pending-round age was checked. A known active round could remain unpaid for 30 days and still be reported healthy if other checks passed.

**Scenario/PoC:** L-01 regression observes unknown age, checks the exact six-hour staleness boundary, verifies payment resets the clock, and rejects regressing or wrong-chain history.

**Remediation:** Persist public per-round progress beside the deployment manifest with atomic replacement. First observation reports unknown age; no progress for six hours reports attention. Older uninspected reservations retain their existing alert.

**Residual risk:** This is not an external scheduler heartbeat. Independently alert on silence, absence of new rounds and a dead monitor. Retain its writable progress file across runs; corrupt state fails closed.

### F-M01 — Generated schedule writes and reads different journals

**Severity:** Medium. **Confidence:** High. Agent ID OPS-M-01. `operations/schedule.js`, `script/render-schedule.mjs`.

The calculator defaulted to the current directory while the rendered proposer read `./data`. Even an explicit `--journal` changed only readers. Ordinary installation could indefinitely stop proposals/payments unless an operator supplied a matching environment setting. Inert executable probes reproduced the mismatch before any change. The generated command now binds `CALCULATOR_DATA_DIR` to the same selected journal and passes paths as quoted positional arguments, overriding stale inherited values. Tests cover spaces, dollars, percent signs and control characters. Cron paths containing backslashes are explicitly rejected; systemd retains them with escaping. Systemd serialization was reviewed against its specification, but no installed Linux daemon was tested on this Mac.

**PoC/regression:** `test/audit/final-operations-schedule.test.mjs`; before-fix logs and the [operations review](audit/2026-09-20-final/operations-findings.md). Correct journal replication and a running scheduler remain required.

### F-M02 — A pending transaction can appear while keeper waits for its lock

**Severity:** Medium. **Confidence:** High. Agent ID F-M02. `keeper/engine.js`, `script/run-keeper.mjs`.

A fee job sharing the signer could broadcast, time out and release its lock after the keeper's pre-lock nonce check. The keeper then acquired the lock and sent another transaction despite unresolved prior work; its separate journal marker did not identify the fee job's send. The saved before-fix PoC demonstrates one new send. This is an availability/reconciliation race, not a demonstrated duplicate reward or theft.

The engine now requires fresh valid latest/pending counts for **all involved signers after all locks are held**, before journal work or sending. Pending differences, malformed values and RPC failure abort. Regressions verify the lock order, both signer identities, zero sends on uncertainty, lock release and later recovery.

**PoC/regression:** `test/audit/final-accounting.test.mjs`; [before-fix evidence and analysis](audit/2026-09-20-final/accounting-findings.md). Local locks and RPC counts do not coordinate a key used on another host.

### F-M03 — Concurrent deployment invocations can overwrite recovery state

**Severity:** Medium. **Confidence:** High. Agent ID OPS-M-02. `script/deploy-mainnet.mjs`, new `operations/deployment-lock.js`.

Two invocations could both pass an absent-partial check before an awaited balance read, then overwrite one recovery ledger. With deployable artifacts this can spend duplicate gas, orphan contracts or race nonces. The offline PoC invokes the real driver with a read-only fake provider and deliberately incomplete artifacts: it observes duplicate ledger entry without signing or broadcasting.

Canonical output-path and same-chain signer locks now precede partial checks. Fresh nonce equality is required under both locks before ledger creation. Normal errors release acquired locks; crash locks require manual process/receipt reconciliation. Tests cover identical output/different keys, identical key/different outputs, aliases, releases, pending nonce and invalid/RPC responses. Existing `--resume`, `--force`, build/input identity checks and execution gates remain intact.

**PoC/regression:** `test/audit/final-operations-deployment.test.mjs`; [operations review](audit/2026-09-20-final/operations-findings.md). Locks protect one host only. Ambiguous sends must be reconciled, never blindly restarted.

### F-L01 — Console rehearsal defaults to the wrong pool architecture

**Severity:** Low. **Confidence:** High. Agent ID OPS-L-01. `ui/commands.js`.

The console's full rehearsal omitted `--vamm`, so it exercised the historical NFT adapter. A passing console result could mislead a vAMM operator about what was tested. The form now explicitly selects the model, defaults to basic volatile ERC-20 LP, and retains the historical Slipstream option. The CLI continues to require its explicit vAMM flag; this audit supplied it.

**Regression:** `test/audit/final-operations-console.test.mjs`. This changes validation selection, not production fee splitting or custody.

## Informational / Hardening Observations

- **Price manipulation remains an economic risk (I-01).** Fresh actual-route fork experiments varied the victim swap from 0.001 to 1 WETH with a hypothetical 1 WETH front trade and honest quote-based bots. At 1 WETH the victim received about **0.362% less SPCXc** than the pre-move quote; the front/back trader gained **0.002463954883861282 WETH before gas, capital cost and ordering risk**. The smaller tested sizes lost money before gas. This is execution within permitted slippage, not a guard bypass; it also fits a 1% pre-move minimum. A separate 10 WETH front-move test shows the stricter pre-move minimum reverts and preserves input/allowance. These idealized local orders, hypothetical bounds and pinned liquidity do not prove production net profitability or select launch parameters. See [market evidence](audit/2026-09-20-final/native-market-final.log) and `test/audit/FinalNativeMarketBounds.t.sol`. Size/floor/slippage policy needs economic review; spot quotes are not an independent oracle.
- **Supported assets are a real restriction.** Taxed-token tests demonstrate accounting/recipient-delivery mismatch. Native configured SPCXc tests passed at the pinned state; future issuer restrictions, tax/rebase changes or malicious replacements are not supported. Recipient rejection is retryable; upstream Splits can revert its whole distribution.
- **Scaling:** 3,000 native recipients passed in 15 batches of 200, including replay without double payment. Without gas-report instrumentation, peak conservative transaction envelope was 13,552,032 gas for the zero-delay case; 256-recipient batches with 12-level proofs reached 17,335,225. The [Base configuration documentation](https://docs.base.org/base-chain/network-information/configuration-changelog) lists a 16,777,216 transaction cap. Exact production calldata/state must be estimated; these are not dollar-price forecasts. Gas-report instrumentation produced higher measurements, preserved separately.
- **Replay/availability:** Independent keeper verification replays full history every run. Production-length performance, archive-provider completeness and long-lived scheduler/backup recovery remain to be measured. Local tests cannot establish indefinite uptime or future rewards without fees.
- **Compiler:** A fresh [compiler/dependency applicability assessment](audit/2026-09-20-final/compiler-dependency-applicability.md) checked the current official version-specific bugs for 0.8.24, 247 implemented function/modifier definitions, all six storage layouts and runtime opcodes. No triggering recursion, storage-boundary crossing or relevant legacy-pipeline condition was identified. All six application runtimes contain zero DELEGATECALL/CALLCODE/SELFDESTRUCT after stripping metadata/PUSH data. This is an applicability assessment, not proof of compiler correctness. Keep reviewed settings pinned; upgrade only with a full rebuild/retest.
- **Handoff state (I-02/I-03):** New tests show pending destinations survive owner transfer and can be cancelled by the accepting owner, and Clanker destination freeze still permits owner NFT recovery after upstream unlock. NatSpec and current handoff instructions now state these powers. Legacy creator authority is separately permanent from the adapter perspective; upstream Safe governance can disable its module.
- **Out-of-scope mechanisms:** No application permit/signature verification, bridge, lending, auction, randomness or upgrade proxy exists here. Standard wallet transactions, Merkle proofs, upstream Safe/clone internals and native token policy still have their own trust boundaries. Forced ETH is not used in token accounting. No arbitrary external-call or delegatecall interface is exposed by the new harvester.

## Testing Performed

| Evidence | Result / interpretation |
|---|---|
| `npm test` | **238 passed, 0 failed/skipped**, including new scheduler/deployer/concurrency and accounting audit regressions |
| Full native Solidity suite, gas report | **163 passed, 0 failed, 1 skipped** across 29 suites |
| Fuzzing | 4,096 cases per fuzz test in the final full run |
| Stateful invariants | Five invariants, each **1,024 sequences × 256 calls = 262,144 calls** (1,310,720 total across five invariants), zero handler reverts reported; internally caught hostile-call failures are intentional |
| Signed local vAMM rehearsal | **93 unique transaction hashes**, successful; three fee sources, genuine forked Splits, mock assets/sources/router, real JS calculator and independently verifying keeper |
| Repeated reward cycles | Two further six-hour local clock advances, immediate-ready proposals, keeper payment, no holder signatures or duplicates |
| Native vAMM fork | Actual tokens/factory/pool accounting; locally created LP, both trade directions, three claim/payment cycles, prior-owner fees, top-ups, lock protection and final fees after withdrawal |
| Native combined pipeline | **Three new composed actual-dependency tests**: real locker/module/Safes + locally created real vAMM pool/LP + actual two-hop swap + shared distributor/holder transfers; another six-hour cycle and replay, principal preserved |
| Long accounting simulation | 120 six-hour attempts, 92 committed periods, 28 pending retries, 91 rounds, 93 journal records independently replayed; exact per-holder credit and funded-asset conservation |
| Baseline reproduction | Exact prior candidate passed 219 JavaScript and 148 Solidity tests (one optional skip) before the added adversarial cases exposed four gaps |
| Dependency advisory scan | `npm audit --ignore-scripts --json`: zero currently reported vulnerabilities; not an upstream Solidity audit |
| Batch sizing | Actual native token with 3,000 synthetic recipients and retry; 200 vs 256 batch comparison |

Fork block: **51223062**, hash `0x9a906018f91c3cd1b603d3530b73b78019387049bb8a900b46c749141de4c99c`. All impersonation, deployments, trades and clock changes happened inside local EVMs. The upstream RPC was read-only. This validates that historical state, not an uncreated public rewards pool.

The skipped test is the optional historical real NFT collection test, whose selected future NFT is absent; it is not the new vAMM adapter test. The vAMM native tests passed. Audit-specific Solidity tests also cover forged/duplicate proofs, callback attempts, owner authority, fee-on-transfer incompatibility, insolvency/recredits and zero-delay behavior. Same-timestamp borrow/repay produces no positive TWAB; square-root weighting is demonstrably Sybil-sensitive, while selected production weighting is linear.

### Reproduction

```sh
npm ci
npm test
# Use Base-compatible Foundry for native B20 tests, plus an archive read-only RPC:
FOUNDRY_BASE=true BASE_NATIVE_TESTS=true BASE_RPC_URL=<archive-rpc> \
  LIVE_SPCXC_HOLDER=0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E \
  FOUNDRY_FUZZ_RUNS=4096 FOUNDRY_INVARIANT_RUNS=1024 FOUNDRY_INVARIANT_DEPTH=256 \
  forge test --offline -vv --gas-report
BASE_RPC_URL=<archive-rpc> REHEARSAL_FORK_BLOCK=51223062 npm run rehearse -- --vamm
```

`FORGE_BIN`/`ANVIL_BIN` select the local binaries for rehearsal. Do not supply production wallet keys. The default test runner can skip fork tests without the relevant RPC/native environment, so inspect skips rather than treating a small green run as equivalent evidence.

## Tool Output

Fresh Slither analysis used the complete compiled application input, including all nine `src/` files and dependencies/support imports (33 sources). **99 unfiltered reports** were individually triaged, including 17 high-labeled heuristics: 16 balance/reentrancy checks and a deliberate XOR inverse seed in OpenZeppelin Math. The [individual triage](audit/2026-09-20-final/slither-triage-final.json) retains all IDs/locations/rationales and distinguishes actual non-production helper limitations from false positives. The former 64-count report was source-filtered; different counts do not mean 35 new production flaws. No warning was promoted to a confirmed exploit without a viable path.

Whole-test coverage instrumentation again hit a **minimal-optimizer Yul stack error** in the large native pipeline fixture. The documented filtered retry excluded `NativePipelineFork` and its new derived `FinalCombinedNative` fixture only: **157 passed, 0 failed, 1 skipped**. All six excluded tests passed in the normal full run. Measured vAMM coverage is **100% lines / 46.55% branches**; LockerHarvester **100% / 39.02%**; distributor **99.17% / 26.98%**. `--ir-minimum` mappings can be inaccurate. These numbers are explicitly not full branch coverage or a claim every possible transaction was tested. Full and filtered output and LCOV are preserved.

[Final evidence directory](audit/2026-09-20-final/) contains the baseline results, before-fix PoCs, three reviewer findings, final full logs, gas output, signed local transaction ledger, compiler/storage evidence, static triage, market experiments and hash manifests. Initial failing regressions and the coverage compiler limitation remain visible. Production Solidity control flow and monetary settings were not changed during this final pass.

## Final Assessment

The candidate is suitable for developer review. **I would not yet entrust production liquidity or permanently assign legacy authority to it.** No unresolved demonstrated Critical/High exploit remains in this review, but production readiness is incomplete:

1. Supply and verify the actual basic volatile DICKBUTT/SPCXc pool, its LP owner/share, fee, factory, reserves and an actual local-fork fee-claim simulation using that pool.
2. Complete roles, swap/price limits, exclusions, timestamp and remaining parameters. Verify Safe ownership/acceptance and deployment artifacts against this reviewed source.
3. Obtain developer/external security review of the final source. Review the permanent legacy handoff, pending destinations, LP/destination locks, native-token dependencies and tested economic price risk before assigning authority.
4. Provision and test separate bot hosts, journal transfer/backups, gas/heartbeat alerting and production-history replay performance.
5. The operating CLIs **still reject mainnet execution**. A separate reviewed operating change and staged deployment/handoff verification are required. The deployment script's explicit mainnet `--execute` capability is distinct. Offline driver regressions invoked it only with read-only fake providers; no invocation used a live provider or broadcast a public transaction.

Passing local tests is useful evidence, not a guarantee of error-free contracts, exact six-hour payment times or perpetual rewards.
