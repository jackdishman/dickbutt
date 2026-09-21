# Security Audit — internal review, 2026-09-20

## Executive Summary

**Review candidate, not production approval.** The vAMM adaptation and the operating fixes passed local testing. Four reproduced findings were repaired: **3 Medium, 1 Low**. No Critical or High exploit was demonstrated within this scope. That does not prove absence of vulnerabilities or make this an independent audit.

Base commit: `1c11115c3365b2aad00239b6f2c22d6e79a0ede3`, plus the source changes in this pull request. [Source hashes](audit/2026-09-20/source-sha256.json) bind the reviewed executable/configuration inputs. [Deployment build](audit/2026-09-20/deployment-build.json) records compiler settings and contract byte sizes; the six-contract build hash is `0xf4fadf487f85942d0c38387f4e5554e822805bd27618ebb12b955297086062a0`.

Framework: Foundry Base build `1.6.0-v1.1.1`, commit `dccbdfd0b37d364cc50e0e15f1686ab029543c6f`; solc **0.8.24**, optimizer **200**, **viaIR**, **Cancun**. Dependencies: OpenZeppelin contracts 5.0.2, Merkle tree 1.0.8, ethers 6.17.0. Static analyzer: Slither 0.11.6 in an isolated environment.

Method: pre-change architecture/invariant mapping, baseline reproduction, manual contract and operational-path review, static analysis and triage, adversarial regression tests, fuzzing, stateful invariants, real-dependency local forks, signed local rehearsal and coverage. There were **no mainnet writes, custody transfers or real-fund transactions** during this review.

## Scope

Production contracts reviewed: `AerodromeVammHarvester`, `DickbuttRewardsDistributor`, `LockerHarvester`, `LegacyFeeHarvester`, `SplitsFeeRouter`, `SplitsV2Interfaces`, and `SpcxcSwapExecutor`. Historical `AerodromeFeeHarvester` and `FeeSplitter` remain regression/static-review scope but are not the selected deployment architecture.

Also reviewed: calculator/TWAB/journal/reconciliation, independent keeper replay, fee/floor/monitor orchestration, signer/transaction locking, schedule generation, deployment build/input binding and resumability, vAMM preflight/config selection, local console and handoff documentation. The [attack-surface map](audit/2026-09-20/ATTACK_SURFACE.md) and scanner authorization/function printers support this inventory.

Exclusions: an independent audit of upstream Base, Clanker, Aerodrome, Splits or OpenZeppelin; production hosts/key custody; unknown future pool state; market manipulation profitability at an undecided swap size; formal verification; uninterrupted long-term service. Prior public pilot/testnet transactions are historical evidence, not transactions performed in this review.

## Architecture

Clanker locker fees are claimed, then configured legacy Safes are claimed. The locker deducts its upstream 60% before the adapter receives fees. The legacy module returns **DICKBUTT only**, including the token-side deduction; WETH in those Safes is not made claimable by this adapter. Incoming DICKBUTT is split 10% KC / 90% burn. Incoming WETH is split 10% KC / 10% CDB / 80% executor. The executor swaps WETH → USDC → SPCXc into the distributor. Upstream Splits retains small protocol/rounding dust.

The new basic volatile DICKBUTT/SPCXc pool uses **unstaked ERC-20 LP shares**. The harvester claims its held share, sends 100% DICKBUTT fees to the burn address and 100% SPCXc fees to the distributor. It does not add/remove liquidity, stake LP or approve a spender. Later LP contributions inherit its lock and gain no withdrawal authority. Fees earned before LP transfer remain credited to the previous owner; this matches the [official Pool accounting](https://github.com/aerodrome-finance/contracts/blob/main/contracts/Pool.sol) and was verified locally against the actual factory/pool implementation.

Finalized holder history feeds inclusive **6.9M DICKBUTT period TWAB** eligibility and linear weighting. The intended schedule calculates every six hours, has no extra proposal review delay, and retries pending proposals/payouts each minute. Payments are keeper-pushed: holders need not sign. The 50% round cap, minimum payout accrual, integer dust, finality and scheduler availability affect when individual amounts are delivered.

## Trust Model

- The recognized Safe owns administrative contracts. Two-step acceptance is required; nomination alone does not complete ownership. The owner can appoint keepers/proposers and thereby authorize arbitrary rewards. A missing reward-rescue function does not remove this authority.
- Keeper, proposer and price-floor setter are separate operational roles/hosts. Keeper verification must use independently controlled code, configuration and archive RPC. Journal hashes alone do not prove correct rewards.
- Zero review delay removes the guaranteed guardian cancellation window. Anyone can activate immediately; pause stops future proposals, and the owner can close an already active round.
- The price-floor bot uses DEX quotes, not an independent oracle. The lower bound and swap cap need economic review.
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

## Informational / Hardening Observations

- **Price manipulation remains an economic risk.** A mock depressed quote above the owner's lower bound was accepted by the floor bot. This demonstrates dependence on spot quotes, not a proven profitable exploit of the actual route. Production swap size, liquidity/MEV analysis and floor selection remain outstanding.
- **Supported assets are a real restriction.** Taxed-token tests demonstrate accounting/recipient-delivery mismatch. Native configured SPCXc tests passed at the pinned state; future issuer restrictions, tax/rebase changes or malicious replacements are not supported. Recipient rejection is retryable; upstream Splits can revert its whole distribution.
- **Scaling:** 3,000 native recipients passed in 15 batches of 200, including replay without double payment. Without gas-report instrumentation, peak conservative transaction envelope was 13,552,032 gas for the zero-delay case; 256-recipient batches with 12-level proofs reached 17,335,225. The [Base configuration documentation](https://docs.base.org/base-chain/network-information/configuration-changelog) lists a 16,777,216 transaction cap. Exact production calldata/state must be estimated; these are not dollar-price forecasts. Gas-report instrumentation produced higher measurements, preserved separately.
- **Replay/availability:** Independent keeper verification replays full history every run. Production-length performance, archive-provider completeness and long-lived scheduler/backup recovery remain to be measured. Local tests cannot establish indefinite uptime or future rewards without fees.
- **Compiler:** Checked the [official known-bugs list](https://docs.soliditylang.org/en/latest/bugs.html). Relevant older-version classes include mutual-recursion spill issues and storage-boundary array clearing. No mutually recursive internal production call path, custom boundary storage layout or affected transient-storage usage was identified. This is manual applicability assessment, not a compiler correctness proof. Keep compiler/settings pinned to reviewed artifacts; any compiler upgrade requires rebuilding/retesting.
- **Out-of-scope mechanisms:** No application permit/signature verification, bridge, lending, auction, randomness or upgrade proxy exists here. Standard wallet transactions, Merkle proofs, upstream Safe/clone internals and native token policy still have their own trust boundaries. Forced ETH is not used in token accounting. No arbitrary external-call or delegatecall interface is exposed by the new harvester.

## Testing Performed

| Evidence | Result / interpretation |
|---|---|
| `npm test` | **219 passed, 0 failed/skipped**, including separate audit regressions and localhost console tests |
| Full native Solidity suite, gas report | **148 passed, 0 failed, 1 skipped** across 25 suites |
| Fuzzing | 1,024 cases per fuzz test in the final full run |
| Stateful invariants | Five invariants, each **256 sequences × 128 calls = 32,768 calls**, zero handler reverts reported; internally caught hostile-call failures are intentional |
| Signed local vAMM rehearsal | **93 unique transaction hashes**, successful; three fee sources, genuine forked Splits, mock assets/sources/router, real JS calculator and independently verifying keeper |
| Repeated reward cycles | Two further six-hour local clock advances, immediate-ready proposals, keeper payment, no holder signatures or duplicates |
| Native vAMM fork | Actual tokens/factory/pool accounting; locally created LP, both trade directions, three claim/payment cycles, prior-owner fees, top-ups, lock protection and final fees after withdrawal |
| Native Clanker/legacy pipeline | Real locker/module/Safes, separate local authority handoffs, both legacy Safes, immutable Splits, WETH→USDC→SPCXc and holder transfers; separate from the vAMM orchestration fixture |
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
  FOUNDRY_FUZZ_RUNS=1024 FOUNDRY_INVARIANT_RUNS=256 FOUNDRY_INVARIANT_DEPTH=128 \
  forge test --offline -vv --gas-report
BASE_RPC_URL=<archive-rpc> REHEARSAL_FORK_BLOCK=51223062 npm run rehearse -- --vamm
```

`FORGE_BIN`/`ANVIL_BIN` select the local binaries for rehearsal. Do not supply production wallet keys. The default test runner can skip fork tests without the relevant RPC/native environment, so inspect skips rather than treating a small green run as equivalent evidence.

## Tool Output

Slither analyzed the complete compiled application; source-filtered results contain **64 reports**, including 16 high-labeled balance/reentrancy heuristics. Every report is individually assessed in [slither-triage.json](audit/2026-09-20/slither-triage.json). They largely concern intentional balance postconditions, guarded callbacks, timestamp gates, indirect zero checks and ABI/style differences. No scanner report was promoted to a confirmed High exploit without a demonstrated path. Human-summary/auth/state/function printers were also inspected; their wider dependency/mock scope has different counts.

Coverage of the complete test compilation initially hit a **minimal-optimizer Yul stack error** in the large `NativePipelineFork` fixture. A documented retry excluded only that fixture from instrumentation; its three tests passed in the normal optimized full run. The filtered coverage run passed **145 tests, 0 failed, 1 skipped**. vAMM measured **92.96% lines / 43.10% branches**; distributor **99.17% / 26.98%**. Coverage uses `--ir-minimum`, whose source mappings can be inaccurate. Untouched vAMM lines include cancellation and the successful unrelated-token rescue path; these received manual review, not a claim of full branch coverage.

Initial JavaScript failures included expected old assertions for the now-repaired cap behavior, a receipt fixture lacking reconciliation support, a shared test-address lock collision, and sandbox-denied localhost listeners. Each was resolved or rerun in the appropriate isolated/localhost-capable environment. Final results above contain no failures. No production Solidity was changed merely to satisfy a test.

## Final Assessment

The candidate is suitable for developer review. **I would not yet entrust production liquidity or permanently assign legacy authority to it.** No unresolved demonstrated Critical/High exploit remains in this review, but production readiness is incomplete:

1. Supply and verify the actual basic volatile DICKBUTT/SPCXc pool, its LP owner/share, fee, factory, reserves and an actual local-fork fee-claim simulation using that pool.
2. Complete roles, swap/price limits, exclusions, timestamp and remaining parameters. Verify Safe ownership/acceptance and deployment artifacts against this reviewed source.
3. Independently review the permanent legacy handoff, LP/destination lock decisions, native-token dependencies and economic price risk.
4. Provision and test separate bot hosts, journal transfer/backups, gas/heartbeat alerting and production-history replay performance.
5. The operating CLIs **still reject mainnet execution**. A separate reviewed operating change and staged deployment/handoff verification are required. The deployment script's explicit mainnet `--execute` capability is distinct; nothing invoked it in this task.

Passing local tests is useful evidence, not a guarantee of error-free contracts, exact six-hour payment times or perpetual rewards.
