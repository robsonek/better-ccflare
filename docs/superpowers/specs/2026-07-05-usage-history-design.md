# Usage History Design

**Date:** 2026-07-05
**Topic:** Persist per-account usage-window utilization as a time series, chart it, and predict when each window will hit its limit.

---

## Overview

better-ccflare already **fetches** structured usage data from the Anthropic usage API on a
configurable poll interval (see `packages/providers/src/usage-fetcher.ts`, poll interval added
in PR #128). The fetched `UsageData` exposes per-window utilization:

```typescript
interface UsageWindow { utilization: number; resets_at: string | null; }
interface UsageData {
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  seven_day_oauth_apps?: UsageWindow;
  seven_day_opus?:   UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
  [key: string]: UsageWindow | ExtraUsage | unknown;
}
```

This per-window utilization is **never persisted** — it lives only in an in-memory cache
(`UsageCache` in `usage-fetcher.ts`) and is served to the dashboard live. (The `accounts` row's
`rate_limit_status`/`rate_limit_reset`/`rate_limit_remaining` columns are a *different* signal,
written from the proxy's response rate-limit headers via `parseRateLimit`, not from
`/oauth/usage`.) So there is no history of window utilization at all.

The prior `session-window-stats` spec (2026-04-13) explicitly listed *"Historical window
tracking (only current window)"* under **Out of Scope**. This feature fills that gap: it
snapshots every usage window on each refresh into a new time-series table, exposes it through
an API endpoint with a server-computed prediction, and renders it as a per-account "Usage
History" dashboard tab.

This reuses the existing poll — **no new calls to the Anthropic API**.

---

## Scope

- Per-account, per-window (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, and
  any future `UsageWindow`-shaped key) time series of `utilization` + `resets_at`.
- Snapshots captured at the existing usage-refresh points (auto-refresh scheduler + manual
  refresh endpoint). No dedicated poller.
- New `GET /api/usage-history` endpoint returning series + prediction.
- New "Usage History" dashboard tab with a time-series chart, reset markers, and a prediction
  line.
- Configurable retention with cleanup wired into the existing maintenance path.

---

## Data Model

### New table — `usage_snapshots`

Added idempotently in **both** `packages/database/src/migrations.ts` (SQLite) and
`packages/database/src/migrations-pg.ts` (Postgres), matching the repo's dual-migration
convention.

```sql
CREATE TABLE IF NOT EXISTS usage_snapshots (
  account_id   TEXT    NOT NULL,
  timestamp    INTEGER NOT NULL,     -- ms epoch: snapshot time (PG: BIGINT)
  window_key   TEXT    NOT NULL,     -- 'five_hour' | 'seven_day' | 'seven_day_opus' | ...
  utilization  REAL    NOT NULL,     -- 0–100 percent (PG: DOUBLE PRECISION)
  resets_at    INTEGER               -- ms epoch, nullable (PG: BIGINT)
);

CREATE INDEX IF NOT EXISTS idx_usage_snapshots_acct_win_time
  ON usage_snapshots(account_id, window_key, timestamp DESC);
```

**No surrogate key.** Per house DB style (no `AUTOINCREMENT`/`SERIAL`/`IDENTITY`), this
append-only table has no `id`; it is queried and pruned by `(account_id, window_key,
timestamp)`. Pruning is a direct `DELETE FROM usage_snapshots WHERE timestamp < ?`.

- **Dynamic windows:** the writer iterates over every key of `UsageData` whose value is a
  `UsageWindow` (has a numeric `utilization`). Future windows are captured automatically; no
  schema change needed to add a window.
- **One row per poll, NO dedup.** Every successful poll writes a row for each window, even when
  the value is unchanged. Dedup was rejected: collapsing flat/idle stretches to a single row
  makes a window fall out of a bounded range query (`since = now − 24h`) once its last change
  ages out — the chart would then show "collecting data" forever — and it biases the regression
  (which expects near-uniform samples, per the ported algorithm). Volume is bounded by
  retention pruning instead (see below), not by dedup.
- **Malformed `resets_at`** parses to `null`, never `NaN` (guarded with `Number.isFinite`).

---

## Data Flow

### Backend — capture

1. **`UsageHistoryRepository`** — new file
   `packages/database/src/repositories/usage-history.repository.ts` (pattern:
   `stats.repository.ts`, extends `base.repository.ts`). Methods:
   - `recordSnapshot(accountId: string, usage: UsageData, now: number): void` — iterates the
     `UsageWindow` keys and inserts one row per window per successful poll (no dedup).
   - `getSeries({ accountId, windowKey?, since?, until? }): UsageSnapshotRow[]` — ordered by
     `timestamp ASC`, filtered by range and optional window.
   - `pruneOlderThan(cutoffMs: number): number` — deletes rows with `timestamp < cutoff`.

2. **Facade** — expose `recordUsageSnapshot(...)`, `getUsageHistory(...)`,
   `pruneUsageSnapshots(...)` through `packages/database/src/database-operations.ts` (`dbOps`),
   consistent with existing operations.

3. **Write hook** — the primary path is the poll choke-point `UsageCache._doFetchAndCache` (see
   "Resolved During Planning" below): an injected `onSnapshot(accountId, data)` callback fires
   right after the Anthropic `cache.set(...)`, wired at the single Anthropic `startPolling` site
   in `apps/server/src/server.ts` (where `dbOps` is in scope). This covers the ~90 s poll loop,
   `refreshNow`, and the manual-refresh endpoint (all funnel through `_doFetchAndCache`).

   Two flows fetch usage **without** going through `_doFetchAndCache` and get a best-effort
   direct snapshot as well: `packages/proxy/src/auto-refresh-scheduler.ts` (direct
   `fetchUsageData` after a rate-limit auto-refresh) and the force-reset fallback in
   `packages/http-api/src/handlers/accounts.ts`.

   The write goes directly through `dbOps.recordUsageSnapshot(...).catch(...)` (not
   `asyncWriter` — the callback/handler sites await `dbOps` directly, matching the existing
   `onWindowReset`/`onCapacityRestored` and refresh-handler patterns):

   ```typescript
   dbOps.recordUsageSnapshot(accountId, data, Date.now()).catch((err) => log.warn(err));
   ```

   **Best-effort:** a failure logs and returns without affecting the refresh or account update.
   It never throws into the poll/refresh path.

4. **Retention** — new env `USAGE_HISTORY_RETENTION_DAYS` (default **90**) in `packages/config`.
   With no dedup, steady-state volume is roughly one row per window per poll: ~4 windows every
   ~90 s ≈ ~3.8k rows/account/day ≈ ~350k rows/account over 90 days (a few MB, covered by the
   index). `pruneUsageSnapshots(now - retentionMs)` is called from the existing
   cleanup/maintenance routine (the same place `requests`/`request_payloads` are pruned). Note:
   the first prune after *lowering* retention is a single large `DELETE` — acceptable given the
   table size, but flagged so it isn't a surprise.

### Backend — read + prediction

`GET /api/usage-history?account=<id>&range=<1h|6h|24h|7d|30d>&window=<key?>`, registered in
`packages/http-api/src/router.ts` next to the other `this.handlers.set("GET:/api/...", ...)`
routes, handler in `packages/http-api/src/handlers/usage-history.ts`. `range` selects the time
window (mirroring the analytics/insights handlers via `getRangeConfig`; unknown values
normalize to `24h`, and the response echoes the normalized value); `window` optionally filters
to a single window key. `account` is required (→ `400` if absent).

Response (per window):

```typescript
interface UsageHistoryWindow {
  window: string;                       // window_key
  points: { t: number; utilization: number; resetsAt: number | null }[];
  prediction: {
    slopePerHour: number;               // utilization gain per hour, current segment
    etaExhaustMs: number | null;        // ms epoch at 100%, anchored at CURRENT usage; null unless rising/exhausted
    predictedAtReset: number | null;    // projected utilization (0–100) at the reset ("target line")
    resetsAtMs: number | null;          // current window reset
    willExhaustBeforeReset: boolean;    // raw projected-at-reset >= 100
    state: "insufficient_data" | "stable" | "rising" | "exhausted";
    lowConfidence: boolean;             // data span < ~5 min → numeric fields suppressed
  };
}
```

**Prediction algorithm** (server-side, pure fn; the non-obvious rules are ported from the
battle-tested `calculate_prediction` in `robsonek/claude-usage-dashboard`, which learned them
from real Anthropic-usage quirks), computed per window:

1. **Exhausted first.** Latest sample `>= 100` (utilization can exceed 100 during overage) →
   `state: "exhausted"`, `etaExhaustMs` = newest sample time, `predictedAtReset: 100`.
2. **Drop idle readings.** When a current-period `resets_at` is known, exclude points with
   `resets_at == null` (idle/zero-usage readings) — including them flattens the slope ~10×.
3. **Segment to the current window.** Cut at the last boundary: a `resets_at` change OR a drop
   larger than **5 percentage points** (a reset/refund, not measurement jitter). This avoids a
   mid-period "gift" (e.g. 86%→7% at the same `resets_at`) producing a bogus negative slope that
   extrapolates to nonsense (the real dashboard once showed "at reset: −142%").
4. **Least-squares fit** `utilization = a·x + b` on **centered, hour-scaled time**
   (`x = (t − t0)/hour`) to avoid float64 cancellation with epoch-ms. `a` is utilization/hour.
5. **ETA anchored at current usage:** `etaExhaustMs = latest.t + (100 − currentUsage)/a` (only
   when `a > 0`) — starting from the real latest reading, never the fitted intercept, so it can't
   land in the past.
6. **`predictedAtReset`** = `clamp(currentUsage + a·hoursToReset, 0, 100)` — the "target line".
   `willExhaustBeforeReset` = the raw (unclamped) projection `>= 100`.
7. **Low confidence:** if the segment spans `< ~5 min`, set `lowConfidence: true` and suppress
   `etaExhaustMs`/`predictedAtReset` (don't claim a trend from too little data).
8. **States:** `< 3` points → `insufficient_data`; slope `<= 0` → `stable`; else `rising`.

The prediction math lives in a pure, unit-testable function
(`packages/http-api/src/services/usage-prediction.ts` or a `lib` module) taking points and
returning the `prediction` object — no I/O.

---

## Types

New types in `packages/types` (co-located with the existing usage/account types):

```typescript
interface UsageSnapshotRow {
  accountId: string;
  timestamp: number;
  windowKey: string;
  utilization: number;
  resetsAt: number | null;
}
// + UsageHistoryWindow / UsageHistoryResponse as above
```

---

## UI

**Location:** a new top-level **"Usage History"** tab, registered in
`packages/dashboard-web/src/components/navigation.tsx`; components under
`packages/dashboard-web/src/components/usage-history/`.

- **Account selector** — better-ccflare is multi-account; the view charts one account at a
  time, switchable (reuse the existing accounts query / context).
- **Chart** — one line series per window (`five_hour`, `seven_day`, `seven_day_opus`,
  `seven_day_sonnet`), **numeric time x-axis** (with a domain extended to cover future reset
  markers and forecast endpoints — a category axis would silently drop them), Y axis =
  utilization % with headroom above 100 for overage, reusing `components/charts/` +
  `chart-utils` + recharts. A **legend identifies** the windows (interactive click-to-toggle is
  a follow-up, not v1).
- **Reset markers** — vertical reference lines at each distinct `resets_at`.
- **Prediction line** — a dashed extrapolation for rising windows, capped at the earlier of the
  ETA (endpoint 100%) or the reset (endpoint = `predictedAtReset`). Annotated per window
  (`"~2h to limit ⚠"`, `"rising, safe until reset"`, `"stable"`, `"low confidence"`, `"at limit"`).
  Dashed line omitted when `state !== "rising"` or `lowConfidence`.
- **Empty state** — "Collecting usage data…" (passed explicitly to the chart) until snapshots exist.
- Data fetched through a new hook in `packages/dashboard-web/src/hooks/queries.ts` with a key
  in `packages/dashboard-web/src/lib/query-keys.ts`.

---

## Error Handling

- **Usage fetch failed** → no snapshot written; existing refresh/account-update behavior is
  unchanged (the hook only runs on a successful fetch that already produced `UsageData`).
- **Snapshot write failed** → logged, swallowed; never propagates into the refresh path.
- **Empty history** for an account/window → endpoint returns `points: []` and
  `prediction.state: "insufficient_data"`; UI shows the empty state.
- **SQLite vs Postgres** → dialect differences (`INTEGER`↔`BIGINT`, `REAL`↔`DOUBLE PRECISION`)
  are handled by the two separate migration files; queries use the repository's
  parameter-binding abstraction.
- **Retention** → prune is idempotent and range-bounded; a failed prune does not block other
  maintenance.

---

## Testing

- **Prediction (pure fn)** — rising → ETA anchored at current usage + `predictedAtReset`; flat →
  `stable` with `predictedAtReset ≈ current`; `< 3` points → `insufficient_data`; `resets_at`
  change → only current segment fitted; latest `>= 100` → `exhausted`; **idle null-reset points
  ignored** (slope not flattened); **mid-period ≥5 pp "gift"** → post-gift positive slope, never
  a negative `predictedAtReset`; **sub-5-min span** → `lowConfidence`, ETA suppressed.
- **Repository** — one row per poll incl. unchanged values (flat series stays continuous);
  malformed `resets_at` → null (not NaN); `getSeries` range/window filtering + ordering;
  `pruneOlderThan` cutoff.
- **Migration idempotency** — table + index create cleanly and re-run safely on both SQLite and
  Postgres.
- **API handler** — response shape, `account` required (→ 400), `window`/`range` filtering,
  normalized `range` echoed back, empty case.
- **UI** — light component test (pattern: `RateLimitProgress.test.tsx`): chart renders points,
  prediction annotation shows/hides by `state`, empty state.

---

## Files to Change

| File | Change |
|------|--------|
| `packages/database/src/migrations.ts` | `usage_snapshots` table + index (SQLite) |
| `packages/database/src/migrations-pg.ts` | same for Postgres |
| `packages/database/src/repositories/usage-history.repository.ts` | **new** — record / getSeries / prune |
| `packages/database/src/database-operations.ts` | facade methods on `dbOps` |
| `packages/providers/src/usage-fetcher.ts` | `onSnapshot` param + fire in `_doFetchAndCache` |
| `apps/server/src/server.ts` | wire `onSnapshot` (site 366) + call `pruneUsageSnapshots` in cleanup/startup |
| `packages/proxy/src/auto-refresh-scheduler.ts` | best-effort snapshot on direct fetch |
| `packages/http-api/src/handlers/accounts.ts` | best-effort snapshot on force-reset fallback |
| `packages/http-api/src/handlers/usage-history.ts` | **new** endpoint |
| `packages/http-api/src/router.ts` | register `GET:/api/usage-history` |
| `packages/http-api/src/services/usage-prediction.ts` | **new** — pure prediction fn |
| `packages/types/src/usage-history.ts` | snapshot / series / prediction types |
| `packages/config/src/index.ts` | `USAGE_HISTORY_RETENTION_DAYS` getter/setter + `getAllSettings` |
| `packages/dashboard-web/src/components/usage-history/*` | **new** tab + chart + pure transforms |
| `packages/dashboard-web/src/components/charts/{BaseLineChart,types}.ts(x)` | numeric x-axis, dashed lines, nullable data |
| `packages/dashboard-web/src/{App,components/navigation}.tsx` | register the tab (route + nav) |
| `packages/dashboard-web/src/{api.ts, hooks/queries.ts, lib/query-keys.ts}` | client + query hook + key |

---

## Out of Scope (v1)

- CLI readout of history (`packages/cli-commands/src/commands/stats.ts`).
- Threshold alerts on predicted exhaustion (a separate alerts mechanism already exists).
- CSV / data export.
- Passive snapshots from proxied response headers (data source is the existing poll, by
  decision).
- Aggregate/cross-account rollups (v1 is per-account).
- Interactive legend toggling of series (the legend labels only in v1).

## Known v1 limitations

- **Prediction reflects the selected chart range.** The endpoint computes the fit from the
  points inside `range`, so switching to a very short range (`1h`) can starve a slow-moving 7d
  window to `insufficient_data`, and changing range changes the trend. The reference dashboard
  predicts from the current window regardless of display range; matching that (a fixed
  prediction lookback independent of the chart range) is a straightforward follow-up.

---

## Resolved During Planning

1. **`utilization` unit = 0–100** (percent), confirmed by `usage-fetcher.ts` comparing
   `utilization < 100`. Prediction target is `100`.
2. **Capture site = `UsageCache._doFetchAndCache`** (the poll choke-point), hooked via an
   injected `onSnapshot(accountId, data)` callback that mirrors the existing
   `onWindowReset`/`onCapacityRestored` callbacks and is wired in `apps/server/src/server.ts`
   (where `dbOps` is in scope) — because `packages/providers` must not import
   `packages/database`. This covers the ~90s poll loop, `refreshNow`, and the manual-refresh
   endpoint in one place.
