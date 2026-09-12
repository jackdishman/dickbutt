# Implementation and evidence plan

Scope: preserve the four contract roles and push distribution. No mainnet broadcasts or live custody changes.

1. Establish pinned Solidity 0.8.24 / OpenZeppelin 5.0.2 and JS dependencies. Compile the prototype, then reproduce reservation and mutable threshold failures in executable tests.
2. Reserve pending plus active obligations. Preserve proof encoding and retryable self-call transfers; test lifecycle, overspend rollback, authorization, and stateful conservation.
3. Remove reward-funded gas. Verify Slipstream interfaces and configure the route separately. Add a protocol price floor with expiry, then exercise swaps, caps, rounding, allowances and access controls.
4. Test and constrain NFT custody, destination timelocks/freezes and lock timestamps. Research live Clanker release guards before implementing recovery.
5. Extract calculator math, chain snapshot selection, reconciliation and persistence. Require explicit weighting policy. Reproduce confirmed-boundary double credit, then pin every read to one finalized snapshot.
6. Add immutable journal records, transactional publication and exclusive writer locking. Replay and verify accrual from journal; test concurrent runs and interrupted writes.
7. Commit JS Merkle fixtures and verify the same values/proofs in Solidity, including negative encodings.
8. Resolve Base deployment generations, locker metadata, token semantics and route liquidity with read-only RPC/source evidence. Add fork tests that never broadcast and explicitly fail when required configuration is absent.
9. Run a complete mock cycle locally and provide a Sepolia-only deployment/operation path. Separate locally executed evidence from public-testnet evidence.
10. Update audit issue statuses and deployment checklist against actual test output. Save forge build, forge test -vvv and npm test logs. Do not mark unexecuted fork or testnet checks complete.

Economic decision: require an explicit linear or sqrt setting; recommend linear, with threshold and integer rounding caveats. No silent policy migration.

Persistence design: one immutable period record is the commit point. Derived state and batch files are recoverable caches. Records include prior state digest, configuration, snapshot hash, accrual movements, selected payouts and round commitments. Pending locally prepared plans must remain reserved until confirmed lifecycle evidence permits release.
