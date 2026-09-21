# Explicit Base mainnet operating mode

The fee, floor and keeper commands remain read-only unless `--execute` is present. Base mainnet
(chain 8453) additionally requires `--allow-mainnet` on each command. There is no environment switch,
no persisted automatic enablement and no implication from deploying a contract. The exported
`runFeeCycle`, `runFloorRefresh` and `runKeeper` functions require the equivalent boolean
`allowMainnet: true` as well as `execute: true`.

This feature makes reviewed production operation possible; it does not establish that the current
addresses, hosting, custody handoffs, keys or economic parameters are ready for launch. No live
transactions or installed schedules are created by this change.

## Required checks

`operations/execution-network.js` rejects unknown networks and rejects the mainnet option on any
network other than 8453. RPC and configuration chain IDs must agree. The mainnet option cannot be
passed as a truthy string through the library API.

Fee and floor operation require the complete Base manifest, nonzero distinct pipeline addresses,
explicit Aerodrome kind and pool/factory, and validated separate operating roles. The direct library
entry points check the addresses and deployed code of their supplied contract objects. The executor's
WETH, SPCXc, distributor and owner must match the manifest. The fee path also checks KC, CDB, burn,
router and harvester destinations, including the recorded vAMM pool and its recipients. A fee signer
must be the manifest keeper and an approved executor keeper before any source is harvested. A
production floor signer must be the manifest ops address; its existing role and keeper-separation
checks remain in effect. The ops and proposer addresses must differ.

Keeper operation requires the matching calculator identity, explicit positive thresholds and scan
parameters, `finalityTag: finalized`, reviewed exclusions including the distributor, and a batch size
at most 200. This is a conservative ceiling from the existing Base batch measurements, not a gas
estimate for a particular future transaction. The keeper still validates the on-chain distributor,
reward token, journal identity, Merkle plans, snapshot hashes, commitments, signer permissions,
nonces and unresolved transactions. Independent history reconstruction must succeed before any
mutation. An idle executed invocation may skip this expensive reconstruction; its result explicitly
reports that it has not performed independent verification. A dry run still performs full verification.
Fully distributed closed rounds skip historical recipient payment-flag queries; partially distributed
closed rounds still report unpaid recipients. Original round commitments and journal records remain
checked, so this reduces repeated work without establishing a fixed long-term RPC or memory cost.

These comparisons detect mismatches against the supplied configuration; they do not authenticate
an unreviewed configuration or replace verifying deployed bytecode and custody decisions. The
keeper must receive its configuration and journal through independently controlled operations.

## Run and render

After deploying and independently verifying the addresses, first run each command without
`--execute`. Including `--allow-mainnet` in a dry run exercises the additional production identity
checks without sending transactions:

```sh
npm run fees -- --config deployment.json --allow-mainnet
npm run floor -- --config deployment.json --allow-mainnet
npm run keeper -- --config calculator-config.json --journal ./data --allow-mainnet
```

Only an approved production launch adds `--execute`. The proposer also uses `--propose-only` and
runs on its own host without `KEEPER_PRIVATE_KEY`. The floor host uses `OPS_PRIVATE_KEY`, the
keeper host uses `KEEPER_PRIVATE_KEY`, and the monitor has no signing key.

The normal schedule renderer omits the mainnet option. To explicitly produce mainnet commands:

```sh
npm run schedule -- --format systemd --host keeper --workdir /srv/dickbutt \
  --manifest deployment.json --calculator calculator-config.json --journal ./data --allow-mainnet
```

Both configuration files must already exist relative to `--workdir` (or use absolute paths). The
renderer validates both as Base configurations and requires matching token/distributor identities
and pipeline/role exclusions. It attaches the option only to the fee, floor and keeper invocations,
including the keeper half of calculate-and-propose. Calculator indexing and keyless monitor
commands receive no transaction permission. Rendering prints a draft and installs nothing.

## Validation and remaining launch work

Mocked Base tests cover the disabled default, wrong-network opt-in, malformed configuration,
wrong objects or destinations, missing bytecode, wrong signers, floor/keeper separation, no-write
dry runs, all fee sources followed by split/swap, and schedule flag placement and file identities.
Keeper tests cover valid explicit opt-in and independent-history rejection before any send. The
existing nonce, receipt, fee-source failure, keeper and schedule escaping regressions also run.

No actual Base mainnet transaction, private key or paid service is needed for these tests. They do
not replace a dry run against the final deployed contracts, a separately reviewed Base fork test,
full history indexing measurements, gas estimates, signer funding, custody handoff checks,
independent key administration, monitoring delivery and backup/recovery exercises.
