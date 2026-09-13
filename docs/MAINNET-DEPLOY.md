# Base mainnet deployment

`npm run deploy:mainnet` deploys this repository's six contracts to Base mainnet and writes the
manifest, calculator config and receipts the operating CLIs consume. It is a dry run by default.

It deploys **our contracts only**. DICKBUTT, SPCXc, WETH, USDC, the Splits factory, the Aerodrome
router and quoter, the Clanker locker and the legacy fee module all already exist; the script
verifies them and never deploys a stand-in. There is no mainnet equivalent of
`script/SepoliaSupport.sol`, and there should never be one.

## What it will not do

Deployment and custody are separate, and the script performs none of the custody steps:

- Accepting ownership. Every ownable contract here is `Ownable2Step`, so the script calls
  `transferOwnership` and stops. Ownership stays with the deploying key until the multisig sends
  `acceptOwnership`. A wrong owner address is recoverable up to that moment and not after it.
- Claiming outstanding legacy fees. Clanker returns the token side to the **current** creator, so
  this has to happen before creator authority moves.
- Assigning legacy `tokenCreator` authority. Permanent: the adapter has no relay to update it.
- Transferring locker ownership to `LockerHarvester`.
- Transferring the rewards pool LP NFT to `AerodromeFeeHarvester`.

Each is printed as a remaining step when the run completes.

## Inputs

Addresses come from `config/base-mainnet.json`. Production magnitudes come from a separate params
file you pass with `--params`; copy `config/params-mainnet.example.json`, fill every field, and keep
the filled copy out of git.

Nothing in the params file has a default. Sepolia could afford invented test magnitudes — a floor
bound of one SPCXc, a five-DICKBUTT fee — because nothing there was worth anything. A production
floor lower bound, swap cap or permanent unlock time is somebody's decision, and a script that
quietly picks one for you is worse than a script that refuses to run. Each field in the example
carries the reason it cannot be defaulted.

The Aerodrome quoter is **resolved, not configured**: the script matches the factory/router pair in
`config/base-mainnet.json` against the generations recorded in `config/route-candidates.json` and
uses that generation's quoter. Slipstream has shipped three generations on Base and they are not
interchangeable — the executor stores tick spacings, so a quoter from the wrong generation quotes a
pool the swap will never touch.

## Order of operations

```sh
npm ci && forge build
npm run preflight -- --strict                      # live liquidity, roles, exclusions, pool identity
npm run deploy:mainnet -- --params params.json     # dry run: validates everything, signs nothing
npm run deploy:mainnet -- --params params.json --execute
```

Run preflight first. This script re-checks roles, exclusions and pool identity, but preflight is the
one that re-quotes the swap route against live liquidity.

The dry run prints the exact constructor arguments and role transactions an execute run would send,
in order. Read it. Constructor arguments to `SplitsFeeRouter` become **immutable Split recipients**:
there is no setter, and a wrong address there means redeploying the router and re-pointing every
harvester.

## Verification before signing

Answered from files, before the RPC is contacted: role completeness and key separation, calculator
exclusions, and every params field.

Answered on-chain at a finalized block: code exists at every external address; DICKBUTT is 18
decimals and SPCXc is 8; the rewards pool matches its factory, fee, tick spacing and full-range
position; the Aerodrome unlock time is in the future; and `dickbuttDeployBlock` really is DICKBUTT's
creation block — checked by requiring no code at the preceding block and code at that one, which is
why an archive RPC is needed. The calculator trusts that block absolutely: it scans `Transfer`
events from there and treats what it finds as the complete holder history.

The deploying key is also rejected if it holds any lasting role.

## Interruptions

Progress is written to `<manifest>.partial` after every deployment and every configuration
transaction, keyed by step index and arguments. `--resume` continues the same deployment; it refuses
to continue if the deployer identity, the chain or the plan hash has changed. A resume never
resubmits a signed transaction — it waits for the recorded hash and fails if that transaction
failed.

## What is still gated

The operating CLIs — `operations/fees.js`, `operations/floor.js`, `script/run-keeper.mjs` — still
refuse to execute on chain 8453. That gate is deliberately untouched by this script. Deploying
contracts and running fee cycles against them are separate decisions that deserve separate reviews;
see `gate.mainnetWrites` in the launch checklist.
