# Rewards calculator

Run `npm run calculate` after configuring the environment. `WEIGHTING=linear`
is recommended because splitting one balance across addresses does not increase
its aggregate weight (ignoring threshold eligibility and integer dust).
`WEIGHTING=sqrt` preserves the earlier proposed economics but rewards address
splitting: 100 units split into two 50-unit wallets has weight 14 rather than
10. Neither curve establishes unique human identity. The calculator requires
an explicit choice and includes it in its configuration hash. It refuses a
configuration change against an existing journal; changing economics requires
an audited migration, never deleting state and recalculating old income.

`FINALITY_TAG` defaults to `finalized`. `safe` is an explicit weaker-finality
opt-in. Unsupported tags, missing archive data, RPC errors, mismatched roots,
inconsistent payments, insolvency and changed snapshot hashes abort the run.
There is no confirmation-count or latest fallback. Contract reads and payment
queries use the same selected block number. Transfer queries stop at that
block. An earlier period's final block timestamp is the next period's start,
so the time between adjacent blocks is not dropped.

`CALCULATOR_DATA_DIR` defaults to the current directory. The authoritative
output is `periods/00000001.json`, then sequential immutable journal files.
Each contains a hash of its predecessor, snapshot block/hash/finality, period
times, configuration/hash, starting accrual, reconciliation credits, new
shares, payout deductions, ending accrual, balances, local reservations, and
all round plans. `record.plan` contains the Merkle root, decimal-string round
ID and total, payouts, tree dump and execution batches. Zero-payout periods
have a null plan and still commit all accounting. No transaction is broadcast.

The snapshot's available balance already excludes proposed pending and active
rounds. Unproposed local plans additionally reserve their full amount locally.
The calculator refuses to reuse their next round ID until the matching plan is
visible at the selected finality boundary. Closed or cancelled matching rounds
credit only unpaid recipients, once. Paid event amounts and their sum must
match the plan and on-chain distributed amount. Unknown or altered commitments
require investigation rather than silently releasing their local obligation.

## Bootstrap

Balances must be rebuilt from the token's first block, so the first period would otherwise average every holder over the token's whole history. `node calculate-rewards.js --config … --bootstrap` commits the first period with balances and a zero pot: no shares, no plan, and the pot reappears untouched in the next period, which measures from the bootstrap boundary. It is refused once any period has been journaled. Whether round 1 should measure from launch or from genesis is a policy decision; the flag makes it an explicit one.

## Superseded plans

If a round id the calculator planned is taken on-chain by a root it did not produce, the run stops while that foreign round is pending or active. Once it is closed, `reconcile` marks the local plan `superseded`, returns every payout in it to accrual as a recredit, and the next plan carries them under the next free id. Nothing was ever paid against the local root, so this recredits exactly once. The cap logic leaves room under `maxProposableTotal()` for carried accrual when it can; when the carry alone reaches the cap, the plan exceeds the cap and the run fails loudly for the owner to raise it.

## Recovery

`node calculate-rewards.js rebuild-state` reconstructs `state.json` entirely
from the journal and requires no RPC or environment credentials. Normal runs
also rebuild from the journal; the state file is only a disposable cache.
Journal entries are atomically linked into place without overwriting history,
with file and directory fsync before updating that cache. An interrupted
uncommitted `.tmp` file is ignored. A crash after journal commit is recovered
without re-accruing the same period. Legacy state without journal is rejected
because it lacks the evidence needed for a trustworthy reconstruction.

The `.writer-lock` directory excludes simultaneous processes. Its `owner.json`
records PID, host and start time. A killed process leaves this lock in place;
**stop all calculator processes and verify the recorded owner is dead before
removing a stale lock directory**. The calculator never automatically steals a
lock based on age or PID reuse. Then run `rebuild-state`. Keep independent
backups of the complete `periods` directory: hashes detect changes and internal
gaps but cannot recover a deleted journal or prove a truncated tail existed.

## Module API and tests

- `core.js`: `computeTWAB(startBalances, transfers, timestampMap, startTs,
  endTs, excluded)`, `computeShares(twab, thresholdBigInt, potBigInt, curve)`,
  `bigIntSqrt`, `buildPlan(roundId, payouts, batchSize)`, `amounts`, `sum`.
  Amounts use bigint internally; address keys normalize to lowercase.
- `chain.js`: `selectBoundary(provider, tag)`, `scanEvents`, and transactional
  `reconcile(distributor, state, blockNumber, chunkSize)`.
- `journal.js`: `Journal.lock`, `append`, `entries`, `rebuild`, `cache`, `unlock`.
- `engine.js`: `runCalculator({dir, provider, token, distributor, config,
  bootstrap, rewardTokenFactory})`. The optional token factory enables isolated tests;
  production uses an ethers contract. Config includes `chainId`, `token`,
  `distributor`, `deployBlock`, raw holder/payout thresholds, `curve`,
  `excluded`, `batchSize`, `chunkSize`, and `finalityTag`.

Run `node --test calculator/test/*.test.js`. Tests include snapshot skew at
N/N+20/N+22, huge round IDs, partial/cancelled settlement, RPC failures,
commitment/payment mismatches, process races, crash recovery, replay,
threshold/dust conservation, address casing, mint/burn/self transfers, exact
time boundaries, and 100 deterministic histories checked against a discrete
TWAB reference.
