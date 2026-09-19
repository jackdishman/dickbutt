# Current handoff and governance refresh

- `docs/HANDOFF.md` now points to the final audit report as the authority for findings/counts; states the selected basic volatile DICKBUTT/SPCXc unstaked ERC-20 LP architecture, inclusive 6.9M period TWAB, six-hour cadence, zero added review delay and keeper-pushed payments. Actual pool verification, production settings/hosts and operating gates remain incomplete.
- September 13 reports, archived packages, public Sepolia addresses and incomplete soak observations remain linked and explicitly historical. No elapsed-time assertion was promoted to completed or uninterrupted testing.
- `docs/DEVELOPER-HANDOFF.md` received a historical banner and its initial NFT handoff was labelled superseded; detailed historical evidence remains intact.
- `docs/GOVERNANCE.md` now describes proportional capped instalments with retained credit instead of the fixed cap-related stall. It distinguishes no direct reward rescue from the owner's authority to appoint keepers/propose arbitrary roots, and states that the proposer chooses commitments while the independent keeper verifies eligibility and amounts.
- Governance now distinguishes current ERC-20 LP permanence from Clanker's separate NFT custody. Pending fee-destination proposals survive ownership transfer and must be inspected/cancelled during Safe acceptance. A frozen Clanker harvest destination does not remove owner recovery authority after the upstream unlock.

Validation: manual comparison to current calculator/harvester semantics; relative Markdown file links checked; `git diff --check` passed. No code or historical audit-result files changed for this documentation task.
