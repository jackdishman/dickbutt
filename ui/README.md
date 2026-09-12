# Console

A local control panel for the fee flywheel: the flow diagram, the launch checklist, the Base mainnet
addresses and the operating commands, all reading the same files the CLIs read.

```sh
npm run console                              # read-only
npm run console -- --allow-execute           # also permits the commands that sign and broadcast
npm run console -- --port 4400 --no-open
```

It prints a URL containing a session token and opens it. Nothing is installed and nothing is cached.

## What each tab is for

**Flow** resolves every node in the diagram against the selected network. On Base mainnet the
contracts in this repository read as *not deployed here*, because they are not; on Base Sepolia they
read as *deployed*, with the addresses from the live manifest. Edge colour is the token and every
edge is labelled, so the path survives a monochrome print or a colour-vision difference. Selecting a
node gives its role, the contract behind it and the open question attached to it.

**Checklist** is the launch list, split by where the evidence lives:

- *derived* items are read from `config/base-mainnet.json` and friends and **cannot be ticked by
  hand**. A null `deployment.owner` is a blocker whether or not anyone checked a box. This is the
  point of the split: a tick must never outrank the config it describes.
- the rest — a handoff signed on a multisig, an external review, a key funded — have no local
  evidence, so they are recorded here into `ui/checklist.local.json`, which is gitignored.

**Configure** writes the narrow set of address fields the console owns, straight into
`config/base-mainnet.json`. Everything else in that file is evidence — verified balances, recorded
block numbers, the rejected swap route — and is not editable here. It also shows the round bounds,
the operating hosts rendered from `operations/schedule.js`, which environment variables are set, and
the calculator exclusion set.

**Operate** runs the commands. **Docs** reads the repository's own markdown, with working
cross-links.

## Why it is built the way it is

This is a panel that can spend money, so it is deliberately unexciting about access:

- it binds to the loopback interface only, and `--host` refuses anything else;
- every request carries a token minted at startup, compared in constant time;
- the `Origin` and `Sec-Fetch-Site` headers must be the console's own, so a page on another site
  cannot drive it even though it cannot read the replies either;
- commands come from a fixed registry with typed slots, spawned **without a shell**. Nothing from
  the browser ever reaches a command line;
- transaction-sending commands need `--allow-execute` *and* an explicit confirmation in the request;
- private keys are never read here. The child CLIs load their own from the environment, and the API
  reports only whether a variable is set.

The page builds its DOM with `document.createElement` rather than `innerHTML`: most of what it shows
is repository text and command output, and neither should be able to become markup.

Edge routing is orthogonal with allocated channels instead of curves. Curves look fine until two of
them run through the same gap, and "looks fine" is not checkable — `test/flow.test.js` asserts that
no edge crosses a node it does not touch, that no two edges share a channel, and that no two labels
land on top of each other.

## Layout

| File | Responsibility |
| --- | --- |
| `flow.js` | The diagram as data: nodes, edges, layout and deterministic edge routing. Pure. |
| `readiness.js` | The launch checklist: which items derive from the repository and which are recorded. Pure. |
| `commands.js` | The command registry, the argv builders and the execute gate. Pure. |
| `state.js` | Filesystem reads, config edits and the network resolution the diagram draws from. |
| `server.mjs` | Loopback HTTP server, the API, the SSE run stream and the child-process runner. |
| `public/` | The page. No build step, no framework, no dependencies. |

## Limits

The console runs commands; it does not replace them. It has no scheduler, so it is not how the four
bot roles run in production — `npm run schedule` and [the runbook](../docs/RUNBOOK.md) cover that. It
holds no keys and signs nothing itself. And the exit-code convention is the CLIs': **0 fine, 2 a
human is needed, 1 the command failed**; the run list colours them accordingly.
