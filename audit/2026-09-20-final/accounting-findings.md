# Independent final calculator and keeper review

Base reviewed: `4a7e7a68d0ee3ac881214c77f8f82b3ca749a5de`. Scope: calculator/core, engine, chain and journal; keeper engine/history verification; their CLIs and signer locking. All tests are local JavaScript simulations, with no network signing or production keys.

## F-M02 — Pending-nonce precheck occurs before signer-lock acquisition

**Severity:** Medium (operational availability/reconciliation). **Confidence:** High. **Status:** Fixed and regression-tested. The original proof was recorded before any production change.

`script/run-keeper.mjs` checks latest/pending transaction counts before `runKeeper` acquires the signer's process lock in `keeper/engine.js`. The keeper can then wait behind a fee job sharing that key. If the fee job broadcasts and its receipt wait times out, it releases the lock with the transaction still unresolved. The keeper acquires the lock but does not refresh the nonce check. Its own journal recovery marker does not cover the fee job's separately stored marker. It can consequently broadcast a new nonce while the earlier outcome is unknown, despite the intended fail-closed operational rule.

The demonstrated impact is queueing another transaction behind unresolved work and bypassing reconciliation, potentially prolonging stalls and complicating operator recovery. No token theft or duplicate paid claim is established: contract paid flags and nonce ordering still protect those separate properties. The scenario needs an overlapping scheduled job plus timeout/transport uncertainty; no privileged compromise is required.

**Proof before fix:** `test/audit/final-accounting.test.mjs`, test named `Final keeper nonce PoC`, simulates the exact permitted interleaving: successful CLI nonce precheck, a pending nonce appearing before entering the signer-locked engine, valid independent journal replay, then a proposal broadcast. It observes one send. The complete original PoC is preserved in `accounting-before-fix-poc.mjs.txt`; successful output is `accounting-nonce-before-fix.log`.

**Implemented fix:** `keeper/engine.js` performs fresh latest/pending nonce checks for every involved signer while all common execution locks are held, before journal verification or mutations. The provider method is mandatory (no silent bypass); invalid/negative/unsafe nonce values and RPC errors abort. The obsolete pre-lock-only check was removed from the CLI. The final regression shows no send and lock release when any signer has a pending nonce, permits a later run after resolution, verifies both proposer and keeper identities, and directly probes that both signer locks are held before either fresh nonce read. No production Solidity or transaction-execution network gate changed.

**Validation:** `accounting-final-tests.log`: **78 passed, 0 failed, 0 skipped**, covering all calculator/keeper suites and existing/new accounting operational audit regressions. Four final audit tests passed; `git diff --check` passed. Existing mock fixtures were updated only to provide the now-required zero pending/latest nonce response.

## Completed accounting evidence

`final-accounting.test.mjs` simulated 120 six-hour attempts: 92 committed earning periods, 28 pending-plan retries, 91 rounds and 93 independently replayed journal records. Every committed period checked exact holder balances, individual accrued/unpaid liabilities against cumulative earned-minus-paid amounts, funded-token conservation and solvency. The sequence includes partial payments, fully paid rounds, pending cancellation, early close, recredit, funding and holder transfers. Three initial new tests passed (`accounting-tests.log`, approximately 23 seconds).

Closed-round omitted/duplicated/wrong/out-of-bound logs fail without mutating state. Archive errors and removed events fail closed. Same-timestamp borrowed/transferred/self-transferred balances produce no extra holder-time or linear rewards.

## Remaining assumptions and limits

- A trusted archive RPC is an input authority: consistent fraudulent or silently omitted holder Transfer logs are not cryptographically verified against receipts, total supply or independent consensus. The independently controlled keeper must use independently controlled code/configuration and reliable archive data. Replay catches proposer journal falsification against that data, not compromise of the underlying data source.
- Full journal replay, repeated on each minute keeper invocation, is not bounded by a rolling trusted checkpoint. The 93-record mock replay passing does not establish production lifetime performance or uptime with thousands of holders and network latency.
- Eligibility is six-hour period TWAB, not a requirement to hold the threshold at every instant. Minimum payouts, proportional capped instalments, finality, pending work and scheduler failures can delay an individual's transfer. Missing schedules consolidate a longer period when resumed; they do not reconstruct wall-clock six-hour periods.
- The tests are not a formal proof, an external independent-auditor certification, or permission to enable production execution.
