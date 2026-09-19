# Independent contract review — final pass, 20 September 2026

Candidate starting commit: `4a7e7a68d0ee3ac881214c77f8f82b3ca749a5de`.

## Pre-test architecture and attack hypotheses

Read the user's Professional Solidity Security Audit Prompt, the prior attack-surface map/report, every application Solidity contract and relevant existing adversarial tests. Production flow is fixed-source claims → immutable Splits routing → bounded fixed-route swap → reserved Merkle push rounds. Basic volatile LP custody is separately locked and does not grant caller withdrawal rights. No project proxy/delegatecall/signature/permit/bridge surface exists.

Focused invariants: claims preserve LP principal; caller cannot redirect fees; destination cancellation cannot later execute; freeze cannot conceal pending redirection; unrelated-token rescue cannot become LP approval/withdrawal; swap allowances are exact/temporary and revert atomically; pre-existing output cannot satisfy current output; callback permissionless lifecycle changes preserve reserve accounting; false ERC20 returns preserve payment credit and no-return standard transfers work; round proofs cannot replay at different IDs.

**No new confirmed exploitable finding before test construction.** No production code has been changed by this reviewer. Additional tests are in `test/audit/FinalContractBoundaries.t.sol`.

## Assumptions to challenge, not automatically vulnerabilities

- A timelocked destination proposal survives a two-step ownership transfer. This is normal persistent contract state, but the receiving Safe must inspect and cancel any unwanted proposal before accepting/funding. A former owner cannot create a new proposal after acceptance. A test will demonstrate the inheritance and cancellation path; this is an operational handoff observation, not unprivileged takeover.
- SafeERC20 trusts a success-returning ERC20 to transfer the requested amount. The already documented taxed/no-op/rebase asset incompatibility remains. Production native token policy is external governance; no claim that arbitrary token behavior is supported.
- A malicious router or fee source selected by a compromised administrator can make calls fail. Constructor binding plus deployed-address/runtime verification is the trust boundary. Tests will challenge the guard and exact asset-delta checks even under malicious router behavior, without representing an attack on the authentic deployed router.
- The owner quorum can nominate itself keeper/proposer and redirect rewards through a valid root. The absence of reward rescue is not a restriction on this administrative power.

## Results

Pending local adversarial run; append exact command/count/evidence after execution.

## Completed independent results

Manual review covered all production sources (`AerodromeVammHarvester`, `DickbuttRewardsDistributor`, `SpcxcSwapExecutor`, `SplitsFeeRouter`, `SplitsV2Interfaces`, `LockerHarvester`, `LegacyFeeHarvester`) and historical `FeeSplitter`/`AerodromeFeeHarvester`. Checked external call order, inherited owner transfer/renunciation, loop bounds, immutable asset/route identities, floor arithmetic, aggregate accounting, ERC20 behavior, no arbitrary-call surfaces and authority scope. Existing token callback, stateful LP and accounting invariants were read rather than claimed as newly authored tests.

Local additional tests: **10 passed, 0 failed, 0 skipped** across two isolated suites, including **2,048 fuzz inputs** for ceiling-rounded swap floors. Compiler solc 0.8.24, optimizer 200, viaIR; the focused run emitted no compiler warnings. Evidence: `contract-test.log`. Compilation/cache were isolated from the parent audit's run.

Command from repository root:

```sh
../base-foundry/forge test --offline --match-contract 'FinalContract.*AuditTest' \
  --out ../../outputs/final-audit-2026-09-20/contract-out \
  --cache-path ../../outputs/final-audit-2026-09-20/contract-cache \
  --fuzz-runs 2048 -vv
```

### Added tests and conclusions

- Mature destination cancellation clears both target/time, subsequent stranger application fails, and fees retain original recipients.
- Pending proposals prevent freezing; permanent principal/destination locks do not disable legitimate unrelated-token rescue or grant any LP spender allowance.
- Two-step owner handoff preserves pending proposals, and only the new owner can cancel them. The old owner cannot alter state after acceptance.
- False-return reward transfers preserve unpaid credit/reservation; no-return standard transfer succeeds once and duplicate retry does not pay twice.
- Permissionless activation of a different reserved round during an ERC20 callback preserves both rounds' aggregate reserve accounting.
- A proof committed with round ID 1 cannot pay in round ID 2, even to the same recipient for the same amount.
- Malicious router excess-input attempts, fabricated output with existing distributor funds, unexpected input donation and post-transfer revert all atomically restore balances, allowance and cooldown state.
- A router explicitly granted keeper permission still cannot reenter swap/forward functions or grant itself administrative/floor authority through its callback.
- Positive enforced floors are rounded upward across 2,048 bounded amounts/rates; exact spend and zero final allowance hold.
- Frozen Clanker destination still permits owner recovery after upstream unlock; the recovered NFT owner can collect to another address. This is intended governance authority, not an unprivileged exploit.

## Final observations and changes

**CR-I-01 (Informational, corrected documentation):** `LockerHarvester.sol` NatSpec overstated the scope of `lockDestinationForever()`. It freezes this adapter's destination; it does not remove `recoverReleasedPosition` after the upstream lock expires. The additional deterministic test proves the distinction. With the parent's approval, comments were corrected only; no runtime control flow, access checks, storage layout or fee parameters changed. New compiler metadata/build hashes must be regenerated by the parent audit because Solidity source comments are compiler inputs.

**CR-I-02 (Informational, handoff checklist required):** `AerodromeVammHarvester.proposeDestination/applyDestination/cancelDestinationChange` at lines 106–123 retains pending target/time across inherited Ownable2Step acceptance. This is normal governance state persistence. Before LP/authority funding and whenever transferring contract ownership, the accepting Safe should inspect `pendingDestination`/`pendingDestinationReadyAt` on both harvesters and have unwanted proposals cancelled; ownership acceptance alone does not clear them. The same persistent-state principle applies to pre-existing bot roles and pending owner nominations. No contract patch is recommended merely to erase governance history automatically.

No new Critical/High/Medium/Low exploitable production-contract finding was established in this independent pass. This result is bounded: no formal proof, no validation of the user's uncreated actual pool, and no guarantee against authentic dependency policy changes, compromised owner/proposer+keeper/RPC environments, profitable market manipulation or indefinite bot availability. Production qualification still requires the actual configured deployment and pool, independently operated signers, economic floor/size review and handoff-state verification. The parent's integration/static/fork runs provide their separate evidence; they are not counted as tests executed by this reviewer.
