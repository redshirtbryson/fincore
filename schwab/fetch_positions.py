#!/usr/bin/env python3
"""Headless Schwab positions fetch (SPEC 11: read-only, positions into net worth).

Invoked by the Node layer (agents/lib/schwab.js). Loads the token written by
login.py, pulls accounts with positions, and prints EXACTLY ONE JSON object to
stdout and nothing else. Every diagnostic goes to stderr so stdout stays a clean,
parseable line for the caller.

Flag, do not guess: if the token is missing or expired, or the API returns a bad
status, we emit a structured failure object rather than fabricating balances. A
missing field in the raw payload becomes null, never a made-up number.

Reads env: SCHWAB_APP_KEY, SCHWAB_APP_SECRET, SCHWAB_TOKEN_PATH (default
./schwab-token.json). SCHWAB_CALLBACK_URL is not needed here (token already minted).

Success stdout:
  {"ok": true, "accounts": [ {account...} ]}
Failure stdout (also exit 1):
  {"ok": false, "error": "<message>", "tokenExpired": <bool>}

Never prints token contents or full account numbers. Only the last 4 digits of an
account number ever leave this process.
"""
import json
import os
import sys

import schwab

TOKEN_EXPIRED_MESSAGE = "Schwab token missing or expired; run: npm run schwab-auth"


def emit_failure(message, token_expired):
    """Print the single-object failure line and exit non-zero."""
    print(json.dumps({"ok": False, "error": message, "tokenExpired": bool(token_expired)}))
    sys.exit(1)


def get(obj, *keys, default=None):
    """Defensive nested lookup: any missing/non-dict level yields the default."""
    cur = obj
    for key in keys:
        if not isinstance(cur, dict) or key not in cur:
            return default
        cur = cur[key]
    return cur


def num(value):
    """A finite number or None. Never coerces junk into a fake figure."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    return None


def last4(account_number):
    """Last 4 characters of the account number, or empty string. Never the full number."""
    if account_number is None:
        return ""
    text = str(account_number)
    return text[-4:] if text else ""


def normalize_position(raw):
    """One raw position dict into the flat shape the Node layer expects."""
    long_qty = num(get(raw, "longQuantity", default=0)) or 0
    short_qty = num(get(raw, "shortQuantity", default=0)) or 0
    return {
        "symbol": get(raw, "instrument", "symbol", default=""),
        "assetType": get(raw, "instrument", "assetType", default="") or "",
        "quantity": long_qty - short_qty,
        "marketValue": num(get(raw, "marketValue")),
        "averagePrice": num(get(raw, "averagePrice")),
    }


def normalize_account(wrapper):
    """Unwrap {"securitiesAccount": {...}} defensively into an account summary."""
    account = get(wrapper, "securitiesAccount", default={}) or {}
    raw_positions = account.get("positions") if isinstance(account, dict) else None
    positions = []
    if isinstance(raw_positions, list):
        for raw in raw_positions:
            if isinstance(raw, dict):
                positions.append(normalize_position(raw))
    return {
        "type": account.get("type", "") if isinstance(account, dict) else "",
        "accountNumberLast4": last4(account.get("accountNumber") if isinstance(account, dict) else None),
        "liquidationValue": num(get(account, "currentBalances", "liquidationValue")),
        "cashBalance": num(get(account, "currentBalances", "cashBalance")),
        "positions": positions,
    }


def is_token_problem(exc):
    """True when the exception looks like a missing/expired token or auth failure.

    Word-boundary matching: bare substrings would misclassify unrelated errors
    ('401' inside a byte count, 'expired' in a TLS certificate message would still
    be auth-ish, but 'token' inside a JSON parse error would not be).
    """
    import re

    if isinstance(exc, FileNotFoundError):
        return True
    text = f"{type(exc).__name__} {exc}".lower()
    return bool(
        re.search(r"\b(401|unauthorized|invalid_grant|refresh token|token (is )?(invalid|expired|missing))\b", text)
        or re.search(r"\baccess token\b.*\b(expired|invalid)\b", text)
    )


def main():
    app_key = os.environ.get("SCHWAB_APP_KEY")
    app_secret = os.environ.get("SCHWAB_APP_SECRET")
    token_path = os.environ.get("SCHWAB_TOKEN_PATH", "./schwab-token.json")

    missing = [
        name
        for name, value in (("SCHWAB_APP_KEY", app_key), ("SCHWAB_APP_SECRET", app_secret))
        if not value
    ]
    if missing:
        emit_failure(
            "Missing required environment variables: " + ", ".join(missing) + ".",
            token_expired=False,
        )

    if not os.path.exists(token_path):
        # No token on disk is the classic expired/never-authorized case.
        print(f"Token file not found at {token_path}.", file=sys.stderr)
        emit_failure(TOKEN_EXPIRED_MESSAGE, token_expired=True)

    try:
        client = schwab.auth.client_from_token_file(token_path, app_key, app_secret)
    except FileNotFoundError:
        emit_failure(TOKEN_EXPIRED_MESSAGE, token_expired=True)
    except Exception as exc:  # noqa: BLE001 - any auth-time failure is fatal here.
        if is_token_problem(exc):
            emit_failure(TOKEN_EXPIRED_MESSAGE, token_expired=True)
        emit_failure(f"Failed to load Schwab client: {exc}", token_expired=False)

    try:
        response = client.get_accounts(
            fields=schwab.client.Client.Account.Fields.POSITIONS
        )
    except Exception as exc:  # noqa: BLE001
        if is_token_problem(exc):
            emit_failure(TOKEN_EXPIRED_MESSAGE, token_expired=True)
        emit_failure(f"Schwab get_accounts failed: {exc}", token_expired=False)

    status = getattr(response, "status_code", None)
    if status is not None and status != 200:
        if status in (401, 403):
            emit_failure(TOKEN_EXPIRED_MESSAGE, token_expired=True)
        emit_failure(f"Schwab get_accounts returned HTTP {status}.", token_expired=False)

    try:
        raw = response.json()
    except Exception as exc:  # noqa: BLE001
        emit_failure(f"Could not parse Schwab response as JSON: {exc}", token_expired=False)

    wrappers = raw if isinstance(raw, list) else []
    accounts = [normalize_account(w) for w in wrappers if isinstance(w, dict)]

    print(json.dumps({"ok": True, "accounts": accounts}))


if __name__ == "__main__":
    main()
