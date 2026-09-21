# Independent final operations review — findings recorded before fixes

Reviewed candidate: `4a7e7a68d0ee3ac881214c77f8f82b3ca749a5de`.
Scope: operations, deployment/scheduler/monitor CLIs, vAMM wiring, console command paths. No live signing or transactions.

## OPS-M-01 — Rendered proposer calculates and reads different journals (Medium, high confidence)

**Files:** `operations/schedule.js:48-49`, `script/render-schedule.mjs:18,35-38`, `calculate-rewards.js:6`.

The calculator chooses `CALCULATOR_DATA_DIR || '.'`. The generated six-hour calculation command does not set that variable or pass a journal argument. The same command then invokes the proposer with `--journal ${JOURNAL}`, whose default is `./data`. A normal operator installing the supplied rendered schedule therefore writes `/srv/dickbutt/periods` but reads `/srv/dickbutt/data/periods`. Even `--journal /chosen/path` affects only readers. The minute retry continues reading the wrong directory. This causes indefinite reward proposal/payout interruption, without an attacker, unless the operator independently knows to set an undocumented matching environment value.

**Reproduction:** `test/audit/final-operations-schedule.test.mjs` executes the actual rendered proposer shell command against inert executable probes in a temporary directory, using the same calculator data-directory selection. It proves calculator writer path differs from the proposer path for the shipped defaults and that a stale inherited `CALCULATOR_DATA_DIR` defeats the renderer's explicit `--journal` selection. No RPC or wallets are used.

**Recommendation:** Bind the calculator output directory explicitly to the same `--journal` option as the proposer/keeper/monitor; preserve the selected path as one shell argument, including spaces. Add execution-based scheduler regressions.

## Review observations under investigation

- The console's generic rehearsal still invokes `npm run rehearse` without `--vamm`; direct audit/review evidence uses `--vamm`, but the console button still tests the historical NFT adapter. This should select the configured pool kind or expose an explicit choice.
- Deployment verifies hashes of artifact metadata sources and binds recovery to bytecode/input hashes. This protects stale builds and changed recovery inputs, but the artifact file/toolchain is still trusted: these checks do not independently prove its bytecode was compiled from that metadata.
- Mainnet fee/floor/keeper execution gates remain disabled. `deploy-mainnet --execute` exists and is distinct from these operating gates. Nothing in this review invokes it.

## OPS-L-01 — Console rehearsal silently tests the historical NFT branch (Low, high confidence)

**File:** `ui/commands.js:130-134`.

The console's only 'Full local rehearsal' action resolves to `npm run rehearse` without `--vamm`. The rehearsal script deliberately defaults to the historical NFT architecture unless `--vamm` is supplied. Thus a user operating the current vAMM configuration can click the console rehearsal, get a passing result, and incorrectly infer that the basic volatile adapter was exercised. This does not directly move production money or undermine the explicitly flagged CLI vAMM tests, but weakens launch validation and is particularly misleading after replacing NFT custody.

**Recommendation:** Expose the pool model explicitly in the rehearsal form, defaulting to the selected vAMM workflow and retaining historical Slipstream as an explicit option. Report/mock tests must identify the chosen model. No mainnet execution permission is affected.

## OPS-M-02 — Concurrent deployment invocations can overwrite one recovery ledger (Medium, high confidence)

**File:** `script/deploy-mainnet.mjs:140-179` (candidate line numbers).

The driver checks that `<manifest>.partial` is absent before awaiting the deployer balance and writing its initial ledger. There is no exclusive output-path or signer lock. Two invocations that overlap inside this awaited region both enter fresh deployment mode and both write the same partial file. Different deployer keys can overwrite each other's identity/progress; the same key adds nonce races. With actual deployable artifacts this can create orphaned contracts, consume gas and make interrupted-deployment recovery unreliable. A signer or operator concurrency mistake is required; no anonymous chain attacker or direct LP theft is demonstrated.

**Offline proof:** `test/audit/final-operations-deployment.test.mjs` uses the real driver and real ethers contract ABI reads through a no-socket fake provider. It starts two new deployments against one output path and delays each fake balance read. Both pass the absence check and write progress before the deliberately incomplete artifact prevents any signing. The provider supports only read calls and cannot broadcast; both keys are ephemeral and unfunded. Before-fix log shows both `deploy-start` events and two balance checks; expected exclusive-entry count is one.

**Recommendation:** Acquire an atomic output-path deployment lock before checking/reading the partial ledger; acquire a same-chain deployer lock before nonce-sensitive deployment execution. Check latest/pending nonce after locking and before starting a fresh deployment. Preserve locks on process crashes for explicit recovery; release in `finally` on ordinary failure. Do not automatically retry uncertain sends. The existing explicit mainnet execution flag and all operating mainnet gates must remain unchanged.

## Remediation and retest status

All three confirmed findings above are fixed locally, after their failing regressions were saved:

| Finding | Change | Evidence |
| --- | --- | --- |
| OPS-M-01 | The proposer command receives journal/config as quoted positional parameters, explicitly binds CALCULATOR_DATA_DIR to the selected journal, and ignores stale inherited data paths. Cron/systemd renderers preserve literal paths, dollar/percent semantics and spaces; control characters are rejected. | `operations-schedule-before-fix.log`, `operations-schedule-after-fix.log`; seven audit schedule cases including actual inert cron execution |
| OPS-L-01 | Console rehearsal shows an explicit model choice, defaults to basic volatile `--vamm`, and retains historical Slipstream explicitly. | `operations-console-before-fix.log`, `operations-console-after-fix.log`; two audit cases plus the existing command tests |
| OPS-M-02 | Canonical output-path lock and per-chain signer lock precede partial-file checks; pending/latest nonce checks run under both locks. Normal failure releases both. Pending nonces fail before new recovery-ledger creation. Crash locks require manual process/receipt reconciliation. | `operations-deployment-before-fix.log`, `operations-deployment-after-fix.log`; five audit cases including the real driver with an offline read-only provider |

The combined targeted run `operations-targeted-after-fix.log` passed **112 tests, zero failures/skips**: all operations tests, all 14 new operations-audit tests, and existing console command tests. Root-level complete suites and chain transaction rehearsals are separate evidence; this file does not count them.

Additional maintenance: corrected the production params template's unlock description from an LP NFT to `AerodromeVammHarvester`'s unstaked ERC-20 LP tokens. Runbook now explains shared journal binding; deployment runbook explains locking and pending-transaction reconciliation.

Changed production/config/docs files owned by this review:

- `operations/deployment-lock.js` (new)
- `operations/schedule.js`
- `script/deploy-mainnet.mjs`
- `script/render-schedule.mjs`
- `ui/commands.js`
- `config/params-mainnet.example.json`
- `docs/RUNBOOK.md`
- `docs/MAINNET-DEPLOY.md`

Separate new audit tests:

- `test/audit/final-operations-schedule.test.mjs`
- `test/audit/final-operations-console.test.mjs`
- `test/audit/final-operations-deployment.test.mjs`

## Reviewed surfaces and remaining assumptions

Manual review covered fee source handoff readiness, mined/unsent cooldown race reconciliation, legacy optional-error classification, receipt/marker semantics, dependent post-split block-tagged balance/quote reads, floor role separation/expiry/lower-bound/price-deviation behavior, monitor snapshot consistency/persisted round progress, schedule generation, roles/exclusions/constructor-argument order, vAMM factory/pair/LP-owner preflight, build metadata/source hashing and resume input binding, and console command/provenance/path restrictions.

Previously reported price-floor spot-quote dependence, irreversible legacy authority, unsupported taxed/rebasing/issuer-restricted rewards, monitor heartbeat absence, full-history replay growth, independently protected keeper code/config/RPC, and unselected future pool are still material limits. I did not discover an anonymous fee-redirection or LP-theft path in these JavaScript surfaces, but this is not proof of absence.

The source hash checks bind artifact metadata to source bytes; they trust the local compiler/artifact producer and are not an independent bytecode-to-source proof. Production artifact verification remains necessary. Deployment output locks and signer locks coordinate **one host only**; deployment keys must not be shared across hosts. Explicit `--resume` still requires receipts/nonce reconciliation after a crash or ambiguous broadcast. No fake-provider test here signed a transaction or connected to a public RPC.

The renderer tests execute cron command text using inert Node/npm probes, not a installed long-running scheduler. Systemd quoting was checked against its [official service command-line specification](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.service.xml), with serialization regressions; no Linux systemd daemon is available on this Mac. Production systemd/cron installation, independent journal replication, alert delivery, gas replenishment and uptime must still be rehearsed on their actual hosts.

Fee, floor and keeper Base-mainnet execution gates remain blocked. The deployer's existing `--execute` capability was not enabled or invoked against a real provider. Automated six-hour reward attempts require a running funded system, available fees, correct finalized history and healthy upstream services; no test establishes seamless operation forever.

### Independent remediation review

A final quotation review reproduced one unusual Cronie/Vixie case: a literal backslash immediately
before a percent sign in a selected path can cause cron's preprocessing to truncate the command,
even when shell quoting is correct. The renderer now explicitly rejects backslashes in cron paths;
systemd retains literal backslash support. This is a narrow supported-path restriction, covered by
an additional regression, based on the [official Cronie parser](https://raw.githubusercontent.com/cronie-crond/cronie/master/src/do_command.c).
The new operations-audit count is now 15 (8 schedule, 5 deployment, 2 console).

Lock re-review found ordinary-error release, partially acquired lock cleanup and canonical directory
alias protection consistent with the documented model. Deployment lock names differ from keeper and
floor locks; this is supported by mandatory deployer isolation from every configured production role.
Sharing that key with another host or a differently configured application remains outside local
locking protection. No additional confirmed exploit emerged from this remediation review.

Final complete JavaScript/application audit run after all remediation: **238 passed, 0 failed,
0 skipped**, 44.3 seconds, recorded in `evidence/final-js.log`. It includes the independent
accounting/keeper remediations in addition to this operations review. `git diff --check` also passed.
