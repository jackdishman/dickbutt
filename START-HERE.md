# Start here

Current status: [final security audit](AUDIT_REPORT.md) and [current handoff](docs/HANDOFF.md). The selected rewards pool is basic volatile DICKBUTT/SPCXc with **unstaked ERC-20 LP shares**. Final suites passed 238 JavaScript and 163 Solidity tests, with one optional historical NFT skip. Actual pool verification, production inputs and operating hosts remain launch prerequisites.

This project turns DICKBUTT trading fees into SPCXc holder rewards. The contract and calculator foundation now has Splits protocol routing, legacy Clanker fee recovery, a keeper executor, fee-cycle tools and a local deployment rehearsal.

Historical September 13 context: [docs/COMPLETE-DEVELOPER-REPORT.md](docs/COMPLETE-DEVELOPER-REPORT.md) for the full work history, nine fix groups, tested behavior and remaining limitations. [docs/FILE-CHANGE-INVENTORY.md](docs/FILE-CHANGE-INVENTORY.md) accounts for every changed deliverable. The completed public round and ongoing observation do not establish production readiness.

Read [README.md](README.md) for the current flow, then [docs/REHEARSAL.md](docs/REHEARSAL.md) to run it. [docs/GOVERNANCE.md](docs/GOVERNANCE.md) covers the role split, the bounds on a bot proposer, and the payout-schedule tradeoff the share cap introduces. [docs/SEPOLIA.md](docs/SEPOLIA.md) covers the public-testnet deployment, [docs/MAINNET-DEPLOY.md](docs/MAINNET-DEPLOY.md) covers the production one, and [docs/RUNBOOK.md](docs/RUNBOOK.md) covers operating it. [AERODROME-SETUP.md](AERODROME-SETUP.md) describes basic volatile ERC-20 LP custody and verification of the selected 0.3% fee. [AUDITOR-BRIEF.md](AUDITOR-BRIEF.md) identifies governance, custody and external dependencies that still need review.

Two corrections from the initial prototype matter:

- Clanker's legacy module returns the token-side fees collected into its Safe. It has separate creator authority from locker ownership. Both current and historical sinks are integrated.
- Percentage allocation now uses real immutable Splits PushSplit V2.2 contracts. Custom adapters connect fee sources and swaps; they do not replace the protocol's splitting implementation.

The code has compiled and its tests have executed; the earlier “never compiled” warning was stale. Local tests, protocol fork tests, native SPCXc checks and a full local rehearsal are distinct evidence categories. None is a mainnet deployment receipt. Production recipients and the actual DICKBUTT/SPCXc basic volatile pool and LP owner remain deployment prerequisites.

```sh
npm ci
npm test
forge test
npm run console                                    # local panel: flow, checklist, config, commands
BASE_RPC_URL=<archive-read-only-rpc> npm run rehearse -- --vamm
```

[`npm run console`](ui/README.md) is the quickest way to see where the project stands: it resolves
the flow diagram against whichever network you select, derives the launch checklist from the config
files rather than from a tick box, and runs the read-only commands with their output streamed. It
binds to loopback, reads no private key, and refuses transaction-sending commands unless started with
`--allow-execute`.

The rehearsal uses a disposable local fork and produces a report and calculator journal under `.context/`. Mainnet signing, legacy claims and ownership handoffs are not performed. The public operating CLIs default to dry-run and only allow transaction execution on local chain or Base Sepolia.
