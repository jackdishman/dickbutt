"""Account for every source/document change against the supplied project."""
from pathlib import Path
import difflib
import argparse
import re

root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--original',type=Path,default=root.parent.parent/'dickbutt-main 2')
original=parser.parse_args().original.resolve()
if not original.is_dir():raise SystemExit('Provide the supplied baseline with --original.')
output=root/'docs/FILE-CHANGE-INVENTORY.md'
if not output.exists():output.touch()
roots=['src','test','calculator','keeper','operations','script','ui','docs','config']
files=set(Path(n) for n in ['.gitignore','README.md','START-HERE.md','AERODROME-SETUP.md','AUDITOR-BRIEF.md','package.json','package-lock.json','calculate-rewards.js','foundry.toml'])
for directory in roots:
 for p in (root/directory).rglob('*'):
  if p.is_file() and not p.is_symlink() and not any(x in {'node_modules','.context','.git','out','cache','__pycache__'} for x in p.parts):files.add(p.relative_to(root))
notes={
'.gitignore':'Exclude downloaded local Foundry tools; existing private/runtime exclusions retained.',
'calculate-rewards.js':'F1 pending-plan CLI result; shared bounded RPC provider.',
'calculator/engine.js':'F1 return an existing unsettled plan without duplicate accrual; reject contradictory settled state.',
'calculator/test/engine.test.js':'F1 regression for repeated delayed proposal and later recovery; collision expectations updated.',
'keeper/engine.js':'F7 independent history reconstruction before mutations; verification result and injection seam for fixtures.',
'keeper/verify-history.js':'F7 reconstruct periods from independently read historical state, compare full records, enforce finality and remove temporary data.',
'keeper/test/verify-history.test.js':'F7 valid/incorrect history, invented balances, future periods, changed blocks and unavailable archive data.',
'keeper/test/engine.test.js':'F7 failure-before-transaction assertion; explicit stub only in lifecycle-only fixtures.',
'operations/fees.js':'F2 optional definite legacy estimation failures and attention status; F6 dependent reads pinned to confirmed receipt block.',
'operations/preflight.js':'F9 reuse deployment role validation, requiring proposer/guardian and checking keeper/admin and treasury/bot conflicts.',
'operations/test/preflight.test.js':'F9 missing-role and conflicting-role regressions reproduced before the fix; preserve shared owner/guardian support.',
'operations/provider.js':'Bounded keep-alive RPC transport, optional IPv4, 30-second timeout; existing closeProvider retained.',
'operations/test/fees.test.js':'F2 partial legacy behavior and fatal uncertain outcomes; F6 stale latest-balance regression; prove receipt ordering and later NFT activation.',
'package.json':'F4 dependency pins/override; wallets:check script.',
'package-lock.json':'Resolved dependency graph for F4, including transitive lockfile changes.',
'script/check-wallets.mjs':'Read-only test-wallet role/funding check; no signing and no printed keys.',
'script/deploy-sepolia.mjs':'F5 persisted deployment/action identity, --resume, confirmation/code checks, retained receipts and shared provider.',
'script/rehearse.mjs':'Locally signed HD roles, persistent local mode, wallet manifest/report, tool discovery and retained Anvil history.',
'script/run-fees.mjs':'F2 attention exit status, F6 snapshot-aware quote and shared provider.',
'script/run-floor.mjs':'Use shared bounded RPC provider; floor economics unchanged.',
'script/run-keeper.mjs':'Use shared bounded RPC provider; new independent verification executes through keeper engine.',
'script/run-monitor.mjs':'Use shared bounded RPC provider; existing monitor checks retained.',
'script/validate-public-sepolia.mjs':'Stateful public test deployment validation, fee accounting, actual timelock, blocked recipient/retry and zero-reserve closure.',
'script/soak-sepolia.mjs':'Finite 48-hour-test tick with role isolation, locks/recovery barriers, fee deltas and final reconciliation; default RPC changed after the prior endpoint pruned required journal history.',
'script/stress-calculator.mjs':'Independent synthetic reference for 10,000 holders/200,000 transfers and proof/pot conservation.',
'script/package-handoff.py':'Credential-excluding source/evidence ZIP and folder; file hashes; original comparison; apply-and-compare patch validation.',
'script/build-change-inventory.py':'Generate this complete source/document comparison and detect unaccounted changes.',
'src/DickbuttRewardsDistributor.sol':'Documentation only: replace unsupported 250–400 batch recommendation with per-transaction gas estimation guidance.',
'test/SplitsBaseFork.t.sol':'F3 deploy an actual distributor in the genuine-Splits fixture.',
'test/NativePipelineFork.t.sol':'Native Clanker/legacy/Splits/swap/push; staged custody, new owner and separate bots, explicit old-keeper revocation, USDC hop logs and unchanged total supply.',
'test/NativeAeroPositionFork.t.sol':'Real-manager local NFT, trades/fees/burn/payout; delayed transfer, owner acceptance, permanent locks beyond original expiry, unchanged liquidity/supply and empty repeat.',
'test/NativeBatchFork.t.sol':'Native SPCXc batches, duplicate prevention, reserve closure and measured oversized 400-recipient case.',
'ui/commands.js':'Local Foundry discovery; F8 shared deployment defaults; updated fee attention/deployment wording.',
'ui/deployment-paths.js':'F8 validate one explicit console manifest/calculator/journal selector, with historical fallback.',
'ui/local-wallets.js':'Authenticated endpoint helper for keyless loopback-only chain-31337 balances at one block.',
'ui/server.mjs':'Local wallet endpoint behind existing authorization; F8 use actual project root for state/forms/commands.',
'ui/state.js':'Resolve persistent local manifest and local network; F8 read explicitly selected Sepolia manifest.',
'ui/public/app.js':'Local network URL selection and Wallets rendering; eligible-holder wording.',
'ui/public/index.html':'Wallets panel container.',
'ui/public/styles.css':'Wallet table layout, horizontal scrolling and existing border-color token.',
'ui/test/commands.test.js':'Make the historical manifest explicit in an existing argument test so it does not rely on changing deployment defaults.',
'ui/test/deployment-paths.test.js':'F8 flow/form/argument agreement, explicit overrides, default fallback and invalid-selector rejection.',
'config/base-mainnet.json':'Descriptive note only: distinguish simplified before/after-payout balances under the share cap; all actual addresses/parameters unchanged.',
'config/console-deployment.json':'F8 select current public deployment, its exact calculator config and its journal.',
'config/deployment-sepolia-new.json':'Fresh public addresses, roles and source information; no private keys.',
'config/deployment-sepolia-new-calculator.json':'Exact chain/token/distributor, genesis scan block, exclusions, thresholds, linear weighting, 50-recipient batches and finality policy.',
'config/deployment-sepolia-new.json.receipts.json':'Retained 17 direct deployment records and 14 configuration hashes; router-created Split addresses are in manifest.',
'README.md':'Current report links/status, independent verification/owner authority, console selector, Base production roles and staged NFT handoff.',
'START-HERE.md':'Point to current complete report/inventory instead of treating supplied historical handoff as current proof.',
'AERODROME-SETUP.md':'Distinguish mock/local/production NFT evidence; staged later custody, immutable NFT ID and separately selected Base production roles.',
'AUDITOR-BRIEF.md':'Correct journal/owner trust claims and distinguish native fork/public test evidence from readiness.',
'ui/README.md':'Wallets tab, explicit shared deployment selector, new module responsibilities and limitations.',
'docs/COMPLETE-DEVELOPER-REPORT.md':'Full attribution, nine fixes, operations/evidence/release decision; staged Base handoff, final alignment checks and disclosed failed native invocation; UTC only.',
'docs/DEVELOPER-HANDOFF.md':'Concise F1–F9 ledger, fee meaning, final results, separately selected production roles and staged NFT prerequisites; UTC only.',
'docs/ALIGNMENT-RETEST-REPORT.md':'Latest specification-to-code review, ninth fix, all retest outcomes, exact native fees/hops, ownership/forever limitations, public status and GitHub availability.',
'docs/FILE-CHANGE-INVENTORY.md':'Every changed/added deliverable accounted for; unchanged Solidity classification and local exclusions.',
'docs/RUNNING-RESULTS.md':'Detailed snapshot of public fee transfers, balances, holder payments, tests and pending schedule; DICKBUTT naming; UTC only.',
'docs/TEST-RESULTS.md':'Current test/evidence matrix replacing obsolete unfunded-wallet/no-public-deployment claims; DICKBUTT naming; UTC only.',
'docs/HANDOFF.md':'Replace stale current-status claims with current handoff and link supplied history separately.',
'docs/history/HANDOFF-SUPPLIED.md':'Preserve supplied historical text below an attribution notice; rebase relative link targets for its archive directory.',
'docs/GOVERNANCE.md':'Correct owner/journal assumptions and monitor key wording; explicit old-role revocation, journal-bound exclusion migration and permanent-destination constraints.',
'docs/KEEPER.md':'Independent history replay, actual batch gas constraints, proposer operation and off-chain refusal boundaries.',
'docs/PRICE-FLOOR.md':'Reflect already-supported approved floor-setter or owner role.',
'docs/RUNBOOK.md':'Independent keeper reconstruction, trust/owner limits and recovery assumptions.',
'docs/REHEARSAL.md':'Signed wallet/persistent mode/history retention, current timelock behavior and public/native testing distinctions.',
'docs/SEPOLIA.md':'Current deployment/receipt recovery, separate role usage, actual one-host test scope and clearly labelled earlier deployment history.',
}
changed=[];unchanged=[];excluded=[]
for relative in sorted(files):
 p=root/relative;q=original/relative
 if '.partial' in p.name or '.local.' in p.name or p.name.startswith('.env'):
  excluded.append(str(relative));continue
 if not p.is_file():continue
 before=q.read_bytes() if q.is_file() else None;after=p.read_bytes()
 if before==after:unchanged.append(str(relative));continue
 name=str(relative)
 if name not in notes:raise SystemExit('Unaccounted changed deliverable: '+name)
 diff=list(difflib.ndiff((before or b'').decode().splitlines(),after.decode().splitlines()))
 changed.append((name,'Modified' if before is not None else 'Added',sum(x.startswith('+ ') for x in diff),sum(x.startswith('- ') for x in diff),notes[name]))
# A token comparison is useful evidence for the claim that the Solidity edits are comments only.
def strip(s):return re.sub(r'\s+','',re.sub(r'//[^\n]*|/\*[\s\S]*?\*/','',s))
logic_changes=[]
for p in (root/'src').rglob('*.sol'):
 rel=p.relative_to(root)
 if not (original/rel).is_file() or strip(p.read_text())!=strip((original/rel).read_text()):logic_changes.append(str(rel))
if logic_changes:raise SystemExit('Executable Solidity source changed: '+', '.join(logic_changes))
body='# Complete file change inventory\n\nGenerated by `script/build-change-inventory.py` against the original supplied project. This inventory covers source, tests, configuration and documents, not every temporary runtime cache. All substantive changes have an explicit description. Exact text differences are in `changes.patch`; hashes for shipped files are in `SOURCE-MANIFEST.json`.\n\n'
body+=f'**{len(changed)} changed/added source and document deliverables** are listed below. Changes in test tooling and documentation are not each counted as a separate fixed bug. There are nine underlying fix groups. The line counts are textual counts; this generated inventory\'s own row omits counts to avoid self-reference.\n\n'
body+='| File | Status | Lines added / removed | Complete purpose |\n| --- | --- | ---: | --- |\n'
for name,status,added,removed,note in changed:
 counts='generated' if name=='docs/FILE-CHANGE-INVENTORY.md' else f'{added} / {removed}'
 body+=f'| `{name}` | {status} | {counts} | {note} |\n'
body+='\n## Solidity scope\n\nAll `src/*.sol` files have the same executable text after removing comments/whitespace as the supplied project. Only the distributor batch-gas comment changed. This is a source comparison, not a compiler-metadata or deployed-bytecode equivalence proof. Constructor checks, fee percentages, role mechanics, reservation logic, mint/transfer behavior and custody functions were not rewritten in this task.\n\n'
body+='## Included execution evidence\n\nThe packager includes selected successful and failed regression logs, the final application/Solidity/extended/native runs, before/after dependency checks, the local receipt verification, the final local rehearsal report and journal, deployment/recovery logs, the public manifests and receipt ledger, public validation/payout logs and journal, live balance/monitor snapshots, test-ETH top-up receipts and every extended-run job log present at packaging. These are additional generated evidence files, not production source fixes. See the package manifest for the complete list.\n\n'
body+='## Local work intentionally not shipped\n\nThe funded-wallet `.env`, disposable `local.env` files, console session state/tokens, node_modules, out/cache, downloaded Foundry archives/binaries and temporary process locks are excluded. The local roles file contains public addresses but is also excluded from the generic source export; the public manifest already records the roles. A partial pre-resume backup is retained locally as recovery history, not used as an active deployment manifest.\n\nOne-off local tools reconstructed initial deployment receipts, reconciled the interrupted second fee cycle, reproduced/rechecked the wrong-recipient case, read public receipts/balances and inspected process state. Their effects and public evidence are described in the complete report. They are not ongoing production entry points and are not blindly rerun. Machine-local installation and the scheduled follow-up are operational work outside the source patch.\n\n'
if excluded:body+='Excluded local/configuration artifacts encountered: '+', '.join('`'+x+'`' for x in excluded)+'.\n\n'
body+='## Unchanged source/document files checked\n\nThese remain as supplied; they are not claimed as new fixes.\n\n'+''.join('- `'+x+'`\n' for x in unchanged)
output.write_text(body)
print(f'Inventory complete: {len(changed)} changed/added deliverables; {len(unchanged)} unchanged files checked; no executable Solidity text changes.')
