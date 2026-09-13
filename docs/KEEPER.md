# Rehearsal keeper

`script/run-keeper.mjs` consumes the calculator's committed `periods/*.json` journal. It defaults to a dry run. Transaction execution is restricted to local chain **31337** and Base Sepolia **84532**. Base mainnet execution is rejected. Keep holder, reward and distributor addresses specific to the selected deployment.

The keeper verifies the journal hash chain, every period's exact calculator configuration hash, holder token and distributor identity through that configuration, RPC chain identity, on-chain reward token, and recorded snapshot block hashes. It rebuilds every Merkle tree from payouts and compares roots, totals, complete trees and batches before any transaction. It checks all existing on-chain round commitments before processing rounds.

Before any proposal or payout, `keeper/verify-history.js` also reconstructs every journal period from historical blockchain data and the separately reviewed calculator configuration. It independently derives balances, time-weighted eligibility, accrual, reconciliation and payouts, and compares the complete result with the journal. A correctly rehashed payout file is not sufficient evidence. Periods beyond the selected real finality boundary are rejected. Full replay requires archive access and must be benchmarked against production history; an eventual cache must be controlled by the keeper host, not copied from the proposer.

## Run

Save the exact `config` object supplied to `runCalculator` as `calculator-config.json`; preserve its key ordering because the calculator hashes JSON serialization. Review this file independently of the journal. It contains chainId, token, distributor, deployBlock, holderThresholdRaw, payoutThresholdRaw, curve, excluded, batchSize, chunkSize and finalityTag. Do not substitute the deployment address manifest for this calculator configuration.

Choose `batchSize` using the actual SPCXc implementation, Merkle proof sizes and transaction gas estimates. A local native-token test used about 14.66 million execution gas for 256 fresh recipients, before transaction overhead. Base's current per-transaction cap is 16,777,216 gas; the much larger block limit does not make an oversized transaction valid. The public test configuration uses 50 recipients. There is no default: `buildPlan` rejects a config that omits `batchSize` rather than falling back to the former 250, which had no measured support. See the [Base configuration changelog](https://docs.base.org/base-chain/network-information/configuration-changelog).

Supply `RPC_URL` through the environment or an ignored `.env`. Supply `KEEPER_PRIVATE_KEY` only when executing. `OWNER_PRIVATE_KEY` is optional and is used only with `--propose`; without it the selected signing identity must also be allowed to propose. For separate proposer operations use `--propose-only` with only the proposer key available. Keys are never command-line arguments and are never included in structured output.

```sh
# Review all plans and on-chain progress without signing.
node script/run-keeper.mjs --config calculator-config.json --journal ./data

# Submit an explicitly reviewed proposal, then report the remaining timelock.
node script/run-keeper.mjs --config calculator-config.json --journal ./data --execute --propose

# After the timelock, activate, pay approved batches and close completed rounds.
node script/run-keeper.mjs --config calculator-config.json --journal ./data --execute --confirmations 1

# Run keeper verification tests.
node --test keeper/test/*.test.js
```

Owner proposal requires both `--execute` and `--propose`. Activation is permissionless after the contract's `readyAt` timestamp. Distribution requires an approved keeper. Closing is automatic only when every local recipient is marked paid **and** the on-chain distributed amount equals the committed total. A partial round remains active even if the signing account is the owner. The script never sends cancellation or early-close transactions.

A round whose on-chain root is not the journal's is **not** a halt. Rounds are independent, so the keeper reports it as `foreign-commitment` (pending or active) or `superseded` (closed), sends nothing for it, and continues with every other round. The standard CLI refuses that foreign commitment. This is off-chain behavior; a separately appointed keeper and an owner-controlled root remain within the broader administrative authority. The calculator recredits a superseded plan on its next run. A zero root against committed state, or a matching root with a different total, is still treated as corruption and stops the run.

The keeper processes one invocation and exits; it does not wait out a timelock or run an internal retry loop. Rerun the same command on a scheduler. Round and paid flags are reread each time, and paid accounts are removed from each submitted batch. A recipient failure produces a `payment-failed` event and leaves its unpaid amount available for a later rerun. Closed or cancelled rounds are reported and never reproposed. `closed-unpaid` requires calculator reconciliation to recredit unpaid holders in a later period.

## Monitoring and recovery

Standard output is JSON lines: `transaction-submitted`, `transaction-confirmed`, `payment-failed`, `recovered-transaction`, `keeper-complete`, and the final report. Reports include chain ID, round ID, root, total, remaining accounts and transaction hashes. Status values are `proposal-required`, `timelocked`, `activation-ready`, `distribution-ready`, `close-ready`, `partial`, `closed-unpaid`, `closed`, `foreign-commitment` and `superseded`.

Exit status is 0 for successful inspection or progression (including waiting on a timelock), 2 for remaining unpaid recipients, a rate-limited proposal or a foreign root at a planned round id, and 1 for an execution/validation failure. Alert on `payment-failed`, exit 1/2, unexpected commitment changes, and repeated `timelocked` beyond `readyAt`. Dry-run readiness does not predict gas estimation or token-transfer success.

Each transaction is submitted once and its receipt is awaited before sending the next. Reverted receipts stop the invocation. Submitted transaction hashes are persisted and flushed to `keeper-pending-transaction.json`; an unknown receipt retains that marker. On rerun the keeper refuses further sends until the recorded transaction has a receipt with the requested confirmations. Inspect any replacement transaction manually; the keeper does not guess whether a replacement paid or cancelled the operation. The CLI also rejects signers with a pending nonce. A crash in the small gap between broadcast and persisting the hash requires inspecting the signer's nonce and chain history before restarting.

The calculator journal's writer lock is held for the entire invocation. Execute mode also acquires process locks under the operating system temporary directory, keyed by chain ID and signer address, including a separate proposal signer when configured. This prevents two cooperating keeper processes on the same host from using the same signer concurrently across journal paths. The fee cycle shares the keeper's lock; a run waits up to `--lock-wait` seconds (default 300) for a peer to finish before failing, so a scheduled overlap is not a page. Lock metadata records PID, hostname and start time; a crashed process leaves its lock behind. Verify that the recorded process has stopped and inspect outstanding transactions before manually removing a stale lock. Locks do not coordinate separate hosts or unrelated transaction tools; use one keeper host and one durable journal per deployment/signer.

The journal is an integrity/replay mechanism, not a signature from the calculator or owner. Keep its filesystem and reviewed configuration under operational access control. Retain the complete journal for recovery; cached `state.json` is not an execution source.

## Embedded API

```js
import { ethers } from 'ethers';
import { runKeeper, KEEPER_ABI } from './keeper/engine.js';

const report = await runKeeper({
  dir: './data',
  provider,
  config, // exact object used by runCalculator
  distributor: new ethers.Contract(config.distributor, KEEPER_ABI, keeperSigner),
  signerAddress: await keeperSigner.getAddress(),
  execute: true,
  propose: false,
  confirmations: 1,
  onEvent: event => console.log(JSON.stringify(event)),
});
```

`ownerDistributor` and `ownerAddress` can optionally provide a separate owner-connected contract and signer address. They default to `distributor` and `signerAddress`. `execute` and `propose` default to false. Return shape: `{ mode, chainId, rounds, transactions }`; every round includes `{ roundId, root, total, status, unpaid, failed }`, and pending rounds also include `readyAt`. The API writes no calculator records and takes injected ethers-compatible contracts/providers for deterministic tests. It still acquires real local locks. It does not fund accounts, change keeper permissions or advance chain time; the local rehearsal controls those operations separately.
