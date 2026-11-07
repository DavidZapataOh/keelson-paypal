# Witness

The cosigning witness of the Alibi log: the official
[litewitness](https://github.com/FiloSottile/torchwood/tree/main/cmd/litewitness) and `witnessctl`
from torchwood v0.10.0, in one image. It implements [c2sp.org/tlog-witness](https://c2sp.org/tlog-witness):
`POST /add-checkpoint` cosigns a checkpoint only if it is consistent with the last one the witness
cosigned for that log, and answers `409` with the known size or `422` for a bad consistency proof.
`GET /` lists the known logs and their sizes.

Three witnesses operated by Keelson run this image on three providers; the log publishes a
checkpoint only when two of them cosign it.

## Run

| Variable       |                                                                          |
| -------------- | ------------------------------------------------------------------------ |
| `WITNESS_NAME` | Name in the cosignature lines, e.g. `witness-1.keelson.finance`          |
| `WITNESS_KEY`  | OpenSSH Ed25519 private key                                              |
| `WITNESS_LOGS` | `origin=vkey` pairs separated by `;`, the logs the witness cosigns       |
| `DB`           | SQLite database, on a persistent volume (default `/data/litewitness.db`) |
| `PORT`         | HTTP listener (default `7380`); HTTPS is terminated in front of it       |

The entrypoint loads the key into a dedicated `ssh-agent`, as litewitness requires, registers the
logs with `witnessctl add-log` and `add-key` (once; a log is never removed), and runs litewitness.
The database is the witness's memory: a witness that lost it would cosign a rolled-back tree, so it
always lives on persistent storage.

The witness's `cosignature/v1` verifier key is the `vkey` litewitness logs at startup.
