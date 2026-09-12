# Start here

This project turns DICKBUTT trading fees into SPCXc holder rewards. The contract and calculator foundation now has Splits protocol routing, legacy Clanker fee recovery, a keeper executor, fee-cycle tools and a local deployment rehearsal.

Read [README.md](README.md) for the current flow, then [docs/REHEARSAL.md](docs/REHEARSAL.md) to run it. [docs/GOVERNANCE.md](docs/GOVERNANCE.md) covers the role split, the bounds on a bot proposer, and the payout-schedule tradeoff the share cap introduces. [AERODROME-SETUP.md](AERODROME-SETUP.md) describes the selected 0.3% concentrated full-range pool. [AUDITOR-BRIEF.md](AUDITOR-BRIEF.md) identifies governance, custody and external dependencies that still need review.

Two corrections from the initial prototype matter:

- Clanker's legacy module returns the token-side fees collected into its Safe. It has separate creator authority from locker ownership. Both current and historical sinks are integrated.
- Percentage allocation now uses real immutable Splits PushSplit V2.2 contracts. Custom adapters connect fee sources and swaps; they do not replace the protocol's splitting implementation.

The code has compiled and its tests have executed; the earlier “never compiled” warning was stale. Local tests, protocol fork tests, native SPCXc checks and a full local rehearsal are distinct evidence categories. None is a mainnet deployment receipt. Production recipients and the actual DICKBUTT/SPCXc NFT remain deployment prerequisites.

```sh
npm ci
npm test
forge test
BASE_RPC_URL=https://mainnet.base.org npm run rehearse
```

The rehearsal uses a disposable local fork and produces a report and calculator journal under `.context/`. Mainnet signing, legacy claims and ownership handoffs are not performed. The public operating CLIs default to dry-run and only allow transaction execution on local chain or Base Sepolia.
