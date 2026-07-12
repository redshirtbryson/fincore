// Feed freshness engine: pure, deterministic, unit-tested. No I/O, no model.
//
// Purpose (SPEC section 11): a confident answer served over stale data is a
// failure. Every upstream feed carries a last-activity marker, meaning the
// newest data actually seen from it (the latest imported transaction date for a
// bank account, the latest position date for a brokerage), NOT whether its API
// answered a ping. A feed can be reachable and still stale.
// Time arrives as an explicit input: purity demands the caller pass now.
// Dirty inputs fail closed: an unparseable timestamp is treated as stale and
// flagged, never optimistically assumed fresh.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Parse a last-activity marker to a UTC-midnight timestamp in milliseconds.
// Accepts:
//   - date-only 'YYYY-MM-DD', which parses as UTC midnight
//   - ISO datetime 'YYYY-MM-DDTHH:MM:SSZ' and offsets
//   - bare SQLite datetime 'YYYY-MM-DD HH:MM:SS', treated as UTC
// Returns a finite epoch-ms number, or null when the string will not parse.
function parseToUtcMs(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  // Date-only: pin to UTC midnight. Date.parse already treats a bare
  // 'YYYY-MM-DD' as UTC, but we normalize explicitly so day math is exact.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const ms = Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    return Number.isFinite(ms) ? ms : null;
  }

  // SQLite datetime 'YYYY-MM-DD HH:MM:SS' (space separator, no zone). Treat as
  // UTC by converting the space to 'T' and appending 'Z'.
  const sqlite = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d+)?$/.exec(trimmed);
  if (sqlite) {
    const ms = Date.parse(`${trimmed.replace(' ', 'T')}Z`);
    return Number.isFinite(ms) ? ms : null;
  }

  // Otherwise defer to the platform ISO parser (datetimes with T and a zone or
  // offset). Anything it cannot read comes back NaN, which we map to null.
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

// Whole days elapsed between a UTC-midnight last-activity and now, measured on
// UTC-day boundaries so a timezone never shifts the count. now is floored to its
// own UTC midnight first, so "days since" counts calendar days, not partial ones.
function daysSinceUtc(lastMs, nowMs) {
  const nowMidnight = Math.floor(nowMs / MS_PER_DAY) * MS_PER_DAY;
  const lastMidnight = Math.floor(lastMs / MS_PER_DAY) * MS_PER_DAY;
  return Math.round((nowMidnight - lastMidnight) / MS_PER_DAY);
}

// Assess each feed as fresh or stale against a per-feed or default threshold.
// feeds: [{ name, lastActivity ('YYYY-MM-DD' | ISO | SQLite datetime | null),
//           thresholdDays? }].
// now: a Date (required). A missing or invalid now throws RangeError, because a
// pure function cannot invent the current time.
// defaultThresholdDays: applies to any feed without its own thresholdDays.
// Returns { fresh: [names], stale: [{ name, daysSince, reason }], flags }.
// Rules:
//   - null or missing lastActivity is stale, reason 'never seen'.
//   - unparseable lastActivity is stale, reason 'unparseable timestamp', and
//     adds a flag (fail closed).
//   - daysSince > thresholdDays is stale; exactly the threshold is still fresh.
export function assessFreshness(feeds = [], { now, defaultThresholdDays = 5 } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError('assessFreshness requires a valid now Date');
  }
  const nowMs = now.getTime();

  const fresh = [];
  const stale = [];
  const flags = [];

  for (const feed of feeds) {
    const name = feed && feed.name ? feed.name : 'unnamed feed';
    const threshold =
      feed && typeof feed.thresholdDays === 'number' && Number.isFinite(feed.thresholdDays)
        ? feed.thresholdDays
        : defaultThresholdDays;

    const lastActivity = feed ? feed.lastActivity : undefined;
    if (lastActivity === null || lastActivity === undefined || lastActivity === '') {
      stale.push({ name, daysSince: null, reason: 'never seen' });
      continue;
    }

    const lastMs = parseToUtcMs(lastActivity);
    if (lastMs === null) {
      stale.push({ name, daysSince: null, reason: 'unparseable timestamp' });
      flags.push(`feed "${name}" has an unparseable last-activity timestamp (${lastActivity}); treated as stale`);
      continue;
    }

    const daysSince = daysSinceUtc(lastMs, nowMs);
    if (daysSince > threshold) {
      stale.push({ name, daysSince, reason: `${daysSince}d since last activity exceeds ${threshold}d threshold` });
    } else {
      fresh.push(name);
    }
  }

  return { fresh, stale, flags };
}

// Render a single one-line summary of stale feeds for a notification, or '' when
// nothing is stale. Order is deterministic: alphabetical by feed name. A
// never-seen feed reads 'name (never seen)', a stale one 'name (8d)'.
export function staleSummaryLine(assessment) {
  const stale = assessment && Array.isArray(assessment.stale) ? assessment.stale : [];
  if (stale.length === 0) return '';

  const parts = [...stale]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((s) => {
      const detail = typeof s.daysSince === 'number' ? `${s.daysSince}d` : s.reason;
      return `${s.name} (${detail})`;
    });

  return `STALE FEEDS: ${parts.join(', ')}`;
}
