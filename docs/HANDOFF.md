# Current project handoff

Latest alignment review: [claims, two-hop swap, replacement wallets, delayed NFT custody and permanent locks](ALIGNMENT-RETEST-REPORT.md). The new F9 preflight fix brings the total to nine groups; final suites pass 169 application tests and 114 Solidity tests, with one production-NFT test skipped.

The owner requested full development checks, repairs, wallet testing and a shareable developer report. The authoritative account is [COMPLETE-DEVELOPER-REPORT.md](COMPLETE-DEVELOPER-REPORT.md); exact changed files are in [FILE-CHANGE-INVENTORY.md](FILE-CHANGE-INVENTORY.md). The [supplied earlier handoff](history/HANDOFF-SUPPLIED.md) is preserved for attribution only and is not the current status.

**Not ready for production.** Nine fix groups were addressed. The full application suite passes 169 tests; the full Solidity suite passes 114 with one optional production-position test skipped. Three public Base Sepolia fee cycles and one holder round passed. The normal 24-hour delay was restored, but the additional normal-delay round and 48-hour observation are incomplete.

The active public manifest is `config/deployment-sepolia-new.json`; its calculator configuration and receipt ledger sit alongside it. `config/console-deployment.json` selects that manifest and `.context/public-sepolia/journal` for the console. The old `deployment-sepolia.json` is historical. The public test uses actual Splits and test stand-ins for tokens/fee/trading sources. Actual external integrations also passed separate local Base fork tests.

Before production, complete and verify the owner/proposer/guardian/floor-setter configuration and recipient control; create and fund the intended pool/NFT; rehearse multisig acceptance and the three distinct custody handoffs; review owner authority, legacy migration and token/floor behavior; benchmark independently controlled historical replay and operating hosts; finish the timed test and independent review. The operating CLIs still reject mainnet writes. The supported production target is Base (8453), not Ethereum mainnet (1).

The recorded extended window is 2026-09-13 04:31:54 UTC through 2026-09-15 04:31:54 UTC. The process must complete its actual checks, not merely reach the end timestamp. Read `.context/public-sepolia/soak.json` for later progress.

Use the prepared `handoff/dickbutt-tested/` folder or `handoff/dickbutt-development-handoff.zip` to share source and selected public evidence. Do not zip the working directory indiscriminately: it also contains private and disposable runtime files excluded from the reviewed package.
