# Dickbutt holder rewards — v2

Pays DICKBUTT holders in SPCXc, funded by trading fees from both pools.
No new token, no change to the DICKBUTT contract (which is immutable and
has no tax hook — everything here works around that, not through it).

## The three moving parts

| Piece | What it is | Where it runs |
|---|---|---|
| `LockerHarvester.sol` | Owns the Clanker locker; makes WETH-pool fee collection permissionless with a fixed destination | Base |
| `AerodromeFeeHarvester.sol` | Holds the Aerodrome LP NFT; claims its fees and splits DICKBUTT→burn, SPCXc→distributor | Base |
| `DickbuttRewardsDistributor.sol` | Holds SPCXc and pushes it to holders in batches, against a timelocked plan | Base |
| `FeeSplitter.sol` | Splits the WETH-pool fees: DICKBUTT→KC Green+burn, WETH→KC Green+CDB vault+SPCXc | Base |
| `calculator/` | Works out who is owed what, builds the Merkle tree | Your machine / a small VM |

## How money actually flows

1. **Automatic:** anyone (your bot, or literally anyone) calls `harvest()`
   on `LockerHarvester`. It collects LP fees from the Clanker locker and
   sends them to the splitter.
   *Why this needed a contract:* the locker's `collectFees` is gated on
   `require(owner() == msg.sender)` and lets the caller pick the recipient.
   A bot holding that key could be compromised and silently redirect every
   future fee collection. Instead the locker is owned by `LockerHarvester`,
   which has no recipient parameter — the destination is fixed in storage
   and can be frozen permanently. So `harvest()` is safe to leave open to
   anyone, and there is no privileged key in the path at all.
2. **Automatic:** anyone calls `splitDickbutt()` on `FeeSplitter` (10% to KC
   Green, 90% burned), then a keeper calls `processWeth(minOut, deadline)`
   (10% KC Green, 10% CDB vault, 80% swapped to SPCXc → distributor).
3. **Automatic, separately:** anyone calls `harvest()` on
   `AerodromeFeeHarvester`. It claims that pool's fees, burns the DICKBUTT
   side and sends the SPCXc side to the distributor. No conversion needed.
   *Aerodrome does not push fees anywhere on its own* — they sit unclaimed
   in the position until someone collects them, and `collect()` lets the
   caller choose the recipient. Hence the same owns-the-position pattern as
   the Clanker locker.
4. **Scheduled (every ~6h):** the calculator runs, computes everyone's share
   for the period, and writes out a Merkle root plus ready-to-send batches.
5. **Multisig:** `proposeRound(root, total)` → 6h timelock → `activateRound()`.
6. **Automatic:** the keeper sends each batch to `distributeBatch()`. SPCXc
   lands in holders' wallets. They do nothing and sign nothing.
7. **Automatic:** `closeRound()` once every batch has landed.

The only genuinely manual step left is buying CryptoDickbutts NFTs, which
requires bridging to mainnet and is deliberately kept out of the automated
path.

## Who gets paid, and how much

**Eligibility: 6,900,000 DICKBUTT minimum.** Measured as a time-weighted
average across the period, not a snapshot — a wallet that holds 6.9M for
half the period and nothing for the other half has a TWAB of ~3.45M and does
not qualify. A wallet that buys 50M one minute before the round ends has a
TWAB near zero and earns nothing. This is what makes the distribution
schedule safe to publish: there is no moment worth timing a buy around.

**Share size is an explicit configuration choice.** `WEIGHTING=linear` is the
recommended Sybil-neutral policy. `WEIGHTING=sqrt` preserves the original
diminishing-returns proposal but is Sybilable: splitting one balance across
wallets raises aggregate weight. The calculator refuses to run without an
explicit setting and includes it in the journal configuration hash.

The legacy example below uses sqrt(TWAB). Whales still earn the most,
but with diminishing returns. Concretely, on a 1000 SPCXc pot with three
qualifying wallets holding 7M, 70M and 700M:

| Wallet | Straight proportional | sqrt curve (what this uses) |
|---|---|---|
| 7M | 9 SPCXc | 71 SPCXc |
| 70M | 90 SPCXc | 223 SPCXc |
| 700M | 901 SPCXc | 706 SPCXc |

The whale still takes the largest share. It just stops being 90% of
everything, which is the difference between holders feeling rewarded and
holders feeling like an afterthought.

**Never paid, regardless of balance:** the Uniswap V3 pool, the Aerodrome
pool, the burn address (`0x…dEaD`), the zero address, the Clanker LpLocker,
the distributor and forwarder themselves, and any team/treasury wallets you
list. These hold enormous balances and would otherwise take most of every
round. They are configured in `EXCLUDED_ADDRESSES` and the calculator
refuses to run if that list is empty.

Because the script cannot tell whether your exclusion list is *complete*, it
prints the top ten earners every run with their addresses and TWAB. Read
that list. If you do not recognise a top earner, check it on BaseScan before
submitting the root.

**Accrual:** qualifying wallets below the payout threshold do not get a
transfer that round — their share accumulates and is paid once it is worth
more than the gas to deliver it. Nothing is ever lost.



**Push (automatic delivery), with a committed plan.** Holders never claim;
SPCXc simply appears in their wallet. The usual objection to push airdrops is
that a naive one has no undo, jams on a single failing transfer, and needs a
hot wallet with authority over the whole pool. All three are handled here:
the payout plan is committed as a Merkle root and timelocked before any token
moves (so a bad round can be cancelled); batches are idempotent and re-runnable
(so a partial failure is just re-sent); individual transfer failures are caught
and skipped rather than reverting the batch; and the keeper can only pay
amounts matching the committed root, so a stolen keeper key cannot steal or
redirect anything.

The cost of push versus claim: the project pays the gas (cheap on Base, but
not zero), and rounds must be calculated and distributed in sequence rather
than holders pulling whenever they like.

**TWAB, not snapshots.** Balance is weighted by how long it was held, using
real block timestamps. A wallet that buys one minute before a run earns one
minute of credit. Snapshot systems hand that wallet a full period's reward.

**sqrt(balance), not balance.** Mars Coin pays strictly proportionally, so a
wallet holding 250x the median takes 250x the rewards and small holders get
dust. The square-root curve still pays whales the most — just with
diminishing returns, so rewards actually reach the community.

**Distributable is derived from the distributor's real balance**
(`availableForNextRound()`), not from summing swap events. This is a
correctness fix, not a preference: the Aerodrome fee side arrives at the
distributor without passing through the splitter, so an event-counting
design would strand that entire income stream. Balance-derived is
source-agnostic, rolls dust and undelivered amounts forward automatically,
and makes over-promising structurally impossible — `activateRound()` refuses
to start a round the contract cannot fully cover.

**No loyalty multiplier.** It was in the earlier draft. Cut deliberately:
TWAB already rewards sustained holding, and the multiplier added a second
gameable dimension plus more state to get wrong, for little marginal
benefit. Can be added later if you want it.

**CDB NFT buying stays fully manual.** It requires bridging WETH from Base
to Ethereum mainnet. Bridges are among the most-exploited components in
crypto, and an automated bridge + NFT-buying bot would be a bigger attack
surface than everything else here combined — to save you a few minutes a
month. Do it by hand.

See `AERODROME-SETUP.md` for the one-time, mostly-by-hand steps to create
that pool and lock its position.

## Deployment order

1. Deploy `DickbuttRewardsDistributor(spcxcAddress, minPayout,
   multisigAddress)`. `minPayout` should be set so dust payments whose gas
   exceeds their value are skipped.
2. Deploy `FeeSplitter(weth, dickbutt, spcxc, router, kcGreen, burnAddress,
   cdbVault, distributorAddress, intermediate, firstTickSpacing,
   secondTickSpacing, maxSwapPerCall, minSwapInterval, multisigAddress)`.
   The router must be the same-factory Slipstream deployment as the two-hop
   WETH → USDC → SPCXc path. The current candidate and quote evidence are in
   `config/route-candidates.json`; refresh it at a finalized block before
   deployment. The 10/10/80 splits are fixed in the contract.
3. `setKeeper(botWallet, true)` on **both** the splitter and the
   distributor.
   Fund the keeper separately. The splitter has no reward-funded gas entry
   point, so repeatedly emptying a keeper wallet cannot drain WETH.
4. Deploy `LockerHarvester(lockerAddress, tokenId, feeSplitterAddress,
   minInterval, multisigAddress)`.
   - `lockerAddress` is `0x2Ad4DB8ba8de03834DB14454Afcd74C2393d81C4`
   - `tokenId` is the LP NFT id from the `TokenCreated` event
   - verify both against the chain before deploying
5. **The irreversible step.** From the wallet that currently owns the
   locker, call `transferOwnership(lockerHarvesterAddress)` on the locker.
   Then call `ownsLocker()` on the harvester and confirm it returns true.
   - Do this on testnet first with a mock locker.
   - The Clanker locker uses single-step OpenZeppelin `Ownable` — there is
     no acceptance handshake and **no undo**. If you transfer to a wrong or
     non-functional address, fee collection is dead permanently.
   - Verify the harvester's `destination` reads as the splitter *before*
     transferring, not after.
6. Run `harvest()` once and confirm WETH lands in the splitter.
6a. Set up the Aerodrome pool and its harvester — see `AERODROME-SETUP.md`.
    That is a separate one-time sequence ending in another irreversible
    step (transferring the LP NFT into the harvester).
7. Fill in `calculator/.env`, especially `EXCLUDED_ADDRESSES`.
8. **Run the whole cycle on Base Sepolia first.** Fake token, fake SPCXc,
   fake pool, mock locker. Run several rounds, including overlapping ones,
   and deliberately include an address that reverts on receive to confirm
   the batch survives it. Confirm the numbers.
9. Only then repeat on mainnet, starting with a small amount of real SPCXc.
10. Once the splitter has run correctly for a few cycles, call
    `lockDestinationForever()` on the harvester. After that, no key
    anywhere can redirect the fee stream.

## Operating it

Everything below can be a cron job except step 6's multisig call:

```
# 1a. harvest() on LockerHarvester          (permissionless, any wallet)
# 1b. harvest() on AerodromeFeeHarvester     (permissionless, any wallet)
# 2.  splitDickbutt() on FeeSplitter         (permissionless)
# 3.  processWeth(minOut, deadline)          (keeper wallet)
# 4.  cd calculator && WEIGHTING=linear npm run calculate
# 5.  multisig: proposeRound(root, total)  -> note the roundId returned
# 6.  after the timelock, anyone calls activateRound(roundId)
# 7.  keeper sends each batch from the journal to distributeBatch(roundId, ...)
# 8.  keeper calls closeRound(roundId) once delivered
```

Step 3 goes before step 4 on purpose: the gas slice comes off the top of the
WETH, before the 10/10/80 split and the SPCXc swap.

Rounds do not block each other. Step 5 can run for round 8 while round 7 is
still mid-delivery, and the queue drains on its own if the keeper was down.

Steps 1, 2, 6 and 7 need a wallet with a little ETH for gas, nothing more.
Step 1's wallet is not privileged at all; the keeper in steps 2/6 can only
trigger a capped swap to a fixed destination, or pay amounts that match an
already-committed root.

Only step 4 needs a human, and only because someone should look at the
numbers before a round goes out. If you later decide that check is not
worth the friction, the multisig could be replaced by an automated
proposer — but then nothing is reviewing the calculator's output before
money moves, which is a real loss.

Separately and manually: bridge the CDB vault's share to mainnet and buy
CryptoDickbutts off the floor.

## Things that will break it if you get them wrong

- **Losing `calculator/state.json`.** It holds every wallet's DICKBUTT
  balance as of the last processed block, and `lastProcessedBlock` itself.
  Lose it and the next run either re-scans from deployment (slow but
  recoverable) or, worse, starts from a wrong block and mis-weights a round.
  The `rounds/` directory is the audit trail of what was actually paid.
  Commit both to a private repo after every run.
- **An incomplete `EXCLUDED_ADDRESSES`.** The pools hold enormous DICKBUTT
  balances. Left in, they out-earn every real holder combined. The script
  refuses to start on an empty list, but it cannot tell whether your list is
  *complete* — that is on you.
- **Submitting a root without reading the output.** The script prints the
  distributable amount, the qualifying wallet count, and a hard refusal if
  the tree would promise more than the vault holds. Read it every time.

## What is NOT built

- The keeper bot itself: the script that reads `batches-N.json` and submits
  each batch, waits for confirmation, retries failures, and calls
  `closeRound()`. Straightforward ethers.js, but it does not exist yet.
- Any monitoring or alerting (e.g. "a round has been active for 12 hours
  and still has undelivered batches").
- A public page showing what was distributed each round. Optional, but it is
  the thing that makes the system visibly trustworthy.
- Automated bridging / NFT purchasing — deliberately, see above.
