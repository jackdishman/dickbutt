# Aerodrome basic volatile vAMM setup

Current local candidate: **DICKBUTT/SPCXc basic volatile vAMM**, represented by ERC-20 LP tokens. `AerodromeVammHarvester` holds those LP tokens unstaked and calls the pool's `claimFees()`. No NFT ID is needed. This candidate is not deployed or cleared for production; the security review has unresolved operating findings.

## Fee behavior

- The harvester earns only the fee share belonging to the LP tokens it holds. Other liquidity providers keep their shares.
- Claiming does not withdraw liquidity or consume LP tokens. Every DICKBUTT fee token goes to the burn address; every SPCXc fee token goes to the distributor. KC and CDB retain their existing allocations from the Clanker/legacy path.
- Fees earned before the LP transfer remain claimable by the previous holder. Transferring LP ownership does not transfer those past fee entitlements.
- Later LP contributions are possible. They inherit the same lock and give the contributor no withdrawal right. Sending raw DICKBUTT or SPCXc to the harvester does not add liquidity; those balances are routed on harvest.
- Keep LP tokens **unstaked**. The harvester has no gauge staking, approval or liquidity-removal function. It receives no AERO gauge emissions through this design.
- The owner may transfer LP tokens after the chosen unlock timestamp. `lockForever()` permanently removes that ability, including for the Safe owner. Fee claims continue. Rescue cannot transfer LP, DICKBUTT or SPCXc.

## Steps, with deployment still pending

1. Create or locate the actual DICKBUTT/SPCXc **basic volatile** pool on Base. Verify both token addresses, initial price and amounts before adding liquidity. A DICKBUTT/WETH pool is a different pair and cannot be substituted.
2. Keep the ERC-20 LP tokens in your wallet. Record the pool link/address and the wallet holding the LP; no private key or recovery phrase is needed for inspection.
3. Record `rewardsPool.kind = "vamm"`, the canonical basic factory `0x420DD381b31aEf6683db6B902084cB0FFECe40Da`, actual `pool`, `lpOwner`, `stable = false`, `staking = "unstaked"` and expected `swapFeeBps` in `config/base-mainnet.json`. The carried-over intended 0.3% fee is **30 basis points**, not Slipstream's 3000-unit notation. Verify the actual fee; upstream governance can change it.
4. Run read-only preflight and a local fork test against that actual pool. Check registry membership, both tokens, reserves, positive unstaked wallet LP balance, fee economics, pool accounting and fee delivery. Add the actual pool to calculator exclusions.
5. Complete the security review, production settings, wallet checks and bot readiness. Review the unsigned deployment plan. The selected deployment must name `AerodromeVammHarvester(factory, pool, dickbutt, spcxc, burnAddress, distributor, unlockTime, minInterval, owner)`.
6. After deployment is authorized and confirmed, verify the deployed code and immutable values and have the Safe accept administrative ownership. Record the **new production vAMM harvester address** from the deployment manifest and receipt. No existing test address is a substitute.
7. Only after the preceding checks, transfer the agreed ERC-20 LP amount to that verified harvester address. Check its received balance and fee routing. An ERC-20 transfer has no receiver hook: sending LP to the wrong contract can strand it. Never send it to the NFT adapter, distributor, burn address or this assistant.
8. Rehearse the separate Clanker locker and legacy creator-authority handoffs. They are not part of the LP transfer. Existing verified legacy safes may be claimed by their current creator before handoff or by the adapter afterwards; the adapter's creator handoff is permanent in the current design.
9. Start the reviewed, gas-funded operating services only after the runtime launch gates are intentionally addressed. The selected payout period remains six hours with no extra review wait. A funded working bot, sufficient rewards and successful transactions are required; a contract does not wake itself up.

## Evidence and limits

`test/NativeVammFork.t.sol` uses the actual Base Aerodrome factory/pool and token implementations in a disposable local Base-native fork. It creates/funds a test pool locally, simulates trades in both directions, claims across three six-hour time advances, routes fees, pushes a committed reward to a test holder, checks LP conservation, verifies prior-holder fees and later LP additions, and tests lock behavior. It uses locally impersonated accounts and a constructed one-holder reward root; it does not prove live wallet access, production pool identity, TWAB eligibility, live scheduling or permanent availability.

`test/VammHarvester.t.sol` covers token order, invalid pools, atomic reverts, LP protection, governance, timing and final fees after withdrawal. The application preflight, deployer and runtime manifest select the vAMM adapter explicitly. Historical rehearsal and Sepolia manifests still select the NFT adapter and do not become vAMM test evidence.

The separate WETH → USDC → SPCXc swap route continues to use its verified Slipstream pools. Choosing a vAMM rewards pool does not change that route.

Official accounting: [Aerodrome Pool.sol](https://github.com/aerodrome-finance/contracts/blob/main/contracts/Pool.sol) (`claimFees`, transfer accounting) and [PoolFactory.sol](https://github.com/aerodrome-finance/contracts/blob/main/contracts/factories/PoolFactory.sol) (registry and fee settings). Historical concentrated-position setup is preserved in [the earlier Slipstream document](docs/AERODROME-SLIPSTREAM-HISTORICAL.md).
