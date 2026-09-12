# Fee flywheel rehearsal implementation plan

> Use parallel bounded tasks for the independent protocol integrations and keeper; integrate and review the whole flow afterward.

**Goal:** Prepare and execute a reproducible local deployment rehearsal of the corrected fee flow.

**Architecture:** Immutable protocol Splits distribute each fee token; a narrow executor swaps the WETH allocation. Locker, Aerodrome and legacy adapters feed the pipeline; a journal-driven keeper delivers committed rewards.

**Tech stack:** Solidity 0.8.24, OpenZeppelin 5.0.2, Foundry, Node/ethers 6.13.4, official deployed Splits V2 contracts.

**Spec:** ../specs/2026-09-12-rehearsal-design.md

## Constraints

- Keep the existing isolated Conductor branch; no mainnet transactions or custody changes.
- Verify external ABI/deployment facts from official sources and read-only RPC.
- Keep calculator accounting and keeper/owner authority explicit.
- Execution CLIs for this work only allow chain IDs 31337 and 84532; local impersonation remains on a local fork.
- Label mock, actual fork, and public testnet evidence separately.

## Tasks

- [ ] 1. Implement legacy adapter and tests from verified fee-sink ABI. Test permissionless fixed-target claim, creator authority, wrong source rejection and repeat claims. Document ownership handoff separately from the Clanker locker.
- [ ] 2. Implement Splits routing and swap executor with tests. Create real immutable PushSplit contracts through official factory, validate 10/90 and 10/10/80 distribution, dust behavior, access controls, price floor, deadline and cap. Add actual factory fork coverage.
- [ ] 3. Implement keeper with test-first journal/root/config validation, dry-run and chain guards, timelock handling, receipt waits, restart/partial failure behavior and fully-paid-only closure.
- [ ] 4. Add a disposable local rehearsal that deploys the new architecture, harvests all sources, swaps, calculates a journal plan, proposes/activates/pays through keeper, retries a failed recipient and verifies no double payment. Save structured evidence. Add read-only production pool/configuration preflight and explicit configuration templates.
- [ ] 5. Rewrite stale README/start/setup/auditor docs around approved choices and actual evidence. Clearly explain legacy fee returns, 0.3% concentrated routing intent, continuing governance and exact rehearsal steps.
- [ ] 6. Run JavaScript and Solidity suites, actual protocol fork checks and complete local rehearsal; independently review the integrated diff, resolve material findings and record remaining external prerequisites.

Validation commands: `npm test`, `forge test`, `BASE_RPC_URL=... forge test --match-contract SplitsForkTest`, `npm run rehearse`, and `npm run preflight -- --config config/base-mainnet.json`. Concrete APIs and execution evidence are recorded with each implementation and in docs/REHEARSAL.md.
