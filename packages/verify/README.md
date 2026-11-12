# @keelson-finance/verifier

Verifies a Keelson Alibi on your machine, trusting no one: both TEE countersignatures and
attestations, the evidence manifest, the transparency log inclusion proof and its witnesses and,
with `--chain`, the anchor on Arbitrum Sepolia. Same code as https://verify.keelson.finance.

```js
import { verifyAlibi, fetchAndVerify } from "@keelson-finance/verifier";

const report = await verifyAlibi(bytes); // bytes as issued, base64, JSON text or a parsed object
report.verdict; // "verified-offline", "verified" with { chain: true }, "failed" or "incomplete"
```

```sh
keelson-verify alibi.json            # a file
keelson-verify - < alibi.json        # stdin
keelson-verify 01M75ZQSJDFE8K76ZKZT08X1B2 --chain --json
```

Exit status: 0 verified, 1 failed, 2 incomplete. Apache-2.0.
