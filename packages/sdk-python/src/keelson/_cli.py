from __future__ import annotations

import asyncio
import base64
import json
import sys

from ._credentials import credentials_path, read_credentials, stored_login
from ._login import login

USAGE = """Usage: keelson <command>

  login    Sign in to Keelson in your browser and save the sign-in
  whoami   Show who you are signed in as, and what you may do
  logout   Forget the saved sign-in"""


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else "help"
    try:
        if command == "login":
            asyncio.run(login())
        elif command == "whoami":
            if read_credentials() is None:
                raise SystemExit("Not signed in. Run `keelson login`.")
            token = asyncio.run(stored_login().token())
            part = token.split(".")[1]
            claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
            print(f"user   {claims.get('sub')}\nscopes {claims.get('scope')}")
        elif command == "logout":
            credentials_path().unlink(missing_ok=True)
            print("Signed out.")
        else:
            print(USAGE)
            if command not in ("help", "--help"):
                raise SystemExit(2)
    except Exception as err:
        raise SystemExit(str(err)) from err
