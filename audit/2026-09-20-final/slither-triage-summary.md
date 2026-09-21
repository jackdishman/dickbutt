# Final Slither triage — all 99 detector entries

The fresh run completed successfully. Every detector has an individual ID/index, scanner impact/confidence, exact source locations, scope, disposition, rationale, evidence references and residual limits in [slither-triage-final.json](slither-triage-final.json). Its input hash binds it to [slither-all.json](slither-all.json). **Zero entries remain untriaged.** No additional production exploit was established from these scanner reports.

| Scanner label | Entries |
|---|---:|
| High | 17 |
| Medium | 21 |
| Low | 34 |
| Informational | 25 |
| Optimization | 2 |

These are scanner labels, **not 17 confirmed High vulnerabilities**. Primary source classification is 41 production application, 20 historical application, 23 dependency, 12 Sepolia helper and 3 test helper. Some reports span more than one source category. The earlier saved 64 reports used source filtering; this run includes dependencies and helpers. Sixty-one detector IDs match prior evidence; three old source IDs changed with line/source changes. Neither old evidence nor prior reports were overwritten.

The 16 balance/reentrancy reports concern intentional before/after asset postconditions around guarded calls. Fresh tests additionally challenge fabricated output with pre-existing funds, excess input spending, unexpected balance increases, post-transfer failure, keeper-authorized router callbacks, unrelated-round activation callbacks and ERC20 false/no-return behavior. No unprivileged theft path was established under the documented token/router assumptions. Market manipulation, privileged quorum power, token policy and operating availability require their separate analysis.

OpenZeppelin Math's XOR is the deliberate four-bit modular-inverse seed, not mistaken exponentiation. All eight odd denominator residues were independently checked in [slither-math-seed-check.json](slither-math-seed-check.json). The eight divide-before-multiply warnings are exact full-precision division/Newton iteration steps. The fresh bounded caller fuzz verifies upward output rounding; it is not represented as exhaustive testing of the 512-bit arithmetic branch.

Five helper reports identify **real limitations**, not false positives: two payable Sepolia stand-ins can retain mistakenly attached ETH, and three SepoliaLocker parameters/mutations omit zero-address checks. These minting fixtures are excluded from the selected production deployment and must not custody real assets. No helper redesign was made merely to quiet the scanner.

The distributor loop still depends on appropriately estimated batches and supported token behavior. Ordinary transfer failures preserve retryable credit, but no per-transfer gas stipend or on-chain batch-count cap exists; gas-burning token callbacks can exhaust an entire transaction. That limit is recorded explicitly. Timelocks/expiry/cooldowns are deliberate chain-time gates, while two timestamp reports merely taint ordinary round-state predicates.

Library assembly, compatible pragmas, zero checks performed in helpers/base constructors, optional-return ERC20 calls, ABI naming, unused test support and optimization suggestions were individually reviewed. The imported generic delegatecall helper is unused; all six production runtimes have zero DELEGATECALL/CALLCODE/SELFDESTRUCT opcodes after excluding metadata/PUSH bytes. The [fresh compiler assessment](compiler-dependency-applicability.md) evaluates current known compiler bugs against actual settings, call structure and storage layouts rather than relying on Slither's older pragma warning database.

This triage does not turn a passing scan or test suite into deployment approval, prove compiler correctness, or replace actual pool/configuration and independent operational verification.
