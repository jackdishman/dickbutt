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
- Claiming outstanding legacy fees. The current creator may claim first, or the adapter can claim
  its configured Safes after the separate creator-authority handoff. Claiming first is optional.
- Assigning legacy `tokenCreator` authority. Permanent: the adapter has no relay to update it.
- Transferring locker ownership to `LockerHarvester`.
- Transferring unstaked rewards-pool ERC-20 LP tokens to the new `AerodromeVammHarvester`.
  The old `AerodromeFeeHarvester` accepts a Slipstream NFT and is not the vAMM custody destination.

Each is printed as a remaining step when the run completes.

## Current candidate

The selected rewards pool kind is `vamm`. The selected public pool and LP-holder wallet are recorded and checked in
[the September 21 verification](SELECTED-POOL-VERIFICATION.md). Missing roles and production magnitudes still block deployment. Historical manifests without a kind use
the original Slipstream NFT adapter. New manifests record `sources.aerodromeKind`, `rewardsPool` and
`rewardsFactory`; the fee CLI validates the vAMM immutable path. Runtime mainnet gates remain closed.
The internal audit fixes passed; independent review and production operating readiness remain required.

## Inputs

Addresses come from `config/base-mainnet.json`. Production magnitudes come from a separate params
file you pass with `--params`; copy `config/params-mainnet.example.json`, fill every field, and keep
the filled copy out of git.

Nothing in the params file has a default. Sepolia could afford invented test magnitudes — a floor
bound of one SPCXc, a five-DICKBUTT fee — because nothing there was worth anything. A production
floor lower bound, swap cap or permanent unlock time is somebody's decision, and a script that
quietly picks one for you is worse than a script that refuses to run. Each field in the example
carries the reason it cannot be defaulted.

The owner selected a **365-day timed Aerodrome LP lock** on 21 September 2026; permanent locking was not selected. `rewardsPool.lockIntent` is a planning record, not a substitute for the required explicit `params.aerodromeUnlockTime` and not a duration check performed by the driver. Calculate that timestamp from the reviewed planned LP handoff time plus 31,536,000 seconds, show the exact calendar date before deployment, and recheck the intended full duration before handing over LP. Follow the delayed-handoff/extension checks in [the Aerodrome setup](../AERODROME-SETUP.md#selected-lp-lock--21-september-2026). No production lock has started yet.

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
one that checks swap-route pool identity and active liquidity. Re-quoting execution prices is a separate required check.

The dry run prints the exact constructor arguments and role transactions an execute run would send,
in order. Read it. Constructor arguments to `SplitsFeeRouter` become **immutable Split recipients**:
there is no setter, and a wrong address there means redeploying the router and re-pointing every
harvester.

## Verification before signing

Answered from files, before the RPC is contacted: role completeness and key separation, calculator
exclusions, and every params field.

The complete compiled build is loaded before signing. Each artifact's compiler-recorded source
hashes must match the current source and imported dependencies; stale or missing artifacts require
`forge build`. The dry run prints a build hash, and recovery refuses a different or unrecorded build.
This checks build consistency, not whether the code has passed an independent security audit.

The plan explicitly calls `setRoundDelay` and `setRoundLimits` from `config.roundLimits`; it does not
rely on whichever constructor defaults happen to be compiled. The selected settings are zero extra
review delay, a six-hour minimum proposal interval and a 50% round cap. The constructor still
defaults to 24 hours; the deployment's explicit `setRoundDelay(0)` selects immediate activation.
This removes the guaranteed cancellation window. Review this changed policy before deployment;
the earlier 24-hour-delay audit snapshot does not represent this candidate.

The emitted calculator config includes both the Clanker and rewards pool addresses, all entries
approved in `calculatorExclusions.required`, and the deployed pipeline/bot addresses. Check that
generated file before bootstrapping the journal: changing exclusions after journaling requires a
reviewed migration.

Answered on-chain at a finalized block: code exists at every external address; DICKBUTT is 18
decimals and SPCXc is 8; the selected vAMM matches its factory registry, volatile flag, token pair,
expected fee, positive reserves and funded unstaked LP wallet (historical Slipstream plans use their NFT checks); the Aerodrome unlock time is in the future and within the constructor's 100-year maximum; and `dickbuttDeployBlock` really is DICKBUTT's
creation block — checked by requiring no code at the preceding block and code at that one, which is
why an archive RPC is needed. The calculator trusts that block absolutely: it scans `Transfer`
events from there and treats what it finds as the complete holder history.

The deploying key is also rejected if it holds any lasting role.

## Interruptions

Execution takes an exclusive `<manifest>.deployment-lock` and a per-chain deployer lock on this host
before inspecting the partial ledger. This prevents two deployers overwriting one output, or one
deployer signing concurrent runs with different outputs. Locks release on ordinary errors. After a
process crash, inspect `owner.json`, confirm the owning process has stopped, and reconcile the
deployer's pending nonce and receipts before manually removing its locks. Never share a deploying
key across hosts: local filesystem locks cannot coordinate other machines.

The driver rechecks latest and pending nonces while holding both locks. It refuses new or resumed
execution until those nonces match. Let a known pending deployment confirm, or explicitly reconcile
its replacement/drop, then resume; the script does not guess about ambiguous sends.

Progress is written to `<manifest>.partial` after every deployment and every configuration
transaction, keyed by step index and arguments. `--resume` continues the same deployment; it refuses
to continue if the deployer identity, the chain, plan hash, compiled build hash or input hash has changed.
The input hash includes all address configuration, exclusions, eligibility and payout parameters,
legacy sources, Splits configuration and resolved quoter. Changing only off-chain payout inputs is
still a different deployment. JSON object key order does not change this identity; array order does.
Old partial files without these recorded hashes require manual inspection and cannot be resumed automatically.
For a transaction whose hash was recorded, a resume waits for that hash rather than submitting it
again. If a process/RPC failed after broadcast but before recording the hash, inspect the deployer's
nonce and transaction history before recovery; the partial file alone cannot settle that ambiguity.

## What is still gated

The operating CLIs — `operations/fees.js`, `operations/floor.js`, `script/run-keeper.mjs` — still
refuse to execute on chain 8453. That gate is deliberately untouched by this script. Deploying
contracts and running fee cycles against them are separate decisions that deserve separate reviews;
see `gate.mainnetWrites` in the launch checklist.
