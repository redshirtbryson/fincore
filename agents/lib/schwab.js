// Schwab ingestion (SPEC 11: investments are READ-ONLY, positions into net worth).
// The Python sidecar (schwab/fetch_positions.py) owns OAuth via schwab-py, the
// canonical library; this module invokes it, normalizes its single-line JSON, and
// ingests positions into fincore.db.
//
// Schwab forces the refresh token to expire every 7 days, so token-expiry is a
// first-class, distinct failure here: when the sidecar reports it (tokenExpired or
// the "schwab-auth" hint in its output), the caller can tell the user exactly what
// to do, which is run `npm run schwab-auth`. Everything else fails as a generic
// error rather than a fabricated balance (flag, never guess).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Round to cents without carrying binary float noise into stored money.
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Turn the sidecar's parsed JSON into flat position rows plus a list of flags.
// Pure and exported so the money math is unit-testable without a subprocess.
//
// Contract:
//   - payload.ok !== true  -> no positions, one flag (payload.error or a default).
//   - empty accounts array -> no positions, flag 'schwab returned no accounts'.
//   - each account labels its rows `${type||'schwab'}:${last4||'????'}`.
//   - a position needs a finite Number(marketValue) to ingest; otherwise it is a
//     flag named by symbol+account and is NEVER ingested (a broken value must not
//     become $0 in net worth).
//   - cost basis is quantity*averagePrice only when both are finite, else null.
//   - a finite, nonzero cashBalance becomes a CASH pseudo-position on that account.
export function normalizeSchwabPayload(payload) {
  if (!payload || payload.ok !== true) {
    return { positions: [], flags: [payload?.error || 'schwab payload not ok'] };
  }

  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  if (accounts.length === 0) {
    return { positions: [], flags: ['schwab returned no accounts'] };
  }

  const positions = [];
  const flags = [];

  for (const account of accounts) {
    const type = account?.type;
    const last4 = account?.accountNumberLast4;
    const label = `${type || 'schwab'}:${last4 || '????'}`;

    const rawPositions = Array.isArray(account?.positions) ? account.positions : [];
    for (const p of rawPositions) {
      const symbol = String(p?.symbol || 'UNKNOWN');
      // The sidecar deliberately emits JSON null for any non-numeric value, and
      // Number(null) is 0: null must be checked BEFORE coercion or a broken value
      // becomes a fabricated $0 position.
      const marketValue = p?.marketValue == null ? NaN : Number(p.marketValue);
      if (!Number.isFinite(marketValue)) {
        // Flag, never guess: an unusable market value must not enter net worth.
        flags.push(`schwab position "${symbol}" on ${label} has no usable marketValue (${p?.marketValue})`);
        continue;
      }
      const quantity = p?.quantity == null ? NaN : Number(p.quantity);
      const averagePrice = p?.averagePrice == null ? NaN : Number(p.averagePrice);
      const haveQty = Number.isFinite(quantity);
      const costBasis =
        haveQty && Number.isFinite(averagePrice) ? round2(quantity * averagePrice) : null;
      positions.push({
        symbol,
        account: label,
        quantity: haveQty ? quantity : null,
        costBasis,
        marketValue,
      });
    }

    // Cash is a real part of the account's value but not a traded symbol; carry it
    // as a pseudo-position so net worth sees it. A legitimate $0 balance IS data
    // (it records a liquidated account's true state for that day); only a missing
    // or broken balance is skipped.
    const cashBalance = account?.cashBalance == null ? NaN : Number(account.cashBalance);
    if (Number.isFinite(cashBalance)) {
      positions.push({
        symbol: 'CASH',
        account: label,
        quantity: null,
        costBasis: null,
        marketValue: cashBalance,
      });
    }
  }

  return { positions, flags };
}

// Run the Python sidecar and return its parsed payload. Never throws for the
// expected failure shapes (bad exit, unparseable output, token expiry): those come
// back as {ok: false, error, tokenExpired} so the caller has one code path. Only a
// truly unexpected internal error would propagate.
export async function fetchSchwabPayload({ pythonBin, scriptPath, timeoutMs = 60000 }) {
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync(pythonBin, [scriptPath], {
      timeout: timeoutMs,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = result.stdout || '';
    stderr = result.stderr || '';
  } catch (e) {
    // execFile rejects on nonzero exit or timeout; it still attaches whatever the
    // process wrote. The sidecar prints its JSON to stdout even when it exits 1.
    stdout = e?.stdout || '';
    stderr = e?.stderr || '';
    const combined = `${stdout}\n${stderr}\n${e?.message || ''}`;
    try {
      const parsed = JSON.parse(stdout.trim());
      if (parsed && typeof parsed === 'object' && 'ok' in parsed) return parsed;
    } catch (_) {
      // stdout was not the expected single JSON object; fall through to the tail.
    }
    return {
      ok: false,
      error: tail(stderr) || e?.message || 'schwab sidecar failed',
      tokenExpired: /schwab-auth/.test(combined),
    };
  }

  const combined = `${stdout}\n${stderr}`;
  try {
    const parsed = JSON.parse(stdout.trim());
    if (parsed && typeof parsed === 'object' && 'ok' in parsed) return parsed;
    return { ok: false, error: 'schwab sidecar returned unexpected JSON', tokenExpired: false };
  } catch (_) {
    return {
      ok: false,
      error: tail(stderr) || 'schwab sidecar produced unparseable output',
      tokenExpired: /schwab-auth/.test(combined),
    };
  }
}

// Last chunk of a diagnostic stream, trimmed and length-capped so an error message
// stays readable. Never carries secrets: the sidecar keeps those off stderr.
function tail(text, max = 300) {
  const s = String(text || '').trim();
  return s.length > max ? s.slice(-max) : s;
}

// Replace-by-day: one day's positions are a full snapshot, so we clear that as_of
// and reinsert. Wrapped in a single transaction, prepared statement hoisted outside
// the loop, so a re-run for the same day never leaves duplicates or a partial write.
// raw_json is left null. Returns the number of rows inserted.
export function ingestPositions(db, positions, asOf) {
  const del = db.prepare('DELETE FROM positions WHERE as_of = ?');
  const ins = db.prepare(
    `INSERT INTO positions (as_of, symbol, quantity, cost_basis, market_value, account, raw_json)
     VALUES (@asOf, @symbol, @quantity, @costBasis, @marketValue, @account, NULL)`
  );
  const run = db.transaction((rows) => {
    del.run(asOf);
    for (const r of rows) {
      ins.run({
        asOf,
        symbol: r.symbol,
        quantity: r.quantity ?? null,
        costBasis: r.costBasis ?? null,
        marketValue: r.marketValue ?? null,
        account: r.account ?? null,
      });
    }
    return rows.length;
  });
  return run(positions);
}
