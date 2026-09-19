# Compiler and dependency applicability follow-up — 20 September 2026

This is a bounded code/applicability review, **not a compiler correctness proof, an upstream protocol audit, or deployment approval**. No compiler/package was upgraded and no production code changed during this follow-up.

## Inputs and reproducible structure evidence

Inspected the parent's final production build `compiler-build-info.json.gz (decompressed original 859b4de5a6e1b8f3.json)`, containing 33 Solidity sources. Settings in the compiler input and contract metadata agree: **solc 0.8.24, viaIR=true, optimizer enabled with 200 runs, Cancun**, default optimizer sequence, no linked external libraries. The source-to-structure evidence and build SHA-256 are in `compiler-structure-evidence.json`; `inspect-compiler-input.mjs` recreates that evidence from repository root.

The fresh official [per-version bug database](https://raw.githubusercontent.com/ethereum/solidity/develop/docs/bugs_by_version.json) identifies four entries for 0.8.24. The [official bug descriptions](https://docs.soliditylang.org/en/latest/bugs.html) distinguish triggering pipeline/constructs. The table below summarizes the conditions and this repository's independently inspected applicability.

| Entry | Relevant condition | Application evidence and conclusion |
|---|---|---|
| SOL-2026-5, memory byte-element deletion | Legacy pipeline only | Actual build uses viaIR. No application memory-byte deletion found. Condition not met. |
| SOL-2026-4, spill-slot collision | Mutual internal recursion with memory spill interactions | Direct declaration-reference graph of 247 implemented functions/modifiers has no cycles. Manual virtual/super ownership dispatch is acyclic; no internal function-pointer dispatch or recursive data types were found in production. No triggering recursion identified. |
| SOL-2026-2, unsound recursive spill | Intersecting mutual-recursion cycles | Same graph/manual observations; no triggering cycles identified. |
| SOL-2025-1, storage-array wraparound | An affected array operation crosses the storage address boundary | Standard sequential layouts and short, fixed-construction dynamic arrays; exact base-slot checks below show no boundary crossing. Condition not met. |

The newer named-error require, custom-layout inheritance and transient-clear entries begin after 0.8.24. They do not enter the official version-specific set. No custom layout or transient storage exists in the production input. Older listed fixed bugs were repaired before this pinned compiler version. Compiler upgrades still require rebuilding and rerunning the reviewed configuration; these observations do not imply all unknown compiler defects are impossible.

## Storage layout checks

Read the compiler-generated `storageLayout` for each of the six deployed contracts, including inherited fields and packed offsets:

| Contract | Static slots | Relevant layout |
|---|---|---|
| AerodromeVammHarvester | 0–9 | Owner/pending owner/guard in 0/1/2; destination/locks/timestamps thereafter; no arrays |
| DickbuttRewardsDistributor | 0–15 | Mapping roots in 4/5/7/10/11, guardian and pause flag packed in 12, fixed-size round structs; no storage arrays |
| LegacyFeeHarvester | 0–1 | Guard then constructor-only `feeSafes`; length constrained to 1–8 |
| LockerHarvester | 0–7 | Destination and lock flag packed in slot 3; no arrays |
| SpcxcSwapExecutor | 0–12 | Constructor-only 66-byte swap path in slot 3, ordinary role mappings; no path mutator |
| SplitsFeeRouter | 0 | Guard only; recipients, assets and split identities are immutable |

The legacy array data begins at `keccak256(uint256(1)) = 0xb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf6`; at most eight element slots are used. The swap path data begins at `keccak256(uint256(3)) = 0xc2575a0e9e593c00f959f8c92f12db2869c3395a3b0502d05e2516446f71f85b`; three data slots suffice. Neither is near wraparound. There is no assembly storage relocation, giant static array, custom layout or application proxy implementation/storage collision surface.

## Internal calls, assembly and delegatecall

The AST graph includes referenced internal function calls and modifier edges; external calls are excluded because they execute in separate EVM frames. It is an adjunct to manual review, not a complete analysis of compiler-generated Yul or arbitrary virtual dispatch. Specifically checked the distributor → Ownable2Step → Ownable `_transferOwnership` super chain, SafeERC20 → Address call/revert helpers, Merkle hashing and Math's overloaded fixed-point functions. None introduces mutual internal recursion.

No application source contains inline assembly. Production-reachable imported assembly is limited to OpenZeppelin Math arithmetic, MerkleProof scratch-memory hashing and Address revert-data bubbling. Those blocks contain no custom Yul functions, so they do not add Yul recursion. ERC721/Strings assembly also appears in the broader 33-source build through rehearsal/historical support, not as a production-owned NFT implementation.

OpenZeppelin `Address` defines a `functionDelegateCall` helper, but no application path invokes it. Disassembly of each of the **six actual production runtime objects**, excluding CBOR metadata and PUSH immediate bytes, found **zero DELEGATECALL, CALLCODE or SELFDESTRUCT opcodes**. This verifies that a text match in an unused library does not create an application delegation surface. External Aerodrome/Splits clones have their own implementations and are outside that statement.

## Upstream dependency assumptions rechecked

- The fresh [verified legacy module source](https://base.blockscout.com/address/0x10F4485d6f90239B72c6A5eaD2F2320993D285E4?tab=contract), downloaded through the explorer's read-only API into `upstream-legacy-source.json`, reports `ClankerSafeErc20Spender`, fully verified, compiler 0.8.28 and no detected proxy. Its initialized token creator alone can replace itself or sweep that token from a Safe. The module owner can change the team spender; it has no general overwrite of an already initialized token creator. Safe execution uses `Enum.Operation.Call`, not DelegateCall. This confirms that handing DICKBUTT creator authority to our adapter is separate from locker ownership and effectively permanent because our adapter exposes no creator-update relay. The Safe's own governance can disable the module or move its assets; automatic legacy fees therefore cannot be promised forever.
- The upstream module checks Safe-call success but does not decode a token's returned Boolean. Our legacy adapter additionally requires a positive actual destination balance delta, so a no-op/false-return transfer cannot silently report zero fee collection as successful. Partial/taxed assets remain outside the configured standard-token assumption.
- Re-read the stored verified `artifacts/clanker-source.json`: fee collection is owner gated, while release sends the NFT to the current owner after vesting. This supports the corrected adapter comment that destination freeze does not revoke post-unlock position recovery. The snapshot is historical evidence; it is not a fresh on-chain ownership/state attestation.
- The [official Aerodrome Pool source](https://github.com/aerodrome-finance/contracts/blob/main/contracts/Pool.sol) books fees per LP holder and `claimFees` transfers the caller's booked entitlement through PoolFees. This supports unstaked LP custody and the harvester's fixed-recipient forwarding model. It does not validate an unprovided future pool address, guarantee trading volume, or establish that the current repository source equals every deployed factory implementation. The parent's pinned-state fork tests provide separate deployed-code evidence.

No new actionable compiler-trigger or dependency-authentication defect was established in this follow-up. Final deployment still requires verified code/state and parameters at the actual chosen addresses; inherited admin and third-party token/chain policies remain trust assumptions.
