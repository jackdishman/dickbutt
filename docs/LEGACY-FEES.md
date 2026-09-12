# Legacy Clanker returned fees

The verified locker takes **60% of both DICKBUTT and WETH** into its protocol Safe and sends 40% to the collection recipient. A separate legacy module lets the DICKBUTT creator recover the Safe's **DICKBUTT** balance. It does not grant the DICKBUTT creator authority over WETH. Thus, while the module remains enabled and claims succeed, the two paths can deliver effectively 100% of collected DICKBUTT and 40% of collected WETH to the fee pipeline. The locker ABI and arithmetic have not changed. “Sell-side fees returned” describes the separate token recovery path, not a one-sided locker fee exemption.

## Verified Base deployment

Read-only snapshot: block **51223062**, hash `0x9a906018f91c3cd1b603d3530b73b78019387049bb8a900b46c749141de4c99c`. Machine-readable evidence is [config/legacy-fees.json](../config/legacy-fees.json).

| Item | Address / observed value |
| --- | --- |
| Token | `0x2D57C47BC5D2432FEEEdf2c9150162A9862D3cCf` |
| Legacy module | `0x10F4485d6f90239B72c6A5eaD2F2320993D285E4` |
| Current Safe, adapter index 0 | `0x1eaf444ebDf6495C57aD52A04C61521bBf564ace` |
| Historical Safe, adapter index 1 | `0x04F6ef12a8B6c2346C8505eE4Cff71C43D2dd825` |
| Legacy `tokenCreator(DICKBUTT)` | `0xDF3eFAfdA19D2dF229eF3fbEC73d2EE6C5fB6d7c` |
| Locker `owner()` (separate read) | `0xDF3eFAfdA19D2dF229eF3fbEC73d2EE6C5fB6d7c` |
| Module `owner()` | `0xEea96d959963EaB488A3d4B7d5d347785cf1Eab8` |
| DICKBUTT `teamGrantedTokensMap` | `false` |
| Module enabled on both Safes | `true` |
| DICKBUTT balance, each Safe | `0` |

The current Safe is both the deployed locker's `_feeRecipient()` and the Safe in the [official SDK example](https://github.com/clanker-devco/clanker-sdk/blob/4f4d2bbf41c7f10543559dc043c85f443a6d452e/examples/legacy/legacyFeeClaimsBasic.ts). The historical Safe is evidenced by an actual [DICKBUTT legacy module claim](https://basescan.org/tx/0x7a5d764da96a870b387d7b49a3b094da32dbcdb41ca9f184140240d3622ea7ce). The indexed token-specific module claim history returned three records, involving these two Safes. This is evidence for the configured set, not a guarantee that another sink can never be introduced.

## Exact interfaces and authority

The adapter uses these deployed selectors:

```solidity
// ClankerSafeErc20Spender
function tokenCreator(address token) external view returns (address);
function tokenCreatorTransfer(address safe, address token, address recipient) external;

// Safe
function isModuleEnabled(address module) external view returns (bool);
```

The separate setup operations are:

```solidity
function initializeTokenCreator(address token, address newCreator, bytes32[] calldata proof) external;
function updateTokenCreator(address token, address newCreator) external;
function tokenCreatorRoot() external view returns (bytes32);
function teamGrantedTokensMap(address token) external view returns (bool);
```

These signatures and behavior were checked against the [official SDK](https://github.com/clanker-devco/clanker-sdk/blob/4f4d2bbf41c7f10543559dc043c85f443a6d452e/src/legacyFeeClaims/index.ts) and the [verified deployed module source](https://base.blockscout.com/address/0x10F4485d6f90239B72c6A5eaD2F2320993D285E4?tab=contract).

Initialization verifies `keccak256(bytes.concat(keccak256(abi.encode(token, msg.sender))))` against the root; the proof authorizes the submitting address, which may choose a different `newCreator`. Team-granted tokens cannot initialize. Only the stored token creator may subsequently update itself or claim. The module's owner does not acquire token-creator powers merely by being owner. Claims use Safe module execution and sweep the entire selected token balance, including earlier deposits. There is no claim amount, epoch, or persistent recipient setting. See the [deployed source](https://base.blockscout.com/address/0x10F4485d6f90239B72c6A5eaD2F2320993D285E4?tab=contract).

DICKBUTT is **already initialized**. Its existing creator must call `updateTokenCreator(DICKBUTT, adapter)` for an adapter handoff; transferring locker ownership does not do this. As a cross-check, the SDK creator CSV's DICKBUTT entry names the same creator, and rebuilding its StandardMerkleTree reproduced the live root `0xa7dcc91a2136ef1b3c708dbab901cbeb075f6df5cf5987494fedc340c57f7025`. No initialization proof is needed for the current state. The root is pinned once set, but `tokenCreator` can change through its authorized update function. [Creator dataset](https://github.com/clanker-devco/clanker-sdk/blob/4f4d2bbf41c7f10543559dc043c85f443a6d452e/src/legacyFeeClaims/data/token_creators_with_updates.csv).

Safe owners retain control of the upstream Safe, including module enablement and assets. The adapter cannot force Clanker to keep the module enabled or guarantee fee availability. It does not own a Safe or the global module.

## Adapter and pipeline

[LegacyFeeHarvester.sol](../src/LegacyFeeHarvester.sol) accepts `(feeModule, feeSafes[], token, destination)`. Deploy it with both Safes in the order above and the **same intended fee receiver** used for the locker path. The receiver may be the Splits-compatible intake contract; it must accept DICKBUTT and expose those funds to the downstream splitter. Configure the eventual receiver address explicitly, not the keeper's wallet.

Anyone may call `harvest()` for index 0 or `harvestFrom(1)` for the historical Safe. Each operation checks creator authority, skips an empty Safe, claims only DICKBUTT to the fixed destination, and reports the destination's actual balance increase. Calls cannot choose a token, recipient, or arbitrary external target. Failure on one Safe does not prevent calling the other independently. The immutable module/token/destination and constructor-only Safe list have no setters, ownership role, or arbitrary-call escape hatch.

Operational order:

1. Collect the locker through `LockerHarvester` to send its 40% share to the fee receiver and its 60% share to the current Safe.
2. Call legacy `harvest()`, then `harvestFrom(1)` when historical funds exist.
3. Execute the receiver's distribution/withdrawal operation and the existing fee conversion/reward accounting pipeline.

Legacy harvesting does not itself collect the NFT's uncollected fees. Previously claimed fees held by an EOA or another receiver cannot be reclaimed from the Safe; their holder must transfer them into the receiver separately. Existing Safe balances require no special backfill method. Do not count previously distributed fees again when booking pipeline deposits.

**Permanent handoff:** assigning this adapter as `tokenCreator` permanently fixes its destination and allowed Safes, because it exposes no `updateTokenCreator` relay. The included adapter is suitable for rehearsal of that explicit design. Before any production assignment, verify the complete sink list and final receiver, and decide whether migration/recovery controls are required. A future new Safe or receiver migration would otherwise be inaccessible through this adapter. Neither deployment nor handoff was performed on mainnet.

## Verification and rerun

```sh
node script/inspect-legacy.mjs
LEGACY_BLOCK=51223062 node script/inspect-legacy.mjs
forge test --match-contract LegacyFeesTest
BASE_RPC_URL=https://mainnet.base.org forge test --match-contract LegacyForkTest -vv
```

Inspection uses read-only RPC calls and prints JSON; it accepts `BASE_RPC_URL` and defaults to a finalized block. It does not update configuration files automatically. Revalidate module code, creator, Safe enablement, sink addresses and balances before using any stale snapshot.

Ten unit tests passed, including 256 fuzz runs for caller-independent destination, historic balances, two Safe claims, empty balances, invalid configuration, absent creator authority, module disablement, and failed recipient transfers. The real Base fork test passed using the deployed module, both real Safes, and actual DICKBUTT collected from the live locker. It funds the historical Safe from that local collection because the recorded live Safe balances are zero; then it impersonates the current creator only inside the fork and checks both exact claims, unchanged WETH, and independent locker ownership. Without `BASE_RPC_URL`, this fork suite is explicitly skipped. No mainnet claim, signature, or ownership change is part of these checks.
