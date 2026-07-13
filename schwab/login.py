#!/usr/bin/env python3
"""Interactive Schwab OAuth login (SPEC 11: investments are read-only).

Run this once to authorize and again whenever the refresh token expires, which
Schwab forces every 7 days. It walks the schwab-py login flow: it opens the Schwab
authorization URL in a browser, you sign in and approve, and the local callback server captures the redirect. The
resulting token is written to SCHWAB_TOKEN_PATH for the headless daily fetch to
reuse.

Reads env: SCHWAB_APP_KEY, SCHWAB_APP_SECRET, SCHWAB_CALLBACK_URL (default
https://127.0.0.1), SCHWAB_TOKEN_PATH (default ./schwab-token.json).

Never prints token contents. Secrets stay in memory and on disk, never on screen.
"""
import os
import sys

import schwab


def main():
    app_key = os.environ.get("SCHWAB_APP_KEY")
    app_secret = os.environ.get("SCHWAB_APP_SECRET")
    callback_url = os.environ.get("SCHWAB_CALLBACK_URL", "https://127.0.0.1")
    token_path = os.environ.get("SCHWAB_TOKEN_PATH", "./schwab-token.json")

    missing = [
        name
        for name, value in (("SCHWAB_APP_KEY", app_key), ("SCHWAB_APP_SECRET", app_secret))
        if not value
    ]
    if missing:
        print(
            "Missing required environment variables: " + ", ".join(missing) + ".",
            file=sys.stderr,
        )
        print(
            "Set them in agents/.env (or the shell) and run this again.",
            file=sys.stderr,
        )
        sys.exit(1)

    print("Starting the Schwab login flow.")
    print(
        "A browser will open (or a URL will be shown). Sign in to Schwab, approve "
        "access; the local callback server completes the exchange automatically."
    )
    print("This authorization lasts about 7 days before Schwab requires it again.")

    schwab.auth.client_from_login_flow(
        api_key=app_key,
        app_secret=app_secret,
        callback_url=callback_url,
        token_path=token_path,
    )

    print("Schwab authorization complete. Token saved. The daily fetch can now run.")


if __name__ == "__main__":
    main()
