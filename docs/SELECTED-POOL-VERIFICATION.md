# Selected Aerodrome pool and LP holder — 21 September 2026

This follow-up verifies the pool and wallet supplied by the owner after the September 20 audit. It does not deploy a production harvester, transfer assets/authority, select the production lock duration or enable mainnet bots. The September 20 audit and hash manifests remain snapshots of that earlier source; this update has its own evidence hashes.

## Recorded inputs

| Item | Verified value |
|---|---|
| Network | Base, chain ID 8453 |
| Rewards pool and ERC-20 LP token | `0xA044B7dD71993F47171A402dB8853c30A822f8D5` |
| Current LP-holder wallet | `0xDF3eFAfdA19D2dF229eF3fbEC73d2EE6C5fB6d7c` |
| Pool model | Basic volatile (`stable=false`), unstaked ERC-20 LP |
| Tokens | DICKBUTT `0x2D57C47BC5D2432FEEEdf2c9150162A9862D3cCf`; SPCXc `0xb2000000000000000000007b9fcbd005511aCBd5` |
| Canonical basic factory | `0x420DD381b31aEf6683db6B902084cB0FFECe40Da`; registered and discovered pair matches |
| Factory pause / swap fee | Not paused; 30 basis points (0.30%) at the snapshots |
| Transferable wallet LP balance | `4.286236718263509712` LP tokens, raw `4286236718263509712` |
| Total LP supply | raw `4286236718263510712`; 1,000 raw units more than the supplied wallet balance |

**The supplied wallet is the current LP holder, not the harvester or a bot wallet.** The intended administrator remains the recognized Safe. The newly deployed harvester will have a separate verified address; no production destination is supplied by this test.

Current configuration records only the selected pool and its LP holder, with the pool explicitly excluded from holder rewards. Pool reserve balances must not receive payouts as if they were an eligible person. No administrative or bot wallet assignment was changed.

## Read-only verification

At block **51612143**, hash `0x24391f0829dc33cfe015bc59533a10f8b6ef67f009067593c7179b895440e00d`, the public owner check confirmed the LP balance and that the same supplied wallet still held Clanker locker ownership and the separate legacy creator authority.

Deployment pool checks were independently run through the existing `inspectRewardPool`/`validatePoolFacts` code at **finalized block 51611693**, hash `0x2421172e4fc7bf340551e8de5362ed625bf02433e6e8f2124dc3fff6237e9fe1`. Pool identity, registration, nonzero reserves/supply, fee and positive unstaked wallet LP balance passed; exclusion validation passed. Missing proposer and floor-setter roles remain errors. This was pool-focused inspection, not a complete production launch preflight.

These snapshots can age. Recheck finalized state, balances, authority and fee settings immediately before deployment/handoff. Read-only JSON evidence is in [the selected-pool audit directory](../audit/2026-09-21-selected-pool/).

## Actual selected-pool simulation

`test/audit/SelectedVammPoolFork.t.sol` uses the actual existing public pool, actual LP balance and native tokens at block 51612143 in the Base-compatible local EVM. It does not create a replacement pool, mint replacement tokens or alter deployed token bytecode. Every impersonation, deployment, trade, authority acceptance, LP transfer and clock advance is confined to local fork state; no public transaction is broadcast.

**Three tests passed, zero failures/skips:**

1. Move the actual wallet LP balance to a locally deployed vAMM harvester; verify past DICKBUTT/SPCXc fees remain claimable by the old wallet. Claim those fees locally and verify the harvester LP principal stays unchanged.
2. Simulate trades and three six-hour fee/payout cycles. DICKBUTT fees reach the fixed burn address; SPCXc fees reach the distributor. Separate simulated proposer/keeper roles commit and pay a constructed one-holder root; a duplicate batch does not double-pay. Original LP principal remains exactly unchanged throughout.
3. Verify the old LP-holder wallet cannot withdraw from the harvester, the Safe cannot withdraw before the test unlock or bypass it through rescue, Safe withdrawal succeeds at unlock, and a separate local permanent-lock exercise blocks later withdrawal.

The one-year unlock and one-holder reward in this test are **test parameters**, not selected production economics. Safe acceptance is simulated by local impersonation; this is not proof that live Safe signers approved anything. The test does not run the actual multi-host six-hour scheduler or rebuild real holder eligibility; the earlier JS rehearsal covers calculator/keeper behavior separately.

Recorded simulated totals: `8999999999999997900246` raw DICKBUTT burned, `899991` raw SPCXc collected, `637493` raw SPCXc paid to the test holder (the 50% round cap retains a balance), and `4286236718263509712` raw LP principal preserved. These are local experiment results, not real distributions.

The wallet's already-earned fees at the fork snapshot were approximately **1,526,657.685143919416064459 DICKBUTT and 0.13757501 SPCXc**. They do not move automatically with an LP transfer. The local test proves the previous holder can still claim; no live claim was submitted and the current amount can change.

**29 targeted JavaScript configuration/deployment tests also passed**, zero failures/skips. The full September 20 suite was not rerun for this configuration-and-test-only follow-up. No production Solidity or fee-allocation logic changed.

## Reproduction and remaining launch work

```sh
FOUNDRY_BASE=true BASE_NATIVE_TESTS=true BASE_RPC_URL=<read-only-archive-rpc> \
  forge test --offline --match-contract SelectedVammPoolForkTest -vv
node --test operations/test/vamm.test.js operations/test/preflight.test.js \
  operations/test/mainnet-deploy.test.js operations/test/mainnet-driver.test.js
```

Use the pinned Base-compatible Foundry toolchain from the [audit report](../AUDIT_REPORT.md). A plain upstream EVM without Base native token support is insufficient. The source proof of the pool/authority configuration remains dependent on reliable RPC data.

Before deployment: finish proposer/floor-setter assignments, independently operated bot hosts, ETH funding and alerts; choose LP lock and swap/floor parameters; complete independent review and full finalized-state preflight; review the exact deployment plan. After deployment, verify code/destinations and Safe acceptance before any LP or Clanker/legacy handoff. The permanent legacy assignment and LP lock choices remain separate explicit decisions. Mainnet operating gates are unchanged and disabled.
