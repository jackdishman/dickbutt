# Historical supplied handoff — not current validation

The text below was supplied with the original project. Its authorship, earlier review claims, PR history, wallet observations and test/deployment counts were not independently established by this task. See [the current complete report](../COMPLETE-DEVELOPER-REPORT.md) for work performed here.

Relative link targets in the historical body have been rebased for its archive directory; its substantive text is preserved.

---

# Handoff to Kevin

Written 2026-09-12 against `main` at `2aacb8a`, then updated the same day after the security findings below were fixed and re-audited. Jack builds; you hold the keys and make the design calls. This page tells you what exists, what it has been proven to do, what only you can unblock, and what still has to happen before real money flows.

Nothing here has touched Base mainnet. No contract is deployed there, no custody has moved, and every operating tool refuses to send a mainnet transaction. That gate stays until you say otherwise.

## Where it stands

| Layer | State | Evidence |
| --- | --- | --- |
| Contracts (`src/`) | Complete for the agreed design: Splits fan-out, Aerodrome swap executor with a bounded floor-setter role, three fee harvesters, push distributor with proposer/guardian bounds | 94 Foundry tests, invariant suite, fork tests against the real Clanker locker, legacy module and Splits factory |
| Off-chain (calculator, keeper, four bots, monitor, schedule) | Complete and exercised end to end, including recovery from a foreign round and a bootstrap period | 150 JS tests; local Base-fork rehearsal with eight stages |
| Public testnet | Redeployed with the fixed contracts from block 46743220: genuine Splits clones, every role verified live including the floor setter's limits, one full fee cycle done. A live round with the foreign-root recovery is running | [SEPOLIA.md](../SEPOLIA.md), `config/deployment-sepolia.json` |
| Control console | `npm run console` shows the flow, the checklist and runs the commands locally | [ui/README.md](../../ui/README.md) |
| Mainnet | Nothing deployed. No mainnet deploy script exists yet by design | `config/base-mainnet.json` holds the prerequisites |
| Independent review | Not started | [AUDITOR-BRIEF.md](../../AUDITOR-BRIEF.md) is the scope |

Three pull requests have merged. The repository is at parity with `origin/main`.

**Sepolia so far.** The first deployment's round 1 completed in full: 2.03 SPCXc paid 1:2 to two holders, reserve back to zero. That deployment is superseded by the redeploy with the fixed contracts, which has passed its role checks and a fee cycle live; its round results are recorded in [SEPOLIA.md](../SEPOLIA.md) as they land. `roundDelay` on Sepolia is 1 hour for observability and must be 24 hours before anyone reads its timing as representative.

## What only you can do

Every item below is a blocker that no code can close. The console's checklist tracks the same list and reads 5 blocked today.

### Addresses

| Slot | What it is | Status |
| --- | --- | --- |
| `deployment.owner` | The multisig. Owns the distributor and both harvesters. Commits nothing day to day; it exists to stop things | **null** |
| `deployment.proposer` | Bot key that calls `proposeRound`. Cannot move tokens | **null** |
| `deployment.guardian` | Leave null to inherit the owner multisig, or set a separate one | null (fine) |
| `deployment.keeper` | Hot key for `processWeth` and `distributeBatch` | `0xddF3C9…`, holds 0 ETH |
| `deployment.floorSetter` | Hot key on the ops host that refreshes the swap price floor. Can do nothing else on-chain and cannot go below the bound you set. Must be a different key from the keeper | **null** |
| `deployment.kcGreen` | Recorded and verified. Holds 1,000,000 DICKBUTT | done |
| `deployment.cdbVault` | Recorded. Never used on Base or Ethereum, no ETH on either | done, but see below |

**Prove control of the CDB vault key before anything deploys.** Both KC Green and the CDB vault become recipients of an immutable Split with no setter. A signed message or a dust transaction from `0xB58f2Ce0…` on Base is enough. Getting this wrong means redeploying the router and re-pointing every harvester.

**Fund the bot keys with ETH on Base.** Keeper, proposer, and the floor-setter (ops) key. An unfunded bot fails exactly like a dead one, silently.

### The rewards pool

Create and seed the 0.3% full-range DICKBUTT/SPCXc Slipstream position (tick spacing 200, unstaked, roughly $30k). Then fill `rewardsPool.pool` and `rewardsPool.tokenId`. This unblocks the only test of real Aerodrome fee collection anywhere in the repository. Setup steps are in [AERODROME-SETUP.md](../../AERODROME-SETUP.md).

### Three custody handoffs, all separate

1. **Locker ownership** to `LockerHarvester`. This is effectively permanent: the harvester has no function to hand the locker back, and the locker itself unlocks in 2100. What stays adjustable is where the fees go, behind a 7-day timelock.
2. **Legacy `tokenCreator`** to `LegacyFeeHarvester`. Permanent, and documented as such. The adapter cannot update the creator, change its destination, or add a Safe. Settle migration policy first. Claim any outstanding legacy fees before you hand this over.
3. **LP NFT** to `AerodromeFeeHarvester`. Only after the pool exists and its real fee collection has been tested.

Rehearse each on Sepolia or a fork before performing any on mainnet.

### Decisions

1. **Round 1 eligibility window.** The calculator must scan DICKBUTT from its genesis block to reconstruct balances, so without intervention the first period's time-weighted average covers the token's whole history. A wallet that bought 10M DICKBUTT last month averages far below the 6.9M threshold over two years and would be excluded from round 1. If you want round 1 to measure from launch instead, the calculator is run once with `--bootstrap` right after deployment: it commits balances with a zero pot and the first real round measures from there. Say which you want.
2. **The floor lower bound.** The floor-setter key is hot, so the multisig sets `floorLowerBound`, a price in SPCXc per WETH below which swaps halt rather than execute. Set it conservatively below market and revisit it rarely. If the market falls through it, swaps stop and the bot tells you; the multisig lowers the bound after looking.
3. **Share cap.** 50% per round, so about two rounds of inflow sits undistributed at steady state. Adjustable live with `setRoundLimits`. [GOVERNANCE.md](../GOVERNANCE.md) has the table.
4. **Weighting.** Linear is the rehearsal default and the recommendation. Square-root rewards splitting a balance across wallets.

## Security review, 2026-09-12

Jack reviewed every contract, bot and doc on `main`, fixed what he found the same day, and re-audited the result. The design's core claims hold: a stolen keeper key cannot redirect funds, a stolen proposer key cannot move tokens, undistributed SPCXc has no withdraw function, and the Splits clones are genuine and immutable. Below is what was found, what changed, and what remains for you.

### 1. The ops key could drain the WETH stream. Fixed.

The recorded plan gave the swap executor to a hot ops signer so the daily price-floor refresh would not need a multisig ceremony. But `setPriceFloor`, `setKeeper`, `setSwapLimits` and `transferOwnership` all sat behind that one `owner`. A compromised ops key could set the floor to one unit, approve itself as keeper, raise the cap, move the pool price, swap the whole WETH balance at that price and unwind. Eighty percent of all WETH fees pass through this contract.

**What changed.** The executor now has a `floorSetter` role that can call `setPriceFloor` and nothing else, and an owner-set `floorLowerBound` it cannot go below. No setter can be approved while that bound is zero. Keeper and floor setter are mutually exclusive on-chain, in both directions. The multisig owns the executor like everything else; the ops bot holds only the floor-setter key. The bot, the deploy script, the preflight, the monitor and the console all know the new role. **What remains for you:** provide the floor-setter address, and choose the lower bound.

### 2. A round-ID collision halted payouts with no recovery path. Fixed.

If a root this pipeline did not produce landed at the next round ID, the keeper refused to pay *every* round and the calculator threw on every later run, and there was no tool to recover.

**What changed.** The keeper now reports such a round as `foreign-commitment`, signs nothing for it, and keeps every other round moving. Once the guardian cancels the foreign round, the keeper reports `superseded` and the next calculator run recredits every recipient of the abandoned plan exactly once and re-plans them under the next free ID. The local rehearsal runs this whole sequence against a real distributor. The runbook has the procedure, including the one manual step: the recovery round usually needs the share cap lifted for one proposal.

### 3. The fee cycle was all-or-nothing across the three handoffs. Fixed.

`npm run fees` now checks each source's custody before touching it, skips any whose handoff has not happened, names it in `awaitingHandoff`, and still routes and swaps whatever has arrived. You can stage the rollout, and the permanent legacy handoff is no longer forced early.

### 4. The live DICKBUTT/WETH pool was missing from the exclusion list. Fixed.

The pool at `0x92d90f7f…` is recorded as `clankerPool` and listed in the required exclusions. `npm run preflight` now fails if any recorded pipeline address, the locker or its pool is absent from that list, so this class of omission cannot recur silently.

### 5. Round 1 would have measured holders over the token's whole history. Made explicit.

A `--bootstrap` calculator run commits the first period with a zero pot so the first real round measures from launch. It is refused once any period exists. Whether to use it is decision 1 above.

### 6. Journal distribution between hosts was unspecified. Documented.

The runbook now states the model: the proposer host is the only writer; keeper and monitor hosts pull read-only copies after each proposer run; no shared writable mount. A stale copy is safe and a torn one fails closed, both because the keeper verifies every plan against the chain and the journal's own hashes before signing. The docs also no longer count the journal as a third factor for theft: it takes the proposer key and the keeper key.

### Smaller items, all fixed

- The console no longer hands its session token to any local process; the token arrives only in the launch URL.
- `.context/` is in the repository's `.gitignore`.
- The distributor's `guardian` now follows an ownership transfer unless it was deliberately split out, so handing the contract to the multisig hands it the guardian role too.
- The stale root-level `.sol` copies are deleted. `FeeSplitter.sol` stays in `src/` as regression coverage for the old design and is clearly labelled as such.
- The payout job and the fee cycle wait up to five minutes for each other's lock instead of paging on every overlap.
- The monitor flags an unset floor lower bound, an executor that predates the role, and stops alarming on a foreign round once the guardian has cancelled it unpaid.

### Residual risks, by design

- A compromised floor setter can still drop the floor to your bound, or let it lapse and halt swaps. The bound is the limit of the damage; choose it accordingly.
- A compromised owner multisig can do anything except withdraw reward tokens. There is no higher authority.
- The price floor is a backstop, not an oracle. A stale but unexpired floor can permit a worse-than-market swap within the bound.
- The three custody handoffs are one-way. Nothing here makes them reversible.

## Launch sequence

In this order. Each step has a preflight or a test that confirms it.

1. Kevin: prove CDB key control. Fund the keeper, proposer and floor-setter keys. Provide the owner multisig, proposer and floor-setter addresses, and the floor lower bound.
2. Jack: redeploy to Sepolia with the fixed contracts and rerun the cycle, including a bootstrap pass. **Done 2026-09-12.**
3. Both: leave Sepolia running unattended for several days on the rendered schedule. This is the only proof the bots survive a weekend.
4. Kevin: create and seed the rewards pool. Record pool and token ID. Jack runs the real Aerodrome collection test.
5. External: independent contract review against [AUDITOR-BRIEF.md](../../AUDITOR-BRIEF.md).
6. Jack: write the mainnet deploy script. It does not exist and the Sepolia one refuses chain 8453.
7. Kevin: decide the round 1 eligibility window.
8. Deploy to mainnet with all bots in dry-run. Set the floor lower bound, then approve the floor setter. Run the bootstrap calculator pass if chosen.
9. Kevin: rehearse then perform the three handoffs, one at a time. The fee cycle names whichever sources are still waiting.
10. Jack: lift the mainnet execution gate as its own reviewed change. Start the schedule.
11. Kevin: rehearse the guardian path on mainnet once with a trivial round before anything depends on it.

## Do not yet

- Do not transfer locker ownership, creator authority or the LP NFT on mainnet. All three are one-way.
- Do not lift the chain-8453 gate in the CLIs.
- Do not read Sepolia timings as representative while `roundDelay` is 1 hour there.
- Do not put the keeper key and the ops key on the same machine. The bots refuse, but do not rely on that.

## Where to look

- [START-HERE.md](../../START-HERE.md) then [README.md](../../README.md) for the flow.
- [GOVERNANCE.md](../GOVERNANCE.md) for what each key can and cannot do.
- [RUNBOOK.md](../RUNBOOK.md) for what to do at 3am.
- `npm run console` for the live checklist and the commands, read-only by default.
- `npm run preflight -- --config config/base-mainnet.json --strict` for the current mainnet blockers, from chain state.
