# Monitor

A monitor of the Alibi logs. It follows both origins with Tessera's
[`LogStateTracker`](https://pkg.go.dev/github.com/transparency-dev/tessera/client#LogStateTracker)
and checks, against keys and policies pinned in its own build:

- every checkpoint's log signatures (Ed25519 and ML-DSA-44) and witness quorum (two of the three
  witnesses operated by Keelson), with [torchwood](https://pkg.go.dev/filippo.io/torchwood);
- consistency between every pair of checkpoints it sees. A checkpoint at the size it already
  verified with another root, one that no consistency proof joins to its view, or a log that went
  back below its view is reported;
- every leaf: its format (`internal/alibilog`, byte for byte) and its inclusion, by folding every
  leaf hash into a compact range that must equal the checkpoint's root. Leaves countersigned by the
  TDX leg alone (`"mode":"degraded"`, only while the Nitro leg is down) are counted and listed;
- every checkpoint body the log co-logs in [Sigsum](https://www.sigsum.org)
  (`sigsum/<size>.msg` and `.proof`), whose proof it verifies under the Sigsum policy and compares
  with the checkpoint it verified at that size.

The TEE signatures of each leaf (against the on-chain signer registry) and the on-chain checkpoint
anchors are not checked yet; `/report` and the page say so.

Its view lives in `$MONITOR_DATA_DIR/state.json`, written atomically, so a restart resumes from the
last verified checkpoint and a log rolled back below it is caught rather than followed again from
zero.

**Deployment:** <https://keelson-monitor-production.up.railway.app>, a public monitor operated by
Keelson, on Railway under a Railway-provided domain: a different provider and DNS from the log
(Render, `keelson.finance` on Cloudflare). It holds no Keelson secret and reads only the public log,
Sigsum and its pinned files. Because Keelson operates it, it is no more independent than Keelson;
the point of the section below is that anyone can run the same binary.

## What it trusts

| File                                                                         | Pins                                                                  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`policy/alibi-2026-1.policy`](policy/alibi-2026-1.policy)                   | Log keys and witness quorum of `log.keelson.finance/alibi/2026-1`      |
| [`policy/alibi-live-2026-1.policy`](policy/alibi-live-2026-1.policy)         | Log keys and witness quorum of `log.keelson.finance/alibi-live/2026-1` |
| [`policy/conformance-2026-1.policy`](policy/conformance-2026-1.policy)       | Log key of the test origin `log.keelson.finance/conformance/2026-1`    |
| [`policy/sigsum-seasalp.policy`](policy/sigsum-seasalp.policy)               | Sigsum log and witness quorum the checkpoints are co-logged under     |
| [`policy/sigsum-submit.pub`](policy/sigsum-submit.pub)                       | The key the log co-logs with                                          |

They are embedded in the binary and never fetched from the log. If you run your own monitor,
compare them with what the log publishes at `https://<origin>/policy` and with
[`services/log/policy`](../log/policy): a monitor is only as good as the keys it pins.

## API

| Request                       | Answer                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /report`                 | Per origin: size, root, latest verified checkpoint, cosigners, leaves audited, degraded leaves, Sigsum status, findings     |
| `GET /checkpoints/<origin>`   | The latest verified signed checkpoint, `text/plain`                                                                         |
| `POST /gossip`                | A signed checkpoint (`text/plain`, at most 16 KiB, 10 a minute per client): `200 {status}`, `409 {equivocation}` or `422`   |
| `GET /equivocations`          | `[{id, origin, kind, detectedAt}]`                                                                                          |
| `GET /equivocations/<id>`     | `{origin, kind, a, b, consistencyProof?, sigsumProof?, detectedAt}`: the two conflicting views; never rewritten             |
| `GET /`                       | The public page                                                                                                             |

A gossiped checkpoint needs only the log's signatures, so a split view shown to a single user is
still caught: `status` is `consistent`, `ahead` or `behind` the monitor's view, and a conflict
answers `409` with the ID of the stored proof. `kind` is `same-size`, `inconsistent` or `sigsum`;
the ID is the SHA-256 of the two checkpoint bodies, sorted. To check what your browser or client
was shown:

```sh
curl -s https://log.keelson.finance/alibi/2026-1/checkpoint |
  curl -s --data-binary @- -H 'Content-Type: text/plain' https://keelson-monitor-production.up.railway.app/gossip
```

The conformance origin has no served tree: the monitor knows it only through gossip and keeps one
checkpoint per size, so two conflicting checkpoints of the same size are a drill the page lists
apart from the production logs.

## The page

The page shows the report beside a **Verify in your browser** panel, whose result comes only from
`verifier.wasm` (built from [`wasm/`](wasm) with the same Go packages) over data fetched directly
from the log: it checks the checkpoint under the pinned policy, proves consistency with the
checkpoint saved in `localStorage` on your previous visit, and verifies the inclusion and format of
any leaf, rebuilding every proof from tiles it checks against the root.

## Run your own monitor

With Docker, from the repository root:

```sh
docker build -f services/monitor/Dockerfile -t keelson-monitor .
docker run -p 8080:8080 -v keelson-monitor:/data keelson-monitor
```

Or with Go (the page then loads without its in-browser verifier, which the Dockerfile builds):

```sh
MONITOR_DATA_DIR=./monitor-data go run ./services/monitor
```

On your own Railway account, from `services/monitor` (the volume, healthcheck and variables are in
[`.railway/railway.ts`](.railway/railway.ts); the image is built from the repository root):

```sh
railway init --name keelson-monitor && railway config apply
railway up ../.. --path-as-root --service keelson-monitor
railway domain --service keelson-monitor --port 8080
```

| Variable                   |                                                                               |
| -------------------------- | ----------------------------------------------------------------------------- |
| `MONITOR_DATA_DIR`         | Where the view and the proofs are kept, on persistent storage (required)      |
| `PORT`                     | HTTP listener (default `8080`)                                                |
| `LOG_URL`                  | Where the log is read (default `https://log.keelson.finance`), e.g. a mirror  |
| `MONITOR_CLIENT_IP_HEADER` | The header a proxy in front sets to the client address, such as `X-Real-IP`   |

## Tests

`go test -race ./services/monitor/` runs a real Tessera log with three litewitness witnesses on
temporary directories, writes entries with the appender directly (as an operator who bypasses
admission could), and serves split views, rollbacks, foreign keys and malformed leaves.
`pnpm --filter @keelson/monitor test` drives the page in Chromium over such a log, altering the
checkpoint, a tile and a leaf in flight. `go test -tags live -run Live ./services/monitor/` checks the
production logs and, with `MONITOR_URL` and `LOG_SIGNER_KEY_CONFORMANCE`, runs a drill against the
deployed monitor.
