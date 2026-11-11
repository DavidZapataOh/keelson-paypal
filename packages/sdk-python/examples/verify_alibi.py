"""Verifies a purchase's Alibi on this machine, with the same checks as verify.keelson.finance.

python examples/verify_alibi.py <purchase_id>           offline: nothing but the download
python examples/verify_alibi.py <purchase_id> --chain   also reads the anchor on Arbitrum
"""

import sys

from keelson import create_client, fetch_alibi, verify_alibi

purchase_id, *flags = sys.argv[1:]
report = verify_alibi(fetch_alibi(create_client(), purchase_id), chain="--chain" in flags)
for check in report["checks"]:
    print(f"{check['status']:<12} {check['id']}  {check.get('reason', '')}".rstrip())
print(report["verdict"])
