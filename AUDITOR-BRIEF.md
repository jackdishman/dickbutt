# Review brief: rehearsal architecture

Review the active sources under `src/`, the calculator, keeper and fee-cycle tools. This is an implementation needing independent review, not an externally audited production system. Previous statements that the repository had never compiled were stale. Tests and the local rehearsal are described in [docs/REHEARSAL.md](docs/REHEARSAL.md).

## Current scope

Clanker locker collections and legacy token-side returned fees feed `SplitsFeeRouter`. It creates genuine immutable upstream Splits for DICKBUTT 10/90 and WETH 10/10/80. The WETH allocation reaches `SpcxcSwapExecutor`; SPCXc reaches the existing committed push distributor. An unstaked full-range 0.3% concentrated DICKBUTT/SPCXc position independently burns DICKBUTT fees and forwards SPCXc fees. The calculator creates finalized journal plans; the keeper verifies and executes them.

`FeeSplitter.sol` and its old integration tests remain regression coverage for the previous custom splitter, not the new deployment path. Root-level Solidity copies are historical duplicates; Foundry uses `src/`.

## Trust and authority

- A proposer (bot key, or the owner implicitly) can propose arbitrary Merkle roots. The contract enforces proof membership, solvency, a per-round share cap, a proposal rate limit and a guardian pause -- not fair allocation or holder eligibility. A stolen proposer key cannot move tokens: payment is keeper-gated and the keeper rejects any root absent from its own journal. The 24-hour timelock and the guardian only help if somebody is alerted and acts. Exclusions, weighting and thresholds remain off-chain policy.
- The share cap is also an economics decision: below 100% it permanently defers part of each pot. Review `maxRoundBps` against the intended payout schedule, and review the calculator's cap handling, which bounds new shares and fails loudly when carry exceeds the cap.
- The swap owner refreshes a positive floor expiring within one day. It is not an oracle and can be stale even before expiry. A keeper can tighten the floor but cannot weaken it. A compromised owner may set a harmful floor; a missing owner refresh stops swaps.
- Harvest destinations can be timelocked/frozen. Freezing them does not remove distributor, token issuer, upstream Safe or swap dependencies.
- The legacy adapter's module, token, destination and Safe list are immutable. Assigning it creator authority is permanent because it has no relay to update the creator. Review migration/recovery policy and future-sink risk **before production assignment**. Rehearsal does not imply approval of this permanent choice.
- Safe owners can disable the legacy module. The creator role does not control the Safe or WETH fees. Locker ownership and legacy creator identity are separate handoffs.
- Native B20 SPCXc may be paused or policy-restricted by its issuer. Test behavior with Base's native implementation. Never replace its bytecode with a mock and report the result as native compatibility.

## Specific review targets

1. Splits factory authenticity, clone bindings, immutable config hash, recipient order/allocations, zero incentive, and Warehouse/direct balances. Constructor introspection cannot authenticate a malicious factory supplied by the deployer. Use the recorded official address and code evidence.
2. Dust retention and atomic fee distributions. The fee Split can revert on one blocked recipient; the rewards distributor instead catches individual recipient transfer failures. Unexpected tokens sent to the narrow router cannot be recovered.
3. Swap path generation, two-hop signed tick spacings, actual output/input deltas, temporary allowances, amount cap, floor rounding, deadlines and keeper authorization. Fee allocation happens once, in Splits.
4. Pending/active reservations, partial payments, early close/cancel reconciliation, duplicate recipients, forged roots and cross-round replay. Also the proposer/guardian split: share-cap arithmetic against unreserved balance, rate limiting that a cancellation must not refund, pause that never strands committed rounds, and role authorisation boundaries.
5. Calculator event completeness, finalized-boundary consistency, eligibility start time, mint/burn accounting, journal hash/config verification, backup and truncation limits, and explicit weighting. Linear is rehearsal policy; square-root allocations are Sybilable.
6. Keeper signer locks, unknown transaction handling, proof/config rebuilding, on-chain commitments and snapshot hashes, timelock checks, retry without double payment, and no automatic early closure. A local lock cannot prevent independent machines from using the same key.
7. Aerodrome manager/pool/NFT identity, full-range ticks, effective 0.3% fee, changing fee modules, position share, unstaked fee/gauge assumptions and lock recovery. Check the real newly created pool; a mock position cannot establish its behavior.
8. Production recipients, funding, proposer workflow, source discovery and permanent custody changes. The rehearsal operating CLIs reject mainnet writes; do not remove that restriction without a separate production operating review.

## Evidence boundaries

Unit tests use mock tokens. Splits fork tests use genuine factory/implementation/Warehouse with mock assets. Legacy fork tests use actual Clanker module/Safes and locally moved actual DICKBUTT. Native token and swap tests use Base-compatible Foundry with actual SPCXc and the actual WETH/USDC/SPCXc route. The complete local rehearsal uses actual Splits and mock fee sources/assets/router to test orchestration, accounting and retries.

No public-testnet receipt or production deployment is implied by any of these tests. Production pool/position collection, complete real-fee-to-real-holder integration, independent review and operational readiness remain launch checks.
