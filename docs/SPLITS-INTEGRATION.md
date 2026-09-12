# Splits fee integration

`SplitsFeeRouter` creates two genuine PushSplit V2.2 clones through the official Base factory. It forwards DICKBUTT and WETH to their designated clones; the upstream contracts calculate and transfer the allocations. There is no copied splitting implementation in this repository.

| Fee token | Immutable recipient allocations |
| --- | --- |
| DICKBUTT | 10% KC Green, 90% burn address |
| WETH | 10% KC Green, 10% CDB vault, 80% swap executor |

The swap executor receives the entire 80% allocation and swaps it to SPCXc for the fixed rewards distributor. It does not charge another percentage. Splits is used for the **fan-out only**; the swap is a separate contract because Splits' own Swapper prices through Uniswap V3 and Chainlink, while this route is Aerodrome Slipstream into a Base B20 token. [Why](GOVERNANCE.md#why-splits-handles-the-fan-out-but-not-the-swap). Sending tokens to the burn address transfers them out of circulation at that address; it does not invoke a token supply burn function.

## Protocol identity

The pinned [official deployment manifest](https://github.com/0xSplits/splits-contracts-monorepo/blob/09523d2a5d594f9ee8783faf147caa3c414230dd/packages/splits-v2/deployments/8453.json) identifies Base factory `0x8E8eB0cC6AE34A38B67D5Cf91ACa38f60bc3Ecf4` and Warehouse `0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8`. At fork block 51,218,068 the factory's `SPLIT_WALLET_IMPLEMENTATION()` returns `0x1e2086A7e84a32482ac03000D56925F607CCB708`. These are recorded in [config/splits.json](../config/splits.json).

At construction, the adapter checks contract code, distinct tokens and recipients, executor WETH identity, implementation-to-factory binding, and each clone's factory binding, configuration hash and zero owner. Both clones have zero distribution incentive and zero owner, which fixes their recipients and prevents owner updates. The adapter has no owner, rescue method or arbitrary token routing method. The constructor accepts a factory address, so deployment must supply the independently verified factory; a malicious factory cannot be authenticated merely by asking it for its own getters.

Use `splitDickbutt()` and `splitWeth()` to forward adapter balances and distribute any balances already at the correct clone or its Warehouse account. Anyone may call these methods. Upstream clones accept arbitrary token addresses, so fee sources must target the adapter and operators must use the intended clone for direct deposits. Unsupported tokens accidentally sent to the adapter remain stranded.

## Rounding and failure behavior

The upstream [PushSplit implementation](https://github.com/0xSplits/splits-contracts-monorepo/blob/09523d2a5d594f9ee8783faf147caa3c414230dd/packages/splits-v2/src/splitters/push/PushSplit.sol) retains one raw token unit in each nonempty Split and Warehouse balance before allocating. Each recipient amount rounds down independently; residual dust stays at the Split. Future distributions include that dust except the retained unit. For a previously empty Split:

| Input, raw units | KC Green | Burn / CDB | Swap executor | Split dust |
| --- | ---: | ---: | ---: | ---: |
| 2,100 DICKBUTT | 209 | 1,889 burn | — | 2 |
| 1,000 WETH | 99 | 99 CDB | 799 | 3 |

An empty or reserve-only route safely returns without requesting zero-value transfers. Warehouse-only balances above the retained unit remain distributable. For a nonempty distribution, upstream ERC20 transfers are atomic: a blocked recipient causes the whole call to revert, including the adapter's forwarding transfer. No fee funds move until that condition is resolved. This differs from the rewards distributor, whose recipient failures are individually retryable. Fee-routing and swap gas are funded externally.

## Swap executor controls

`SpcxcSwapExecutor` fixes WETH, SPCXc, the Slipstream router, rewards distributor and two-hop route at deployment. The path encodes signed `int24` tick spacings, not Uniswap fee tiers. Verify the route and router generation against [base-mainnet.json](../config/base-mainnet.json) and a fresh quote before deployment.

Only approved keepers can call `processWeth(minOut, deadline)`. The owner configures a positive per-call cap, cooldown and a positive price floor expiring within one day. The effective minimum is the greater of the keeper minimum and the rounded-up owner floor. `minSpcxcPerWeth` means raw SPCXc units per `1e18` raw WETH units; use SPCXc's actual decimals when computing it. The floor is an administrative limit, not an oracle. An expired floor halts swaps until refreshed.

Each call spends at most its cap, approves only that amount, clears the approval afterward, and checks the actual SPCXc increase at the fixed distributor and exact WETH decrease. A router's claimed output alone is insufficient. Reverts roll back token movements and cooldown state. Standard non-rebasing tokens without transfer fees are assumed. The owner cannot rescue WETH or SPCXc; accidental SPCXc can only be forwarded to the distributor. Other tokens and forcibly sent ETH have owner recovery methods. The owner can update limits, floor and keeper permissions and transfers ownership through the two-step process.

## Verification

```sh
# Uses genuine Base factory, implementation, clones and Warehouse, with mock ERC20s.
BASE_RPC_URL=https://mainnet.base.org ~/.foundry/bin/forge test --match-contract SplitsBaseForkTest -vv

# Executor protections with mock router and tokens.
~/.foundry/bin/forge test --match-contract SwapExecutorTest -vv
```

The Splits suite is pinned to Base block 51,218,068 and skips when `BASE_RPC_URL` is absent. It covers clone identity and immutable settings, token-specific routing, direct and Warehouse balances, reserve-only no-ops, recipient-failure rollback, invalid configurations and fuzzed rounding/conservation. The executor suite covers caps, cooldowns, floor expiry and rounding, strict keeper minima, exact spend/output accounting, allowance cleanup and access controls. These two suites alone do not establish live SPCXc transfer-policy compatibility or executable swap liquidity; use the separate real-token fork tests and the complete local rehearsal for those checks. These commands execute against local fork state and do not broadcast transactions.
