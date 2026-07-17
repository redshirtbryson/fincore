// SimpleFIN balance oracle (SPEC 19 as amended 2026-07-13): daily account-level
// balance snapshots for investment-ish accounts that are connected in the SimpleFIN
// Bridge but deliberately NEVER mapped into Firefly (Empower 401k, Coinbase).
// Fetch is balances-only, one request per day, well inside the Bridge's ~24/day
// budget alongside the importer's run. Transactions never flow through here.
//
// Config (.env):
//   SIMPLEFIN_ACCESS_URL      the exchanged access URL (same value as the stack's
//                             SIMPLEFIN_TOKEN). Unset = oracle off.
//   VALUATION_ACCOUNT_MATCH   comma-separated case-insensitive substrings matched
//                             against "org name" + "account name". ONLY matching
//                             accounts are ingested; everything else (checking,
//                             cards) already lives in Firefly via the importer and
//                             must not be double-counted. Unset = oracle off.
import 'dotenv/config';
import { nyDateStr } from './firefly.js';

const REQUEST_TIMEOUT_MS = Number(process.env.SIMPLEFIN_TIMEOUT_MS) > 0 ? Number(process.env.SIMPLEFIN_TIMEOUT_MS) : 30000;

// Retry only network errors and 5xx. NEVER retry a 429: each attempt spends the
// Bridge's ~24/day budget and the limit will not clear in seconds.
const RETRY_BACKOFF_MS = [2000, 8000];

// Node fetch refuses URLs with embedded credentials, so split them into a Basic
// Authorization header. Pure; exported for tests. Fails loudly and specifically:
// a URL without credentials is almost always the claim URL pasted where the
// exchanged ACCESS url belongs.
export function splitAccessUrl(accessUrl) {
  const u = new URL(accessUrl);
  if (!u.username) {
    throw new Error(
      'SIMPLEFIN_ACCESS_URL has no embedded credentials; expected the exchanged access URL (https://user:pass@...), not the claim URL or setup token'
    );
  }
  let user = u.username;
  let pass = u.password;
  try {
    user = decodeURIComponent(user);
    pass = decodeURIComponent(pass);
  } catch (_) {
    // Credentials with a literal '%' that is not a valid escape: use them raw.
  }
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  u.username = '';
  u.password = '';
  return { base: u.toString().replace(/\/+$/, ''), auth };
}

// Which accounts the oracle tracks. Deliberately opt-in by match rule: ingesting
// an account that is also importer-mapped into Firefly would double-count it.
export function matchesValuationRule(account, matchRules) {
  const hay = `${account?.org?.name ?? ''} ${account?.name ?? ''}`.toLowerCase();
  return matchRules.some((rule) => rule && hay.includes(rule));
}

export function parseMatchRules(raw) {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Double-count tripwire: a matched Bridge account whose name overlaps an existing
// Firefly account name is probably importer-mapped (e.g. a 'Coinbase Rewards Card'
// caught by the rule 'coinbase'). Containment either way, case-insensitive.
export function overlapsFireflyAccount(valuationName, fireflyAccountNames) {
  const v = String(valuationName ?? '').toLowerCase().trim();
  if (!v) return null;
  for (const name of fireflyAccountNames) {
    const f = String(name ?? '').toLowerCase().trim();
    if (!f) continue;
    if (v.includes(f) || f.includes(v)) return name;
  }
  return null;
}

// Normalize one SimpleFIN account into a valuation row, or a flag when the data
// is unusable (flag, never guess: a broken balance must not become $0). Dates are
// America/New_York calendar days like every other day boundary in the system.
export function normalizeValuation(account, { nowMs = null } = {}) {
  const balance = Number(account?.balance);
  if (account?.balance === undefined || account?.balance === null || account?.balance === '' || !Number.isFinite(balance)) {
    return { error: `SimpleFIN account "${account?.name ?? account?.id ?? 'unknown'}" has no usable balance (${account?.balance})` };
  }
  // balance-date is unix seconds; missing means "as of now" per the protocol.
  let asOf;
  if (typeof account['balance-date'] === 'number' && account['balance-date'] > 0) {
    asOf = nyDateStr(new Date(account['balance-date'] * 1000));
  } else if (nowMs) {
    asOf = nyDateStr(new Date(nowMs));
  } else {
    return { error: `SimpleFIN account "${account?.name ?? 'unknown'}" has no balance date` };
  }
  return {
    valuation: {
      source: 'simplefin',
      accountId: String(account.id ?? `${account?.org?.name ?? 'unknown'}:${account?.name ?? 'unknown'}`),
      accountName: `${account?.org?.name ? `${account.org.name} ` : ''}${account?.name ?? 'unknown'}`.trim(),
      currency: account?.currency ?? null,
      balance,
      asOf,
    },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchAccountsEndpoint(query) {
  const accessUrl = process.env.SIMPLEFIN_ACCESS_URL || '';
  if (!accessUrl) throw new Error('SIMPLEFIN_ACCESS_URL not set');
  const { base, auth } = splitAccessUrl(accessUrl);

  let lastErr = null;
  for (let i = 0; i <= RETRY_BACKOFF_MS.length; i += 1) {
    try {
      const res = await fetch(`${base}/accounts?${query}`, {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`SimpleFIN GET /accounts -> ${res.status} ${body.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      const j = await res.json();
      return Array.isArray(j?.accounts) ? j.accounts : [];
    } catch (e) {
      lastErr = e;
      const transient = e.status === undefined ? true : e.status >= 500;
      if (!transient || i === RETRY_BACKOFF_MS.length) throw e;
      await sleep(RETRY_BACKOFF_MS[i]);
    }
  }
  throw lastErr;
}

// Fetch current balances for all Bridge-connected accounts (no transactions).
// Transient failures retry with backoff; a 429 surfaces immediately.
export async function fetchBalances() {
  return fetchAccountsEndpoint('balances-only=1');
}

// Fetch accounts WITH transactions for an epoch-second window. One request covers
// every Bridge account. Epochs are validated here because a malformed range is
// exactly the data-importer bug this sync exists to replace: the Bridge rejects
// nonsense ranges with a misleading 429.
export async function fetchTransactions({ startEpoch, endEpoch }) {
  const MIN_SANE_EPOCH = 1500000000; // 2017; anything earlier is a date-math bug
  if (!Number.isInteger(startEpoch) || !Number.isInteger(endEpoch) || startEpoch < MIN_SANE_EPOCH || endEpoch <= startEpoch) {
    throw new RangeError(`refusing insane epoch range ${startEpoch}..${endEpoch}`);
  }
  return fetchAccountsEndpoint(`start-date=${startEpoch}&end-date=${endEpoch}`);
}
