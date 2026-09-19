# Final reviewed attack surface — 20 September 2026

Baseline commit: `4a7e7a68d0ee3ac881214c77f8f82b3ca749a5de`; reviewed modifications are bound by `source-sha256.json`. This map describes the current final candidate. The unedited pre-review map is preserved separately and contains earlier historical scope notes. No production deployment or custody handoff happened in this review.

## Architecture and assets

Clanker locker collects DICKBUTT/WETH; its upstream 60% fee Safe deduction is outside our contracts. LockerHarvester can collect only to its destination. LegacyFeeHarvester separately uses creator authority to recover DICKBUTT from two module-enabled Safes into SplitsFeeRouter. The router creates two ownerless official PushSplit V2.2 clones: DICKBUTT 10% KC / 90% dead address; WETH 10% KC / 10% CDB / 80% executor. Executor uses fixed WETH/USDC/SPCXc Slipstream path and delivers SPCXc to the distributor. The production candidate now uses basic volatile AerodromeVammHarvester: ERC-20 LP tokens stay unstaked, claimFees collects its share, all DICKBUTT goes to dead and all SPCXc to distributor. LP principal is separately time locked. Historical NFT adapter remains regression scope. Source-code 'burn' transfers do not reduce total supply.

The calculator reconstructs DICKBUTT Transfer history, measures period TWAB, applies exclusions and inclusive 6.9M minimum, and carries amounts below the payout minimum. It writes a hash-chained local journal and Merkle plans. The proposer commits roots; a distinct keeper independently repeats the calculation before sending payments. The on-chain distributor enforces committed proofs and aggregate solvency, not eligibility or fairness. The configured proposal interval is six hours and extra activation delay zero; constructor default remains 24h until setup changes it.

## Contracts and every mutating entry point

| Contract | Mutating functions and authority | Assets / calls / controls |
|---|---|---|
| DickbuttRewardsDistributor | proposeRound: proposer or owner; cancelPendingRound, pauseProposals: guardian or owner; activateRound: anyone after readyAt; closeRound: anyone if fully paid, otherwise owner; distributeBatch: keeper; executeTransfer: self only; setKeeper, setProposer, setGuardian, setRoundLimits, setRoundDelay, setMinPayout, rescueToken: owner | Custodies SPCXc; transfer self-call catches ordinary recipient failures; reservations added at proposal, removed on payment/cancel/close. Rescue forbids reward token. Pause stops new proposals only. |
| SpcxcSwapExecutor | processWeth: keeper; setPriceFloor: owner or floor setter; setKeeper, setFloorSetter, setFloorLowerBound, setSwapLimits, rescueToken, rescueETH: owner; forwardSpcxc: anyone | Custodies WETH; exact fixed-router approval reset after swap; actual WETH spent and distributor SPCXc delta checked; fixed destination and path; expiring floor, amount cap, interval. Keeper and floor setter mutually exclusive. |
| SplitsFeeRouter | splitDickbutt, splitWeth: anyone | No owner. Creates ownerless splits in constructor and checks factory binding/config hash. Only two supported tokens can exit to fixed splits; other assets stranded. External splits may use Warehouse accounting and retain dust. |
| LockerHarvester | harvest: anyone; recoverReleasedPosition, proposeDestination, cancelDestinationChange, setDestinationDelay, lockDestinationForever: owner; applyDestination: anyone after delay | Calls immutable locker and NFT manager; only configured tokenId recoverable after upstream unlock. Destination initially changeable with 7-day delay (owner can set 1–30 days), then permanently freezable. No relay to transfer locker ownership back. |
| AerodromeFeeHarvester | harvest: anyone; proposeDestination, cancelDestinationChange, lockDestinationForever, lockForever, extendLock, withdrawPosition, rescueToken: owner; applyDestination: anyone after 7 days | Holds one immutable manager/tokenId; collect to self and sweep two fixed token types. NFT cannot withdraw until unlock; permanent lock optional. onERC721Received is view callback checking manager/id. Ordinary transferFrom bypasses this hook. No increase/decrease liquidity or staking methods. |
| AerodromeVammHarvester | harvest: anyone; proposeDestination, cancelDestinationChange, lockDestinationForever, lockForever, extendLock, withdrawLiquidity, rescueToken: owner; applyDestination: anyone after 7 days | Immutable factory/pool and token pair. Constructor requires registered factory discovery and volatile flag. Claims cannot change LP principal; rescue forbids LP and both fees. Owner withdrawal only after unlock, never after permanent lock. New LP contributions inherit lock; pre-transfer fees stay with prior holder. |
| LegacyFeeHarvester | harvest, harvestFrom: anyone | No owner. Fixed 1–8 unique Safes/module/token/destination; calls module's tokenCreatorTransfer, checks positive recipient delta. Creator assignment permanent from adapter's perspective; external Safe/module governance remains a dependency. |
| FeeSplitter (legacy, not production deployment) | splitDickbutt, forwardSpcxc: anyone; processWeth: keeper; setKeeper, setSwapLimits, setPriceFloor, rescueToken, rescueETH: owner | Earlier direct splitter/executor retained in regression suite; same protected-token and fixed-path assumptions. |
| SplitsV2Interfaces | No implementation entry points | ABI and struct definitions for official factory/splits. |

All six Ownable2Step-derived source contracts also expose inherited transferOwnership, acceptOwnership, renounceOwnership (four are in the six-contract deployment). No project proxies, initializers, upgrade entry points, arbitrary delegatecall, signatures/permits, randomness, bridges, or vault shares. Constructors assign roles; external dependencies can have separate governance. Renunciation can remove recovery options and does not revoke previously granted bot roles.

## Trust boundaries and accounting sources

- Safe owner can appoint both proposer and keeper and therefore authorize arbitrary committed rewards. Separate bot roles protect against one stolen bot key, not a compromised owner quorum or both bots. Guardian alone cannot close unpaid active rounds. Zero delay removes its guaranteed cancellation opportunity.
- Actual ERC20 balances and immutable token identities underpin solvency. Non-rebasing, untaxed supported assets are assumed; upstream token freezes/blacklists/native policy can prevent delivery. SafeERC20 detects false returns, not taxed delivery. ERC721 and router authenticity must be verified before custody.
- Merkle leaves are double-hashed roundId/account/amount. paid flags and aggregate distributed/reserved state prevent replay/overspend. Roots do not prove historical ownership on chain. Cross-contract/chain domains come from keeper configuration, not leaf contents.
- Finalized/safe block hashes, archive RPC Transfer logs and decimals underpin historical reconstruction. A coherent dishonest RPC or compromised keeper configuration can defeat independent verification. Journal hashes detect corruption but are not authentication. All relevant source pools, burn/treasury/operational addresses need exclusions.
- Floor bot and fee bot both quote current DEX state. There is no independent market oracle/TWAP. Expiry, owner lower bound and quote-derived minimum bound permitted execution but do not prove an unmanipulated market price.
- Fee/calculate jobs run every six hours; keeper checks every minute; floor refresh hourly; monitor every five minutes. Separate hosts, gas funding, signer locks, reliable receipt reconciliation, persistent journals and scheduling are operational dependencies. Current production execution gates remain closed.
- Deployment driver verifies source/build identities, params and external facts; saved progress/local artifacts remain trusted. Authority transfers and ERC-20 LP custody are later manual actions. The actual rewards pool/LP owner and several production settings/roles are not yet configured. The Clanker locker has its own upstream NFT; this does not make the basic volatile rewards pool an NFT position.

## Critical invariants to challenge

1. For supported reward token behavior, distributor balance covers totalReserved, which equals pending obligations plus active unpaid obligations.
2. No round can pay more than its committed total; each round/account pays at most once; failed transfers neither consume paid flag nor reduce reserve.
3. Unprivileged callers cannot propose, grant roles, change destinations, swap or push rewards; permissionless harvest/routing cannot choose a beneficiary.
4. Keeper alone cannot redirect a committed payout, proposer alone cannot transfer funds; combined/owner authority must be reported separately.
5. Every successful swap spends exactly its capped input, credits the fixed distributor at least its enforced minimum, and leaves zero router allowance.
6. LP principal remains inaccessible before unlock/after permanent lock; fee harvesting can continue while locked.
7. Legacy harvest supports both configured Safes without allowing arbitrary token/Safe/destination selection; absent authority or disabled module fails safely.
8. Calculator per-holder starting accrual + recredits + new shares = payout + ending accrual, with no duplicate credit; source snapshots and config identity cannot drift unnoticed.
9. Boundary eligibility is inclusive; same-timestamp flash borrowing adds no holding duration; linear weighting cannot increase total reward weight merely by splitting qualifying wallets.
10. Feasible funded obligations must not stall indefinitely because of round caps, recipient failures, scheduling drift, hostile roots, stale floors or growing journals. This is a liveness property to test, not an assumption.

## Lifecycle

Build/snapshot → deploy six contracts → apply settings (including delay zero) → Safe accepts ownership → verify config/roles/destinations/code → separately hand off locker ownership, legacy creator authority, Aero ERC-20 LP → bootstrap balances → collect/split/swap → finalized calculate/accrue/plan → propose/reserve → immediate eligible activation → batched pushes/retries → close/recredit if necessary. Cancellation cannot rewind already-paid tokens. Destination freeze and permanent LP lock cannot be undone. Any findings are documented before deciding remediation.


## Final review additions

- All scheduled calculator writers and keeper readers now share an explicit journal path; rendered shell arguments are tested by inert execution. Cron backslashes are rejected and control-character paths are rejected. Systemd escaping is specified/tested, not daemon-tested on this Mac.
- Keeper checks fresh latest/pending nonces for every involved signer after acquiring all signer locks. Deployment separately locks its canonical output and signer before ledger checks/writes, then checks nonces; locks coordinate one host only.
- Accepting ownership does not clear pending fee-destination proposals or existing bot roles. Inspect/cancel unwanted pending destinations before accepting/funding. Clanker destination freeze does not revoke owner recovery of its upstream NFT after unlock.
- Real-route local market experiments demonstrate permitted slippage loss; an honest spot-quote bot is not an independent price oracle. Hypothetical capital/limits and idealized ordering do not establish production exploit profitability.
- Three independent subtask reviews supplemented the root review. Findings were reproduced before fixes; complete tests, new combined actual-dependency forks, deeper invariants, whole-application static triage and compiler applicability checks follow. The exact future public vAMM pool and unattended production hosts remain untested.
