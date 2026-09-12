# Fee flywheel rehearsal design

The user authorized implementation following the project status review, with these corrections: use a 0.3% concentrated DICKBUTT/SPCXc pool, prefer actual Splits protocol contracts for allocations, and include Clanker legacy token-side creator claims. The intended aggregator path is USDC → SPCXc → DICKBUTT. Better price/depth may attract routing; the application cannot force aggregators to use it.

The architecture uses separate immutable Splits PushSplit V2 instances for DICKBUTT (KC Green 10%, burn 90%) and WETH (KC Green 10%, CDB 10%, swap executor 80%). A small asset router sends each received token to its corresponding Split. Splits computes and executes the percentages; the custom swap executor only converts its WETH into SPCXc under the existing cap, keeper, deadline and expiring price-floor protections. The off-chain calculator and committed push distributor retain their accounting and governance model.

A fixed-destination legacy adapter integrates only verified Clanker claim interfaces and configured fee sinks. Creator authority is distinct from locker ownership. The source-specific protocol deduction and returned token-side fees are accounted separately, rather than assuming 60% of sell-side fees is permanently unavailable.

The Aerodrome harvester continues to hold an unstaked full-range concentrated LP NFT. Setup must verify actual factory generation, token pair, tick spacing, current swap fee of 3000 units (0.3%), unstaked fee, and position liquidity/range. Tick spacing does not guarantee a permanent swap fee. No pool or liquidity creation occurs on mainnet during this task.

The keeper reads and validates committed calculator journal plans, submits proposals only with an explicit operator option, respects the timelock, retries unpaid recipients without double payment, and closes only fully paid rounds. Its rehearsal CLI defaults to read-only and limits execution to local chain 31337 or Base Sepolia 84532. The local rehearsal deploys disposable assets/dependencies, exercises fees and actual Splits contracts where a fork is required, calculates an actual journal plan and uses the real keeper to deliver it.

Production governance choices remain explicit: linear weighting for rehearsal, 6.9M default threshold in production calculator, six-hour round delay, externally funded keepers and owner-maintained swap price floors. CDB NFT buying remains manual. No mainnet transaction, legacy claim or custody handoff is authorized by this implementation task.

Acceptance: deterministic unit and integration tests; real Splits factory fork evidence; runnable local end-to-end rehearsal with successful retry and accounting reconciliation; documentation and deployment preflight commands; explicit recorded limits for actual B20 token, production pool, recipients and public-testnet deployment.
