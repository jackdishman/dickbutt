# GitHub publication and snapshot provenance

> Historical September 13 publication record. Current source, findings and tests are in [the final audit](../AUDIT_REPORT.md) and [current handoff](HANDOFF.md); current development review is draft PR #9.

This review branch publishes the tested rewards-operation changes, developer reports and reviewed evidence for `jackdishman/dickbutt`. It targets `main` and does not approve a merge, deployment or custody transfer.

## Source comparison

The repository's default branch was checked at commit `bbe41b089bd124b9aca2e93f78a785827b085674`. All 114 tracked files matched the owner's preserved supplied baseline byte for byte. There were no intervening source changes to reconcile. No repository-specific `AGENTS.md` or pull-request template was present in that checkout.

The prepared patch applied cleanly to that commit. All 139 source, configuration and report files covered by `SOURCE-MANIFEST.json` match the reviewed snapshot exactly. The 123 selected evidence files also retain their original bytes and paths. Publishing did not change executable application or Solidity code beyond the already tested changes.

The source snapshot was packaged at **2026-09-13 16:47:32 UTC**. Its latest recorded scheduled observation completed at **2026-09-13 16:30:43 UTC**. Later progress in the separate running observation is outside this fixed snapshot.

## Developer review

- [Complete developer report](COMPLETE-DEVELOPER-REPORT.md): attribution, all nine fix groups F1–F9, failures, recovery, test scope and production limitations.
- [Alignment and retesting](ALIGNMENT-RETEST-REPORT.md): operating order, real fork coverage, custody/role checks and launch blockers.
- [Developer handoff](DEVELOPER-HANDOFF.md): concise changes, operation and reproduction guidance.
- [File change inventory](FILE-CHANGE-INVENTORY.md): the 66 prepared source/document changes against the supplied baseline. This publication note, the archive README and packaging metadata are additional delivery material.
- [Source manifest](../SOURCE-MANIFEST.json): SHA-256 hashes for the 262 reviewed source/report/evidence files, with paths relative to the repository root.
- [Portable handoff](../handoff/README.md): ZIP contents, checksum and patch provenance.

Earlier passages in the reports describe earlier observations and GitHub access checks. Their statements that no remote was available or no publication had occurred describe the preparation stage; this document and the associated PR establish the later publication stage. For the snapshot's final observation totals, use the reports' scheduled-observation blocks and recovery/coverage sections. Earlier three-cycle balances remain historical evidence.

## Saved verification and current limits

The retained final application suite passed **169 tests**. The Base-native Solidity suite passed **114 tests**, with **one optional production-NFT test skipped**. Nine fuzz tests ran 4,096 cases each; the invariant run executed 131,072 calls. Native fork reproduction requires `FOUNDRY_BASE=true` and the documented compatible Foundry toolchain. The earlier invocation without that setting failed six native tests and is retained in the evidence.

The lengthy suites were not rerun solely for publication of identical tested source. Publication checks cover the remote/baseline comparison, clean patch application, exact source/evidence hashes, archive consistency, configured-credential exclusion and staged-file review. Syntax checks passed for all 64 JavaScript, MJS and Python source files. Recorded evidence is preserved in its original format, including the line-delimited output in `keeper-cli-repeat.json`.

At this snapshot, **four public Base Sepolia fee cycles and one paid/closed holder round** had completed. The last reconciled distributor balance was **3.05600001 test SPCXc**, with zero reserved obligations and zero executor WETH. A fourth-cycle interruption required one reviewed swap-only recovery. The exact cause of the 10:46 UTC fee/read interruptions remains undetermined. Historical-RPC pruning and observation gaps, including a **123-minute gap**, are disclosed. The **48-hour observation and additional normal-delay holder round remain incomplete**. No continuous uptime or production readiness is established.

Production targets **Base mainnet 8453**, with **SPCXc rewards for eligible DICKBUTT holders** and separately selected production roles. Launch still requires completed timed observation/reconciliation; final roles, recipients and exclusions; the actual Aerodrome pool/NFT and custody checks; acceptance of permanent locker/legacy authority and immutable downstream routing; production execution support; reliable historical RPC, funded bots, gas and monitoring; and independent review. Public Sepolia uses test assets and external-source/router stand-ins with genuine Splits; native fork transactions are local test state changes.

## Evidence handling

Only the manifest's explicit evidence allowlist is included under `.context/`. These files are archived test results, not authority to resume a job. The one-use swap recovery helper must not be rerun. Runtime directories remain ignored for future unreviewed files. No active observation process, automation, key, journal or chain state was changed for publication, and no blockchain transaction was sent.

The configured signing-credential scan was checked against the original local configuration without printing or exporting its values. Funded-wallet configuration, private local wallet files, pending-transaction markers, dependencies, build/cache outputs and private console state are excluded. The packager's configured-credential checks and apply-and-compare patch verification remain intact. The rehearsal source's documented public Anvil development fixture is only for disposable local testing.
