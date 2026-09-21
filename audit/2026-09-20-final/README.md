# Final audit evidence — 20 September 2026

Published text logs have trailing whitespace normalized; original raw files remain in the local output archive. Compressed scanner/compiler JSON preserves exact original bytes.

Current conclusions and findings are in [AUDIT_REPORT.md](../../AUDIT_REPORT.md); this directory is evidence, not deployment authorization.

## Evidence inventory

- `BASELINE.json`, `baseline-js.log`, `baseline-solidity.log`: exact published candidate before this pass; 219 JS / 148 Solidity pass, one optional NFT skip. The original archive is retained locally; its commit is reproducible through Git.
- `source-sha256.json`: 139 final executable, test, config and dependency inputs. `evidence-sha256.json` separately binds published evidence; `documentation-sha256.json` binds current edited documents.
- `deployment-build.json`, `runtime-comparison.json`: final six-contract build and unchanged executable runtime objects after removing metadata. Solidity changes in this pass are comments only.
- `final-js.log`: 238 passes, zero failures/skips. `final-solidity.log`: 163 passes, zero failures, one optional historical NFT skip; 4,096 cases per fuzz test and five invariants at 1,024 sequences × 256 calls each. Gas-report measurements are instrumented.
- `local-vamm-transactions.json`: 93 unique local transaction hashes (138 lifecycle event records include repeated hashes). Development keys sign only disposable chain 31337. Real forked Splits; mock assets/fee sources/router for JS orchestration.
- `combined-native.log`: actual pinned-state Clanker/legacy/module/Safes/tokens/Splits/two-hop route plus a locally created real factory vAMM pool, all contributing to one distributor and holder payouts. No state was written to Base.
- `native-market-final.log`: hypothetical actual-route slippage/market experiments. Positive gross return at one size is not net production profitability or a violated minimum.
- `accounting-findings.md`, `operations-findings.md`, `contract-findings.md`: separate reviewer findings, reproductions, fixes and boundaries. Before-fix logs/PoCs are deliberately retained. Main report maps reviewer IDs to final finding IDs.
- `slither-all.json.gz`: compressed original 99-report scanner JSON; `slither-triage-final.json` contains every report ID, rationale and limitation. Its `scanner_input_sha256` hashes the decompressed bytes. `slither-triage-summary.md` explains scope and non-production helper limits. Old filtered 64-report evidence is preserved in the previous audit directory.
- `compiler-build-info.json.gz`: exact 33-source final standard compiler input/output, compressed for review. `compiler-structure-evidence.json` and `compiler-dependency-applicability.md` assess pinned-version bugs, storage and call/opcode structure. `upstream-legacy-source.json` is the read-only verified explorer snapshot.
- `coverage-whole.log`: instrumentation compiler failure. `coverage-filtered.log` and `.lcov`: 157 passes after excluding the two large native pipeline fixtures; their six tests all pass under normal production optimization. IR-minimum mappings/branch coverage are incomplete.
- `ATTACK_SURFACE.md`: corrected current map. `ATTACK_SURFACE-BEFORE.md` and `previous-audit-report.md` preserve historical text verbatim, including old-relative links and superseded scope notes; follow current report for current status.

## Reproduction

Use a clean checkout, pinned dependencies, solc 0.8.24 and a Base-native Foundry build (`1.6.0-v1.1.1`, commit `dccbdfd0b37d364cc50e0e15f1686ab029543c6f`). Do not load production signing keys. From repository root:

```sh
npm ci
npm test
FOUNDRY_BASE=true BASE_NATIVE_TESTS=true BASE_RPC_URL=<read-only-archive-rpc> \
  LIVE_SPCXC_HOLDER=0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E \
  FOUNDRY_FUZZ_RUNS=4096 FOUNDRY_INVARIANT_RUNS=1024 FOUNDRY_INVARIANT_DEPTH=256 \
  forge test --offline -vv --gas-report
BASE_RPC_URL=<read-only-archive-rpc> REHEARSAL_FORK_BLOCK=51223062 npm run rehearse -- --vamm
node audit/2026-09-20-final/inspect-compiler-input.mjs
```

The compiler inspection script reads the bundled compressed build by default; an optional first argument selects another build JSON or gzip file. It reproduces structure evidence, not a full compiler proof. `FORGE_BIN`/`ANVIL_BIN` select the Base-compatible tools for rehearsal. Individual historical route tests also use block 51218068; the new composed and market tests use 51223062.

For Slither 0.11.6, decompress `compiler-build-info.json.gz` into a temporary build-info directory and run `slither . --ignore-compile --foundry-build-info-directory <that-directory> --json <output.json>`. The original invocation compiled all application sources via `forge build --skip test --skip script --build-info --extra-output storageLayout`; imports still include support dependencies. No detector/filter suppression was applied to the final 99-report scan.

For coverage use the same native environment with `forge coverage --offline --ir-minimum --skip NativePipelineFork --skip FinalCombinedNative --report summary --report lcov`. Separate output/cache paths avoid replacing production artifacts with coverage builds. Never deploy coverage artifacts.

Mocks, local time advances, impersonation and test funding do not establish production uptime, authentic future-pool configuration or perpetual reward availability. Operating mainnet gates remain disabled.
