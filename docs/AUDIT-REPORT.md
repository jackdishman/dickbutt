# Audit-style implementation report

Critical: the finalized-boundary reconciliation bug is fixed and has a regression test. Merkle JS/Solidity encoding is fixed by the hardcoded vector suite.

High: pending and active obligations reserve one `totalReserved` balance; proposal, cancellation, payment, early close and insolvency invariants pass. Reward-funded gas was removed. Slipstream now uses signed tick-spacing multi-hop `exactInput`. NFT custody accepts only the configured position. Clanker release recovery is constrained to the configured manager and token ID after unlock.

Medium: keeper slippage is bounded by a required, expiring administrative price floor; this is an accepted operational risk because it is not an external oracle. The calculator uses an append-only hash-linked journal and explicit finalized/safe snapshots. Linear weighting is recommended; sqrt remains configurable and its Sybil effect is tested.

Low: public RPC endpoints can lack archive access and rate-limit fork requests. Fork tests therefore pin a block and require an RPC that serves it; optional live SPCXc/Aerodrome checks are explicit skips when no funded address is configured.

Informational: Foundry lint warnings about timestamp comparisons are expected for timelocks. SPCXc reports 8 decimals and uses B20 behavior; its local fork opcode compatibility is documented in the fork test.

Accepted risks: root correctness and exclusion policy remain off-chain governance decisions; the price floor depends on owner refresh; direct event scanning will eventually need an indexer at larger holder counts; no mainnet custody transfer is performed by this repository.

External assumptions: Clanker locker source, manager, token ID, unlock timestamp, DICKBUTT decimals/pool and protocol fee were read at the pinned Base block and recorded in `artifacts/base-inspection.json`. Aerodrome route candidates are live snapshot evidence, not a deployment authorization; re-quote and independently verify the selected generation immediately before deployment.
