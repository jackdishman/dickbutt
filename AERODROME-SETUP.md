# Setting up the Aerodrome pool — step by step

This is the part you do by hand, once. After it's done, fee collection runs
itself forever.

Nothing here requires you to write code. You'll use the Aerodrome website
for most of it, and your developer handles the two contract steps.

---

## Before you start, you need

- **DICKBUTT and SPCXc** in your wallet, in roughly equal dollar value. This
  is the liquidity you're seeding — it stays in the pool.
- **A bit of ETH on Base** for gas (a few dollars).
- **Your deployed distributor's address** (from the main deployment).

A note on sizing: don't seed it thin. When people see the "meme coin paired
with a real stock" angle and go to buy, a shallow pool gives them terrible
prices, and screenshots of bad fills spread as fast as the joke does. Enough
that a few-hundred-dollar buy doesn't move the price wildly.

---

## Step 1 — Create the pool

1. Go to Aerodrome and connect your wallet.
2. Find "Deposit" / "New Position", and choose the **Concentrated
   liquidity (Slipstream)** pool type — not the basic pool. This matters:
   Slipstream positions are NFTs, which is what makes the automation and
   the lock possible.
3. Pick your two tokens: DICKBUTT and SPCXc.
4. Pick the fee tier. Aerodrome shows this as a tick spacing option. You
   wanted 0.3% per side. **This is permanent for that pool** — you can't
   change it later, you'd have to create a new pool.
5. Choose **full range**. This makes the position behave like a simple
   50/50 pool: it never goes out of range and never needs rebalancing.
   Anything narrower earns more fees but stops earning entirely when the
   price moves outside your band, which is a maintenance job you don't
   want.
6. Set the starting price. Since this is a brand-new pair, **you** are
   setting DICKBUTT's price in SPCXc terms. Work it out from each token's
   current dollar price and double-check it before confirming — get this
   wrong and arbitrage bots will immediately drain the mispriced side.
7. Deposit. You'll receive an **NFT** representing your position.

## Step 2 — Find your position's token ID

The NFT has an ID number. Find it either in Aerodrome's position page URL,
or on BaseScan by looking at the transfer of the position NFT into your
wallet. Your developer needs this number — it's how the contract knows which
position to collect from.

## Step 3 — Deploy the harvester (developer does this)

Deploy `AerodromeFeeHarvester.sol` with:

- the Slipstream position manager address
- your position's token ID from step 2
- DICKBUTT's address
- SPCXc's address
- the burn address (`0x…dEaD`)
- the distributor's address
- `unlockTime` — see the note below
- `minInterval` — e.g. 1 hour
- your multisig as owner

**About `unlockTime`:** this is when, if ever, you could pull the liquidity
back out. Options:

- A far-future timestamp → effectively a permanent lock.
- One or two years out → keeps the option to migrate if something changes.
- Whatever you pick, you can always call `lockForever()` later to give up
  the option for good. You can also extend the lock, but never shorten it.

Fee collection works regardless of this setting. Locking the liquidity does
not lock the fees.

## Step 4 — Transfer the position into the harvester

From the wallet holding the NFT, send it to the harvester contract using
`safeTransferFrom`. Then call `holdsPosition()` on the harvester and confirm
it returns `true`.

**Check the harvester's addresses before you send the NFT, not after.**
Confirm `spcxcDestination` is really your distributor and `burnAddress` is
really the burn address. Once the NFT is in, it's in.

## Step 5 — Test it

Do a small swap in the pool yourself to generate a few cents of fees, then
call `harvest()` on the harvester. Confirm DICKBUTT landed at the burn
address and SPCXc landed at the distributor. That's the whole loop proven.

---

## After setup, what happens automatically

Your keeper bot calls `harvest()` on a schedule. Anyone else can too — the
function is open to everyone, because the caller has no say in where the
money goes. Fees split themselves: DICKBUTT burns, SPCXc goes to the
distributor and joins the pool being paid out to holders.

You never touch this again.

---

## Do this on testnet first

Base Sepolia, with throwaway tokens and a throwaway pool. Run the entire
sequence including the NFT transfer. Step 4 is irreversible on mainnet, and
a mistake there means the position is stuck in a contract that can't do
anything useful with it.
