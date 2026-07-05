# Usage History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-account usage-window utilization (5h / 7d / opus / sonnet) as a time series, expose it via a new API endpoint with a server-computed exhaustion prediction, and render it in a new "Usage History" dashboard tab.

**Architecture:** better-ccflare already polls the Anthropic `/oauth/usage` endpoint (~every 90s) inside `UsageCache._doFetchAndCache`, but the resulting window utilization lives **only in an in-memory cache** — it is never persisted. This feature adds an injected `onSnapshot` callback (mirroring the existing `onWindowReset`/`onCapacityRestored` callbacks) that writes each poll's windows into a new `usage_snapshots` table via `dbOps`. A new `GET /api/usage-history` endpoint reads the series, computes a linear-extrapolation prediction, and a new React tab charts it with reset markers and a prediction line. No new calls to the Anthropic API.

**Tech Stack:** TypeScript, Bun (runtime + `bun test` + `bun:sqlite`), SQLite + PostgreSQL (dual migrations), Repository pattern over `BunSqlAdapter`, React + `@tanstack/react-query` v5 + `recharts` v3, Biome (lint/format).

## Global Constraints

- Runtime floors: Node ≥ 18 / Bun ≥ 1.2.8. Test runner is **`bun test`** (not vitest/jest); tests import from `"bun:test"`. Run one file: `bun test <path>`.
- **Dual database:** every schema change lands in BOTH `packages/database/src/migrations.ts` (SQLite, `db.run(...)`) AND `packages/database/src/migrations-pg.ts` (Postgres, `await adapter.unsafe(...)`). SQLite `INTEGER` epoch-ms ↔ PG `BIGINT`; SQLite `REAL` ↔ PG `DOUBLE PRECISION`.
- **House DB style:** no `AUTOINCREMENT` / `SERIAL` / `IDENTITY`. Tables either use an app-generated `TEXT PRIMARY KEY` or (for append-only high-frequency data) no surrogate key at all. `usage_snapshots` uses **no surrogate key** — it is queried and pruned by `(account_id, window_key, timestamp)`.
- **Utilization unit is 0–100** (a percent), confirmed by `usageData.five_hour.utilization` being compared `< 100` in `usage-fetcher.ts`. The prediction target is `100`.
- `packages/providers/src/usage-fetcher.ts` must NOT gain a dependency on `packages/database`. (Some other providers — e.g. Bedrock's `error-handler.ts` — already import `@better-ccflare/database`, so the ban is on the usage-fetcher specifically, not the package.) The capture hook crosses that boundary via a callback injected from `apps/server`, never a direct import in `usage-fetcher.ts`.
- JSON responses use `jsonResponse(...)` and errors use `errorResponse(BadRequest(...) | InternalServerError(...))`, all from `@better-ccflare/http-common`. The router auto-wraps every handler in try/catch and auto-authenticates every route.
- New shared types go in a single-topic file under `packages/types/src/` re-exported via `packages/types/src/index.ts` (`export * from "./usage-history";`).
- Commit after every task with a `feat:`/`test:` message.

---

## File Structure

**New files**
- `packages/types/src/usage-history.ts` — shared types (`UsageSnapshotRow`, `UsagePrediction`, `UsageHistoryWindowSeries`, `UsageHistoryResponse`, `PredictionPoint`).
- `packages/database/src/repositories/usage-history.repository.ts` — `UsageHistoryRepository` (record / query / prune).
- `packages/database/src/repositories/__tests__/usage-history.repository.test.ts` — repo tests.
- `packages/http-api/src/services/usage-prediction.ts` — pure `computeUsagePrediction`.
- `packages/http-api/src/services/__tests__/usage-prediction.test.ts` — prediction tests.
- `packages/http-api/src/handlers/usage-history.ts` — `createUsageHistoryHandler`.
- `packages/http-api/src/handlers/__tests__/usage-history.test.ts` — handler test.
- `packages/config/src/usage-history-retention.test.ts` — config getter test.
- `packages/dashboard-web/src/components/usage-history/UsageHistoryTab.tsx` — the tab.
- `packages/dashboard-web/src/components/usage-history/UsageHistoryChart.tsx` — the chart.
- `packages/dashboard-web/src/components/usage-history/chart-data.ts` — pure transforms (merge + annotation).
- `packages/dashboard-web/src/components/usage-history/__tests__/chart-data.test.ts` — transform tests.

**Modified files**
- `packages/types/src/index.ts` — export the new types.
- `packages/config/src/index.ts` — `usage_history_retention_days` field + getter/setter + `getAllSettings()`.
- `packages/database/src/migrations.ts` / `migrations-pg.ts` — `usage_snapshots` table + index.
- `packages/database/src/database-operations.ts` — repo field + facade methods.
- `packages/providers/src/usage-fetcher.ts` — `onSnapshot` param + `snapshotCallbacks` map + fire in Anthropic branch.
- `apps/server/src/server.ts` — pass `onSnapshot` at the **single Anthropic `startPolling` site (line 366)**; call `pruneUsageSnapshots` in cleanup + startup maintenance.
- `packages/http-api/src/router.ts` — register `GET:/api/usage-history`.
- `packages/dashboard-web/src/api.ts` — `getUsageHistory(account, range)`.
- `packages/dashboard-web/src/lib/query-keys.ts` — `usageHistory` key.
- `packages/dashboard-web/src/hooks/queries.ts` — `useUsageHistory` hook.
- `packages/dashboard-web/src/components/charts/BaseLineChart.tsx` — vertical (`x`) reference lines + dashed line support.
- `packages/dashboard-web/src/components/charts/types.ts` — widen `ChartDataPoint` to allow `null` (gap values).
- `packages/dashboard-web/src/components/navigation.tsx` + `packages/dashboard-web/src/App.tsx` — register the tab.

---

## Task 1: Shared types

**Files:**
- Create: `packages/types/src/usage-history.ts`
- Modify: `packages/types/src/index.ts` (add export after line 17)

**Interfaces:**
- Produces: `UsageSnapshotRow`, `PredictionPoint`, `UsagePrediction`, `UsageHistoryWindowSeries`, `UsageHistoryResponse` — consumed by Tasks 4, 5, 6, 7, 10, 12, 13.

- [ ] **Step 1: Create the types file**

```typescript
// packages/types/src/usage-history.ts

/** One persisted usage-window measurement. `utilization` is 0–100. */
export interface UsageSnapshotRow {
	accountId: string;
	timestamp: number; // ms epoch — when the snapshot was taken
	windowKey: string; // e.g. "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet"
	utilization: number; // 0–100
	resetsAt: number | null; // ms epoch when the window resets
}

/** A single point fed to the prediction fn / chart. */
export interface PredictionPoint {
	t: number; // ms epoch
	utilization: number; // 0–100
	resetsAt: number | null;
}

export interface UsagePrediction {
	slopePerHour: number; // fitted utilization gain per hour over the current segment (0 only when the fit is flat or has too few points)
	etaExhaustMs: number | null; // ms epoch reaching 100%, anchored at CURRENT usage; null unless rising/exhausted
	predictedAtReset: number | null; // clamped projected utilization (0–100) at the window reset ("target line"); null if no reset/low-confidence
	resetsAtMs: number | null; // current window reset (ms epoch)
	willExhaustBeforeReset: boolean; // the RAW (unclamped) projected-at-reset value >= 100
	state: "insufficient_data" | "stable" | "rising" | "exhausted";
	lowConfidence: boolean; // data span < ~5 min — trend not trustworthy; etaExhaustMs/predictedAtReset suppressed (slopePerHour still reported)
}

export interface UsageHistoryWindowSeries {
	window: string;
	points: PredictionPoint[];
	prediction: UsagePrediction;
}

export interface UsageHistoryResponse {
	accountId: string;
	range: string;
	windows: UsageHistoryWindowSeries[];
}
```

- [ ] **Step 2: Export from the package index**

Add after line 17 (`export * from "./strategy";`) in `packages/types/src/index.ts`:

```typescript
export * from "./usage-history";
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/types && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/usage-history.ts packages/types/src/index.ts
git commit -m "feat(types): add usage-history shared types"
```

---

## Task 2: Config — `USAGE_HISTORY_RETENTION_DAYS`

**Files:**
- Modify: `packages/config/src/index.ts` (field after line 57; getter/setter after line 326; `getAllSettings()` after line 559)
- Test: `packages/config/src/usage-history-retention.test.ts`

**Interfaces:**
- Produces: `Config.getUsageHistoryRetentionDays(): number` (default 90, clamped 1–3650) — consumed by Task 9.

- [ ] **Step 1: Write the failing test** (`packages/config/src/usage-history-retention.test.ts`)

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

function makeConfig(): { config: Config; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-"));
	return {
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("getUsageHistoryRetentionDays", () => {
	const original = process.env.USAGE_HISTORY_RETENTION_DAYS;
	beforeEach(() => {
		delete process.env.USAGE_HISTORY_RETENTION_DAYS;
	});
	afterEach(() => {
		if (original === undefined) delete process.env.USAGE_HISTORY_RETENTION_DAYS;
		else process.env.USAGE_HISTORY_RETENTION_DAYS = original;
	});

	it("defaults to 90 when no env or file override", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getUsageHistoryRetentionDays()).toBe(90);
		} finally {
			cleanup();
		}
	});

	it("reads and clamps the env override", () => {
		const { config, cleanup } = makeConfig();
		try {
			process.env.USAGE_HISTORY_RETENTION_DAYS = "5000"; // above max
			expect(config.getUsageHistoryRetentionDays()).toBe(3650);
		} finally {
			cleanup();
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/config/src/usage-history-retention.test.ts`
Expected: FAIL — `config.getUsageHistoryRetentionDays is not a function`.

- [ ] **Step 3: Add the field** — in `ConfigData`, after line 57 (`request_retention_days?: number;`):

```typescript
	usage_history_retention_days?: number;
```

- [ ] **Step 4: Add getter + setter** — immediately after `setRequestRetentionDays` (line 325), before `getStorePayloads`:

```typescript
	getUsageHistoryRetentionDays(): number {
		const fromEnv = process.env.USAGE_HISTORY_RETENTION_DAYS;
		if (fromEnv) {
			const n = parseInt(fromEnv, 10);
			if (!Number.isNaN(n)) return this.clamp(n, 1, 3650);
		}
		const fromFile = this.data.usage_history_retention_days;
		if (typeof fromFile === "number") return this.clamp(fromFile, 1, 3650);
		return 90; // default: keep 90 days of usage-window history
	}

	setUsageHistoryRetentionDays(days: number): void {
		const clamped = this.clamp(days, 1, 3650);
		this.set("usage_history_retention_days", clamped);
	}
```

- [ ] **Step 5: Surface in `getAllSettings()`** — after line 559 (`request_retention_days: this.getRequestRetentionDays(),`):

```typescript
			usage_history_retention_days: this.getUsageHistoryRetentionDays(),
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test packages/config/src/usage-history-retention.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/config/src/index.ts packages/config/src/usage-history-retention.test.ts
git commit -m "feat(config): add USAGE_HISTORY_RETENTION_DAYS (default 90)"
```

---

## Task 3: Migration — `usage_snapshots` table (SQLite + Postgres)

**Files:**
- Modify: `packages/database/src/migrations.ts` (append inside `ensureSchema`, after line 353, before the closing `}` on line 354)
- Modify: `packages/database/src/migrations-pg.ts` (append inside `ensureSchemaPg`, after line 288, before `log.info(...)` on line 290)
- Test: `packages/database/src/repositories/__tests__/usage-history.repository.test.ts` (created here, expanded in Task 4)

**Interfaces:**
- Produces: table `usage_snapshots(account_id TEXT, timestamp INT, window_key TEXT, utilization REAL, resets_at INT)` + index `idx_usage_snapshots_acct_win_time`.

- [ ] **Step 1: Write the failing test** (create the test file)

```typescript
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../../migrations";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

describe("usage_snapshots schema", () => {
	it("creates the usage_snapshots table", () => {
		const db = makeDb();
		const row = db
			.query(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='usage_snapshots'",
			)
			.get() as { name: string } | null;
		expect(row?.name).toBe("usage_snapshots");
		db.close();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/database/src/repositories/__tests__/usage-history.repository.test.ts`
Expected: FAIL — `row?.name` is `undefined`.

- [ ] **Step 3: Add the SQLite table** — in `packages/database/src/migrations.ts`, after line 353 (after the `combo_family_assignments` seed `INSERT`), before `ensureSchema`'s closing `}`:

```typescript
	// Create usage_snapshots table: time series of per-account usage-window
	// utilization (0–100) captured on each /oauth/usage poll. Append-only, no
	// surrogate key; queried and pruned by (account_id, window_key, timestamp).
	db.run(`
		CREATE TABLE IF NOT EXISTS usage_snapshots (
			account_id TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			window_key TEXT NOT NULL,
			utilization REAL NOT NULL,
			resets_at INTEGER
		)
	`);
	db.run(
		`CREATE INDEX IF NOT EXISTS idx_usage_snapshots_acct_win_time ON usage_snapshots(account_id, window_key, timestamp DESC)`,
	);
```

- [ ] **Step 4: Add the Postgres table** — in `packages/database/src/migrations-pg.ts`, after line 288 (last `strategies` statement), before `log.info("PostgreSQL schema ensured");`:

```typescript
	// Create usage_snapshots table (see SQLite migration for rationale).
	await adapter.unsafe(`
		CREATE TABLE IF NOT EXISTS usage_snapshots (
			account_id TEXT NOT NULL,
			timestamp BIGINT NOT NULL,
			window_key TEXT NOT NULL,
			utilization DOUBLE PRECISION NOT NULL,
			resets_at BIGINT
		)
	`);
	await adapter.unsafe(
		`CREATE INDEX IF NOT EXISTS idx_usage_snapshots_acct_win_time ON usage_snapshots(account_id, window_key, timestamp DESC)`,
	);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/database/src/repositories/__tests__/usage-history.repository.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/database/src/migrations.ts packages/database/src/migrations-pg.ts packages/database/src/repositories/__tests__/usage-history.repository.test.ts
git commit -m "feat(database): add usage_snapshots table (SQLite + Postgres)"
```

---

## Task 4: `UsageHistoryRepository`

**Files:**
- Create: `packages/database/src/repositories/usage-history.repository.ts`
- Test: `packages/database/src/repositories/__tests__/usage-history.repository.test.ts` (extend)

**Interfaces:**
- Consumes: `UsageData` from `@better-ccflare/types`? — NO. `UsageData`/`UsageWindow` live in `@better-ccflare/providers` (`packages/providers/src/usage-fetcher.ts`). To avoid a database→providers dependency, `recordSnapshot` accepts a **plain record** `Record<string, unknown>` and duck-types window shapes internally. `UsageSnapshotRow`, `PredictionPoint` from `@better-ccflare/types`.
- Produces: `recordSnapshot(accountId, usage, now)`, `getSeries({accountId, windowKey?, since?, until?})`, `deleteOlderThan(cutoffTs)` — consumed by Task 5.

- [ ] **Step 1: Write the failing tests** — append to the test file from Task 3:

```typescript
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { UsageHistoryRepository } from "../usage-history.repository";

function makeRepo(db: Database): UsageHistoryRepository {
	return new UsageHistoryRepository(new BunSqlAdapter(db));
}

describe("UsageHistoryRepository", () => {
	it("records one row per usage window", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await repo.recordSnapshot(
			"acc1",
			{
				five_hour: { utilization: 10, resets_at: "2026-07-05T12:00:00Z" },
				seven_day: { utilization: 3, resets_at: null },
				extra_usage: { is_enabled: true, monthly_limit: 5, used_credits: 1, utilization: 20 },
			},
			1000,
		);
		const rows = await repo.getSeries({ accountId: "acc1" });
		// extra_usage has no resets_at → not a window → excluded
		expect(rows.map((r) => r.windowKey).sort()).toEqual([
			"five_hour",
			"seven_day",
		]);
		const fiveH = rows.find((r) => r.windowKey === "five_hour");
		expect(fiveH?.utilization).toBe(10);
		expect(fiveH?.resetsAt).toBe(new Date("2026-07-05T12:00:00Z").getTime());
		db.close();
	});

	it("records every poll (no dedup) so flat windows stay a continuous series", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		const usage = { five_hour: { utilization: 10, resets_at: null } };
		await repo.recordSnapshot("acc1", usage, 1000);
		await repo.recordSnapshot("acc1", usage, 2000); // same value → still stored
		await repo.recordSnapshot("acc1", { five_hour: { utilization: 11, resets_at: null } }, 3000);
		const rows = await repo.getSeries({ accountId: "acc1", windowKey: "five_hour" });
		expect(rows.map((r) => r.utilization)).toEqual([10, 10, 11]);
		expect(rows.map((r) => r.timestamp)).toEqual([1000, 2000, 3000]);
		db.close();
	});

	it("skips malformed resets_at (stores null, not NaN)", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await repo.recordSnapshot("acc1", { five_hour: { utilization: 5, resets_at: "not-a-date" } }, 1000);
		const rows = await repo.getSeries({ accountId: "acc1" });
		expect(rows[0].resetsAt).toBeNull();
		db.close();
	});

	it("filters getSeries by time range and orders ascending", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await repo.recordSnapshot("acc1", { five_hour: { utilization: 1, resets_at: null } }, 1000);
		await repo.recordSnapshot("acc1", { five_hour: { utilization: 2, resets_at: null } }, 2000);
		await repo.recordSnapshot("acc1", { five_hour: { utilization: 3, resets_at: null } }, 3000);
		const rows = await repo.getSeries({ accountId: "acc1", since: 1500, until: 2500 });
		expect(rows.map((r) => r.timestamp)).toEqual([2000]);
		db.close();
	});

	it("deleteOlderThan prunes by timestamp", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await repo.recordSnapshot("acc1", { five_hour: { utilization: 1, resets_at: null } }, 1000);
		await repo.recordSnapshot("acc1", { five_hour: { utilization: 2, resets_at: null } }, 5000);
		const removed = await repo.deleteOlderThan(3000);
		expect(removed).toBe(1);
		const rows = await repo.getSeries({ accountId: "acc1" });
		expect(rows.map((r) => r.timestamp)).toEqual([5000]);
		db.close();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/database/src/repositories/__tests__/usage-history.repository.test.ts`
Expected: FAIL — cannot find module `../usage-history.repository`.

- [ ] **Step 3: Implement the repository**

```typescript
// packages/database/src/repositories/usage-history.repository.ts
import type { PredictionPoint, UsageSnapshotRow } from "@better-ccflare/types";
import { BaseRepository } from "./base.repository";

/** Duck-typed usage window: an object with a numeric `utilization` and a `resets_at` key. */
function isWindow(
	value: unknown,
): value is { utilization: number; resets_at: string | null } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { utilization?: unknown }).utilization === "number" &&
		"resets_at" in (value as object)
	);
}

interface SnapshotDbRow {
	account_id: string;
	timestamp: number;
	window_key: string;
	utilization: number;
	resets_at: number | null;
}

export interface GetSeriesOptions {
	accountId: string;
	windowKey?: string;
	since?: number;
	until?: number;
}

export class UsageHistoryRepository extends BaseRepository<UsageSnapshotRow> {
	/**
	 * Insert one row per usage window present in `usage`. One row per successful
	 * poll (NO dedup) — the prediction fit and the chart both need a faithful,
	 * near-uniform series; collapsing flat stretches to a single row makes idle
	 * windows fall out of range queries and biases the regression. Volume is
	 * bounded by retention pruning instead. `usage` is the raw UsageData-shaped
	 * record from the provider cache; non-window fields (extra_usage, unknown
	 * keys) are ignored. A malformed `resets_at` is stored as null, never NaN.
	 */
	async recordSnapshot(
		accountId: string,
		usage: Record<string, unknown>,
		now: number,
	): Promise<void> {
		for (const [windowKey, value] of Object.entries(usage)) {
			if (!isWindow(value)) continue;
			const utilization = value.utilization;
			let resetsAt: number | null = null;
			if (value.resets_at) {
				const ms = new Date(value.resets_at).getTime();
				resetsAt = Number.isFinite(ms) ? ms : null;
			}
			await this.run(
				`INSERT INTO usage_snapshots (account_id, timestamp, window_key, utilization, resets_at)
				 VALUES (?, ?, ?, ?, ?)`,
				[accountId, now, windowKey, utilization, resetsAt],
			);
		}
	}

	async getSeries(opts: GetSeriesOptions): Promise<UsageSnapshotRow[]> {
		const clauses = ["account_id = ?"];
		const params: unknown[] = [opts.accountId];
		if (opts.windowKey) {
			clauses.push("window_key = ?");
			params.push(opts.windowKey);
		}
		if (opts.since != null) {
			clauses.push("timestamp >= ?");
			params.push(opts.since);
		}
		if (opts.until != null) {
			clauses.push("timestamp <= ?");
			params.push(opts.until);
		}
		const rows = await this.query<SnapshotDbRow>(
			`SELECT account_id, timestamp, window_key, utilization, resets_at
			 FROM usage_snapshots
			 WHERE ${clauses.join(" AND ")}
			 ORDER BY timestamp ASC`,
			params,
		);
		return rows.map((r) => ({
			accountId: r.account_id,
			timestamp: Number(r.timestamp),
			windowKey: r.window_key,
			utilization: Number(r.utilization),
			resetsAt: r.resets_at == null ? null : Number(r.resets_at),
		}));
	}

	async deleteOlderThan(cutoffTs: number): Promise<number> {
		return this.runWithChanges(
			`DELETE FROM usage_snapshots WHERE timestamp < ?`,
			[cutoffTs],
		);
	}
}

/** Convenience: map snapshot rows to prediction/chart points. */
export function toPredictionPoints(rows: UsageSnapshotRow[]): PredictionPoint[] {
	return rows.map((r) => ({
		t: r.timestamp,
		utilization: r.utilization,
		resetsAt: r.resetsAt,
	}));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/database/src/repositories/__tests__/usage-history.repository.test.ts`
Expected: PASS (6 tests incl. Task 3's schema test).

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/repositories/usage-history.repository.ts packages/database/src/repositories/__tests__/usage-history.repository.test.ts
git commit -m "feat(database): add UsageHistoryRepository (record/getSeries/prune)"
```

---

## Task 5: `dbOps` facade methods

**Files:**
- Modify: `packages/database/src/database-operations.ts` (import ~line 37; field ~line 247; constructor ~line 369; new methods near the other account methods, e.g. after `updateAccountRateLimitMeta` ~line 818)

**Interfaces:**
- Consumes: `UsageHistoryRepository` (Task 4).
- Produces: `dbOps.recordUsageSnapshot(accountId, usage, now)`, `dbOps.getUsageHistory(opts)`, `dbOps.pruneUsageSnapshots(cutoffTs)` — consumed by Tasks 6, 7, 8, 9.

- [ ] **Step 1: Write the failing test** (`packages/database/src/repositories/__tests__/usage-history.repository.test.ts` — append; drives the facade via a real in-memory `DatabaseOperations`)

> Note: if constructing `DatabaseOperations` in a unit test is heavyweight (it opens workers/paths), prefer testing the facade indirectly. Inspect `database-operations.ts` for an existing test-friendly constructor path; the repo tests above already cover behavior. If direct construction is impractical, replace this step with a typecheck-only assertion and rely on Task 6/7 handler tests for integration. Keep the test only if `new DatabaseOperations(...)` is feasible with an in-memory path.

Minimal facade smoke test (only if feasible):

```typescript
// Pseudocode guard — implement only if DatabaseOperations exposes an in-memory/test ctor.
// Otherwise skip; Task 4 covers repo behavior and Task 7 covers the read path.
```

- [ ] **Step 2: Add the import** — with the other repository imports (~line 37):

```typescript
import { UsageHistoryRepository } from "./repositories/usage-history.repository";
```

- [ ] **Step 3: Add the field** — with the other private repo fields (~line 247, after `private combo: ComboRepository;`):

```typescript
	private usageHistory: UsageHistoryRepository;
```

- [ ] **Step 4: Construct it** — after `this.combo = new ComboRepository(this.adapter);` (~line 369):

```typescript
		this.usageHistory = new UsageHistoryRepository(this.adapter);
```

- [ ] **Step 5: Add facade methods** — after `updateAccountRateLimitMeta` (~line 818):

```typescript
	getUsageHistoryRepository(): UsageHistoryRepository {
		return this.usageHistory;
	}

	async recordUsageSnapshot(
		accountId: string,
		usage: Record<string, unknown>,
		now: number,
	): Promise<void> {
		await this.usageHistory.recordSnapshot(accountId, usage, now);
	}

	async getUsageHistory(opts: {
		accountId: string;
		windowKey?: string;
		since?: number;
		until?: number;
	}) {
		return this.usageHistory.getSeries(opts);
	}

	async pruneUsageSnapshots(cutoffTs: number): Promise<number> {
		return this.usageHistory.deleteOlderThan(cutoffTs);
	}
```

- [ ] **Step 6: Typecheck**

Run: `cd packages/database && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/database/src/database-operations.ts packages/database/src/repositories/__tests__/usage-history.repository.test.ts
git commit -m "feat(database): expose usage-history methods on DatabaseOperations"
```

---

## Task 6: Prediction pure function

**Files:**
- Create: `packages/http-api/src/services/usage-prediction.ts`
- Test: `packages/http-api/src/services/__tests__/usage-prediction.test.ts`

**Interfaces:**
- Consumes: `PredictionPoint`, `UsagePrediction` (Task 1).
- Produces: `computeUsagePrediction(points: PredictionPoint[]): UsagePrediction` — consumed by Task 7.

> **Design note — ported from `robsonek/claude-usage-dashboard`'s battle-tested
> `calculate_prediction`.** Five real-world lessons that plain linear regression gets
> wrong: (1) **anchor ETA at current usage** `(100 − current)/slope`, not the fitted
> intercept; (2) segment on a **≥5 pp drop** (reset/refund), not any drop — avoids a
> mid-period "gift" (86%→7%) producing a bogus negative slope; (3) **drop idle
> `resetsAt == null` readings** when a current window is known — they flatten the slope
> ~10×; (4) compute **`predictedAtReset`** (projected utilization at the reset moment, the
> "target line") and derive `willExhaustBeforeReset` from it; (5) **`lowConfidence`** when
> the data span is < ~5 min — suppress numeric claims.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "bun:test";
import type { PredictionPoint } from "@better-ccflare/types";
import { computeUsagePrediction } from "../usage-prediction";

const H = 60 * 60 * 1000;

describe("computeUsagePrediction", () => {
	it("returns insufficient_data for < 3 points", () => {
		const p = computeUsagePrediction([
			{ t: 0, utilization: 10, resetsAt: null },
			{ t: H, utilization: 20, resetsAt: null },
		]);
		expect(p.state).toBe("insufficient_data");
		expect(p.etaExhaustMs).toBeNull();
	});

	it("anchors ETA at current usage and projects usage at reset", () => {
		const reset = 20 * H;
		// 10,20,30,40 over 0..3h → slope 10/h, current usage 40 at t=3h
		const points: PredictionPoint[] = [0, 1, 2, 3].map((h) => ({
			t: h * H,
			utilization: 10 * h + 10,
			resetsAt: reset,
		}));
		const p = computeUsagePrediction(points);
		expect(p.state).toBe("rising");
		expect(Math.round(p.slopePerHour)).toBe(10);
		// (100 - 40) / 10 = 6h from t=3h → t=9h
		expect(Math.round((p.etaExhaustMs ?? 0) / H)).toBe(9);
		// projected at reset: 40 + 10*(20-3) = 210 → clamped to 100
		expect(p.predictedAtReset).toBe(100);
		expect(p.willExhaustBeforeReset).toBe(true);
		expect(p.lowConfidence).toBe(false);
	});

	it("is stable (no eta) for flat usage; predictedAtReset ≈ current", () => {
		const points: PredictionPoint[] = [0, 1, 2, 3].map((h) => ({
			t: h * H,
			utilization: 42,
			resetsAt: 20 * H,
		}));
		const p = computeUsagePrediction(points);
		expect(p.state).toBe("stable");
		expect(p.etaExhaustMs).toBeNull();
		expect(p.predictedAtReset).toBe(42);
		expect(p.willExhaustBeforeReset).toBe(false);
	});

	it("segments at a resets_at change", () => {
		const reset1 = 5 * H;
		const reset2 = 25 * H;
		const points: PredictionPoint[] = [
			{ t: 0, utilization: 60, resetsAt: reset1 },
			{ t: 1 * H, utilization: 90, resetsAt: reset1 },
			{ t: 2 * H, utilization: 5, resetsAt: reset2 }, // new window
			{ t: 3 * H, utilization: 6, resetsAt: reset2 },
			{ t: 4 * H, utilization: 7, resetsAt: reset2 },
		];
		const p = computeUsagePrediction(points);
		expect(p.state).toBe("rising");
		expect(Math.round(p.slopePerHour)).toBe(1); // post-reset segment only
		expect(p.resetsAtMs).toBe(reset2);
	});

	it("reports exhausted when the latest sample is at/over 100", () => {
		const reset = 20 * H;
		const points: PredictionPoint[] = [
			{ t: 0, utilization: 80, resetsAt: reset },
			{ t: 1 * H, utilization: 100, resetsAt: reset },
			{ t: 2 * H, utilization: 120, resetsAt: reset }, // overage
		];
		const p = computeUsagePrediction(points);
		expect(p.state).toBe("exhausted");
		expect(p.etaExhaustMs).toBe(2 * H);
	});

	it("ignores idle null-reset points that would flatten the slope", () => {
		const reset = 20 * H;
		const points: PredictionPoint[] = [
			{ t: 0, utilization: 0, resetsAt: null }, // idle
			{ t: 1 * H, utilization: 0, resetsAt: null }, // idle
			{ t: 2 * H, utilization: 0, resetsAt: null }, // idle
			{ t: 3 * H, utilization: 20, resetsAt: reset },
			{ t: 4 * H, utilization: 40, resetsAt: reset },
			{ t: 5 * H, utilization: 60, resetsAt: reset },
		];
		const p = computeUsagePrediction(points);
		expect(p.state).toBe("rising");
		expect(Math.round(p.slopePerHour)).toBe(20); // active pace, not diluted to ~10
	});

	it("drops pre-gift data so a mid-period refund never yields a negative slope", () => {
		const reset = 25 * H;
		const points: PredictionPoint[] = [
			{ t: 0, utilization: 60, resetsAt: reset },
			{ t: 1 * H, utilization: 86, resetsAt: reset },
			{ t: 2 * H, utilization: 7, resetsAt: reset }, // >5pp drop = refund/gift
			{ t: 3 * H, utilization: 8, resetsAt: reset },
			{ t: 4 * H, utilization: 9, resetsAt: reset },
		];
		const p = computeUsagePrediction(points);
		expect(p.slopePerHour).toBeGreaterThan(0); // NOT the bogus negative slope
		expect(Math.round(p.slopePerHour)).toBe(1); // post-gift trend ~1%/h
		expect(p.predictedAtReset).not.toBeNull();
		expect(p.predictedAtReset as number).toBeGreaterThanOrEqual(0); // never "-142%"
	});

	it("flags lowConfidence and suppresses eta for a sub-5-minute span", () => {
		const t0 = 1_000_000;
		const points: PredictionPoint[] = [0, 1, 2].map((i) => ({
			t: t0 + i * 60 * 1000, // 3 points across 2 minutes
			utilization: 10 + i * 5,
			resetsAt: t0 + 5 * H,
		}));
		const p = computeUsagePrediction(points);
		expect(p.lowConfidence).toBe(true);
		expect(p.etaExhaustMs).toBeNull();
		expect(p.predictedAtReset).toBeNull();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/http-api/src/services/__tests__/usage-prediction.test.ts`
Expected: FAIL — cannot find module `../usage-prediction`.

- [ ] **Step 3: Implement**

```typescript
// packages/http-api/src/services/usage-prediction.ts
import type { PredictionPoint, UsagePrediction } from "@better-ccflare/types";

const HOUR_MS = 60 * 60 * 1000;
const MIN_POINTS = 3;
const MIN_SPAN_MS = 5 * 60 * 1000; // below ~5 min the trend is not trustworthy
const RESET_DROP_THRESHOLD = 5; // pp drop that marks a reset/refund (not jitter)
const LIMIT = 100; // utilization is 0–100

const clamp = (v: number, lo: number, hi: number) =>
	Math.max(lo, Math.min(hi, v));

/**
 * Predict a usage window's trajectory from its recent snapshots. Ported from the
 * battle-tested `calculate_prediction` in robsonek/claude-usage-dashboard: ETA is
 * anchored at current usage; a ≥5 pp drop (reset/refund) segments the data; idle
 * (resets_at == null) readings are excluded when a live window is known; a short
 * data span is flagged low-confidence.
 */
export function computeUsagePrediction(
	points: PredictionPoint[],
): UsagePrediction {
	const sorted = [...points].sort((a, b) => a.t - b.t);
	const latest = sorted.length ? sorted[sorted.length - 1] : null;
	const resetsAtMs = latest ? latest.resetsAt : null;

	const base = {
		slopePerHour: 0,
		etaExhaustMs: null as number | null,
		predictedAtReset: null as number | null,
		resetsAtMs,
		willExhaustBeforeReset: false,
		lowConfidence: false,
	};

	// Already at/over the cap (overage). No forward extrapolation needed.
	if (latest && latest.utilization >= LIMIT) {
		return {
			...base,
			etaExhaustMs: latest.t,
			predictedAtReset: LIMIT,
			willExhaustBeforeReset: true,
			state: "exhausted",
		};
	}

	// When a current-period reset is known, idle readings (resets_at == null) are
	// NOT part of the active window — including them flattens the slope ~10×.
	let pts = sorted;
	if (resetsAtMs != null) {
		const active = sorted.filter((p) => p.resetsAt != null);
		if (active.length >= 2) pts = active;
	}

	// Segment to the current window: cut at the last boundary — a resets_at change
	// OR a drop larger than RESET_DROP_THRESHOLD (a reset/refund, not measurement
	// jitter). Regressing across an 86%→7% "gift" would yield a bogus negative slope.
	let segStart = 0;
	for (let i = 1; i < pts.length; i++) {
		const prev = pts[i - 1];
		const cur = pts[i];
		const resetChanged = (prev.resetsAt ?? null) !== (cur.resetsAt ?? null);
		const dropped = cur.utilization < prev.utilization - RESET_DROP_THRESHOLD;
		if (resetChanged || dropped) segStart = i;
	}
	const segment = pts.slice(segStart);

	if (segment.length < MIN_POINTS) {
		return { ...base, state: "insufficient_data" };
	}

	const first = segment[0];
	const last = segment[segment.length - 1];
	const currentUsage = last.utilization;
	const lowConfidence = last.t - first.t < MIN_SPAN_MS;

	// Least-squares on centered, hour-scaled time (avoids float64 cancellation at
	// epoch-ms): utilization = a*x + b, x = (t - first.t)/HOUR_MS, a is per-hour.
	const n = segment.length;
	let sumX = 0;
	let sumU = 0;
	let sumXX = 0;
	let sumXU = 0;
	for (const p of segment) {
		const x = (p.t - first.t) / HOUR_MS;
		sumX += x;
		sumU += p.utilization;
		sumXX += x * x;
		sumXU += x * p.utilization;
	}
	const denom = n * sumXX - sumX * sumX;
	const a = denom === 0 ? 0 : (n * sumXU - sumX * sumU) / denom; // per hour
	const slopePerHour = a;

	// "Target line": projected utilization at the reset moment, anchored at current
	// usage. willExhaustBeforeReset is the raw (unclamped) projection crossing 100.
	const hoursToReset =
		resetsAtMs != null ? Math.max(0, (resetsAtMs - last.t) / HOUR_MS) : null;
	const rawAtReset =
		hoursToReset != null ? currentUsage + a * hoursToReset : null;
	const predictedAtReset =
		!lowConfidence && rawAtReset != null ? clamp(rawAtReset, 0, LIMIT) : null;
	const willExhaustBeforeReset =
		!lowConfidence && rawAtReset != null && rawAtReset >= LIMIT;

	if (a <= 0) {
		return {
			...base,
			slopePerHour,
			predictedAtReset,
			willExhaustBeforeReset,
			lowConfidence,
			state: "stable",
		};
	}

	// ETA to 100% anchored at CURRENT usage (not the fitted intercept) — matches
	// the real latest reading and never lands in the past for a rising trend.
	const etaExhaustMs = lowConfidence
		? null
		: Math.round(last.t + ((LIMIT - currentUsage) / a) * HOUR_MS);

	return {
		...base,
		slopePerHour,
		etaExhaustMs,
		predictedAtReset,
		willExhaustBeforeReset,
		lowConfidence,
		state: "rising",
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/http-api/src/services/__tests__/usage-prediction.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/http-api/src/services/usage-prediction.ts packages/http-api/src/services/__tests__/usage-prediction.test.ts
git commit -m "feat(http-api): add usage exhaustion prediction fn"
```

---

## Task 7: `GET /api/usage-history` endpoint

**Files:**
- Create: `packages/http-api/src/handlers/usage-history.ts`
- Modify: `packages/http-api/src/router.ts` (import near line 108; instantiate in `registerHandlers`; register route near line 389)
- Test: `packages/http-api/src/handlers/__tests__/usage-history.test.ts`

**Interfaces:**
- Consumes: `dbOps.getUsageHistory` (Task 5), `computeUsagePrediction` (Task 6), `getRangeConfig` from `../utils/query-filters`, `APIContext` from `../types`.
- Produces: `createUsageHistoryHandler(context)` → `(searchParams) => Promise<Response>` returning `UsageHistoryResponse`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import type { UsageSnapshotRow } from "@better-ccflare/types";
import { createUsageHistoryHandler } from "../usage-history";

// Captures the opts passed to getUsageHistory so we can assert filter forwarding.
function makeContext(rows: UsageSnapshotRow[]) {
	const calls: Array<{ accountId: string; windowKey?: string; since?: number }> = [];
	const context = {
		dbOps: {
			getUsageHistory: async (opts: {
				accountId: string;
				windowKey?: string;
				since?: number;
			}) => {
				calls.push(opts);
				return rows;
			},
		},
	} as unknown as import("../../types").APIContext;
	return { context, calls };
}

describe("createUsageHistoryHandler", () => {
	it("400s when account is missing", async () => {
		const { context } = makeContext([]);
		const handler = createUsageHistoryHandler(context);
		const res = await handler(new URLSearchParams(""));
		expect(res.status).toBe(400);
	});

	it("groups rows by window and includes a prediction", async () => {
		const H = 60 * 60 * 1000;
		const rows: UsageSnapshotRow[] = [0, 1, 2, 3].map((h) => ({
			accountId: "acc1",
			timestamp: h * H,
			windowKey: "five_hour",
			utilization: 10 * h + 10,
			resetsAt: 20 * H,
		}));
		const { context } = makeContext(rows);
		const handler = createUsageHistoryHandler(context);
		const res = await handler(new URLSearchParams("account=acc1&range=7d"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			accountId: string;
			range: string;
			windows: { window: string; points: unknown[]; prediction: { state: string } }[];
		};
		expect(body.accountId).toBe("acc1");
		expect(body.windows).toHaveLength(1);
		expect(body.windows[0].window).toBe("five_hour");
		expect(body.windows[0].points).toHaveLength(4);
		expect(body.windows[0].prediction.state).toBe("rising");
	});

	it("echoes the normalized range for an unknown value", async () => {
		const { context } = makeContext([]);
		const handler = createUsageHistoryHandler(context);
		const res = await handler(new URLSearchParams("account=acc1&range=bogus"));
		const body = (await res.json()) as { range: string };
		expect(body.range).toBe("24h"); // unknown → getRangeConfig falls back to 24h
	});

	it("forwards the window filter to getUsageHistory", async () => {
		const { context, calls } = makeContext([]);
		const handler = createUsageHistoryHandler(context);
		await handler(new URLSearchParams("account=acc1&window=seven_day_opus"));
		expect(calls[0].accountId).toBe("acc1");
		expect(calls[0].windowKey).toBe("seven_day_opus");
	});

	it("returns an empty windows array when there are no rows", async () => {
		const { context } = makeContext([]);
		const handler = createUsageHistoryHandler(context);
		const res = await handler(new URLSearchParams("account=acc1"));
		const body = (await res.json()) as { windows: unknown[] };
		expect(body.windows).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/http-api/src/handlers/__tests__/usage-history.test.ts`
Expected: FAIL — cannot find module `../usage-history`.

- [ ] **Step 3: Implement the handler**

```typescript
// packages/http-api/src/handlers/usage-history.ts
import {
	BadRequest,
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import type {
	PredictionPoint,
	UsageHistoryResponse,
	UsageHistoryWindowSeries,
} from "@better-ccflare/types";
import type { APIContext } from "../types";
import { computeUsagePrediction } from "../services/usage-prediction";
import { getRangeConfig } from "../utils/query-filters";

const log = new Logger("UsageHistoryHandler");

export function createUsageHistoryHandler(context: APIContext) {
	return async (searchParams: URLSearchParams): Promise<Response> => {
		const accountId = searchParams.get("account");
		if (!accountId) {
			return errorResponse(
				BadRequest("Missing required 'account' query parameter"),
			);
		}
		// getRangeConfig returns the normalized effective `range` (unknown values
		// fall back to 24h) — echo that in the response so it matches startMs.
		const { startMs, range } = getRangeConfig(searchParams.get("range") ?? "24h");
		const windowKey = searchParams.get("window") ?? undefined;

		try {
			const rows = await context.dbOps.getUsageHistory({
				accountId,
				windowKey,
				since: startMs,
			});

			const byWindow = new Map<string, PredictionPoint[]>();
			for (const r of rows) {
				const arr = byWindow.get(r.windowKey) ?? [];
				arr.push({ t: r.timestamp, utilization: r.utilization, resetsAt: r.resetsAt });
				byWindow.set(r.windowKey, arr);
			}

			const windows: UsageHistoryWindowSeries[] = [...byWindow.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([window, points]) => ({
					window,
					points,
					prediction: computeUsagePrediction(points),
				}));

			const response: UsageHistoryResponse = { accountId, range, windows };
			return jsonResponse(response);
		} catch (error) {
			log.error("Usage history error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch usage history"),
			);
		}
	};
}
```

> Verify `BadRequest` is exported from `@better-ccflare/http-common` (the http-error barrel re-exports it). If not present, import it from `packages/http-api/src/utils/http-error`.

- [ ] **Step 4: Register the route** — in `packages/http-api/src/router.ts`:
  1. Import (near line 108, by the other handler imports):

```typescript
import { createUsageHistoryHandler } from "./handlers/usage-history";
```

  2. Instantiate inside `registerHandlers()` (near the analytics/insights factories, ~line 198):

```typescript
		const usageHistoryHandler = createUsageHistoryHandler(this.context);
```

  3. Register in the "Register routes" block (near line 389):

```typescript
		this.handlers.set("GET:/api/usage-history", (_req, url) =>
			usageHistoryHandler(url.searchParams),
		);
```

- [ ] **Step 5: Run test + typecheck to verify pass**

Run: `bun test packages/http-api/src/handlers/__tests__/usage-history.test.ts`
Expected: PASS (5 tests).
Run: `cd packages/http-api && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/http-api/src/handlers/usage-history.ts packages/http-api/src/handlers/__tests__/usage-history.test.ts packages/http-api/src/router.ts
git commit -m "feat(http-api): add GET /api/usage-history endpoint"
```

---

## Task 8: Capture hook — persist each poll

**Files:**
- Modify: `packages/providers/src/usage-fetcher.ts` (add `snapshotCallbacks` map ~line 356; add `onSnapshot` param to `startPolling` ~line 433 + register it ~line 486; fire it in the Anthropic branch of `_doFetchAndCache` after `this.cache.set(...)` ~line 741)
- Modify: `apps/server/src/server.ts` (add the `onSnapshot` arg at the **single** Anthropic `startPolling` site: line 366 only — see Step 5)
- Modify: `packages/proxy/src/auto-refresh-scheduler.ts` (direct-fetch snapshot ~line 617)
- Modify: `packages/http-api/src/handlers/accounts.ts` (force-reset fallback snapshot ~line 2774)

**Interfaces:**
- Consumes: `dbOps.recordUsageSnapshot` (Task 5).
- Produces: `UsageCache.startPolling(..., onSnapshot?)` fires `onSnapshot(accountId, data)` on each successful Anthropic poll.

> **No unit test for this task (Fable L5).** `fetchUsageData` is defined inside `usage-fetcher.ts` (not a separate module), so `mock.module` can't intercept it without refactoring the fetch boundary — which this task must not do. The callback wiring is pure plumbing (add a param, store in a map, invoke after `cache.set`); it is verified by **typecheck** (Step 6) and the **end-to-end manual check** (rows appearing in `usage_snapshots`). Do NOT create a `.test.ts` file for this task — an empty/placeholder test would fail to compile and break the commit.

- [ ] **Step 1: (no test file)** — proceed to the implementation steps; verification is typecheck + manual (Step 6).

- [ ] **Step 2: Add the callbacks map** — near line 356 (after `capacityRestoredCallbacks`):

```typescript
	private snapshotCallbacks = new Map<
		string,
		(accountId: string, data: UsageData) => void
	>();
```

- [ ] **Step 3: Add the `onSnapshot` param + registration** — extend `startPolling`'s signature (after `onCapacityRestored`):

```typescript
		onCapacityRestored?: (accountId: string) => void,
		onSnapshot?: (accountId: string, data: UsageData) => void,
```

  and register it alongside the other callbacks (after the `onCapacityRestored` block, ~line 486):

```typescript
		if (onSnapshot) {
			this.snapshotCallbacks.set(accountId, onSnapshot);
		} else {
			this.snapshotCallbacks.delete(accountId);
		}
```

  Also delete it wherever the other callbacks are cleaned up (near line 547, in `stopPolling`):

```typescript
		this.snapshotCallbacks.delete(accountId);
```

- [ ] **Step 4: Fire the callback** — in `_doFetchAndCache`, Anthropic branch, immediately after `this.cache.set(accountId, { data: result.data, timestamp: Date.now() });` (~line 741):

```typescript
					const snapshotCb = this.snapshotCallbacks.get(accountId);
					if (snapshotCb) snapshotCb(accountId, result.data as UsageData);
```

- [ ] **Step 5: Wire it in the server — ONLY at the Anthropic polling site (line 366)** — append a trailing `onSnapshot` argument after the `onCapacityRestored` callback, using the same `.catch`-logging shape as the existing callbacks:

```typescript
				(accountId, data) => {
					proxyContext.dbOps
						.recordUsageSnapshot(accountId, data, Date.now())
						.catch((err) =>
							logger.warn(
								`Failed to record usage snapshot for account ${accountId}: ${err}`,
							),
						);
				},
```

> **Only site 366 (Fable M3).** `onSnapshot` fires solely in the **Anthropic** default branch of `_doFetchAndCache` (usage-fetcher.ts:723-760). The other three `startPolling` sites (server.ts:1422/1459/1495) are the **NanoGPT / Zai / Kilo** polling loops — a callback registered there could never fire, so wiring them is dead code that also propagates a wrong mental model. Site 366 already covers both Anthropic callers of the shared polling helper (startup + the runtime restart hook), which is every Anthropic poll. Match the local variable name at site 366 (`proxyContext.dbOps` / `logger`) as used by the existing `onWindowReset`/`onCapacityRestored` callbacks there.

- [ ] **Step 5b: Cover the two direct-fetch paths that bypass `_doFetchAndCache`** — two flows fetch Anthropic usage WITHOUT going through the poll loop, so the `onSnapshot` callback never fires for them; add a best-effort snapshot at each:
  1. `packages/proxy/src/auto-refresh-scheduler.ts` — right after the `if (usageData) { log.info(...) }` block (~line 617), where `usageData` is currently only logged:

```typescript
						this.proxyContext.dbOps
							.recordUsageSnapshot(accountRow.id, usageData, Date.now())
							.catch((err) =>
								log.warn(
									`Failed to record usage snapshot for ${accountRow.name}: ${err}`,
								),
							);
```

  2. `packages/http-api/src/handlers/accounts.ts` — in the force-reset fallback, right after `usageCache.set(account.id, usageData);` (~line 2774):

```typescript
					dbOps
						.recordUsageSnapshot(account.id, usageData, Date.now())
						.catch(() => {});
```

  These two paths are edge triggers (post-rate-limit auto-refresh; manual force-reset), so the extra rows are few; they add real data points at moments the 90s loop might miss. Match the local logger/variable names in scope at each site.

- [ ] **Step 6: Verify (typecheck + manual)**

Run: `cd packages/providers && bunx tsc --noEmit` then `cd apps/server && bunx tsc --noEmit`
Expected: no errors.
Manual (see the Manual Verification section at the end): start the server with a real Anthropic OAuth account, wait for two poll cycles (~3 min), then `SELECT window_key, utilization, timestamp FROM usage_snapshots ORDER BY timestamp DESC LIMIT 10;` against the DB — expect rows appearing over time.

- [ ] **Step 7: Commit**

```bash
git add packages/providers/src/usage-fetcher.ts apps/server/src/server.ts packages/proxy/src/auto-refresh-scheduler.ts packages/http-api/src/handlers/accounts.ts
git commit -m "feat(providers): snapshot usage windows on each poll via onSnapshot callback"
```

---

## Task 9: Retention — prune old snapshots

**Files:**
- Modify: `apps/server/src/server.ts` (in the `dataRetentionCleanup` closure ~line 755-761, and in `runStartupMaintenance` ~line 238-243)

**Interfaces:**
- Consumes: `config.getUsageHistoryRetentionDays()` (Task 2), `dbOps.pruneUsageSnapshots` (Task 5), `TIME_CONSTANTS.DAY`.

- [ ] **Step 1: Add the prune to the scheduled cleanup** — inside `dataRetentionCleanup`, after the `cleanupOldRequests(...)` call (~line 761):

```typescript
			const usageHistoryDays = config.getUsageHistoryRetentionDays();
			const removedSnapshots = await dbOps.pruneUsageSnapshots(
				Date.now() - usageHistoryDays * TIME_CONSTANTS.DAY,
			);
			if (removedSnapshots > 0) {
				log.info(`Pruned ${removedSnapshots} old usage snapshots`);
			}
```

> The `dataRetentionCleanup` closure logs via `log` (a `Logger` in scope at that site), not `logger`. Match whatever identifier the surrounding cleanup code already uses.

- [ ] **Step 2: Add the same prune to startup maintenance** — inside `runStartupMaintenance`, after its `cleanupOldRequests(...)` call (~line 243):

```typescript
			await dbOps.pruneUsageSnapshots(
				Date.now() - config.getUsageHistoryRetentionDays() * TIME_CONSTANTS.DAY,
			);
```

> Match the actual local variable names (`config`, `dbOps`, `log`, `TIME_CONSTANTS`) already in scope at each site — `runStartupMaintenance` defines `const log = new Logger("StartupMaintenance")`.

- [ ] **Step 3: Verify**

Run: `cd apps/server && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/server.ts
git commit -m "feat(server): prune usage_snapshots on retention schedule"
```

---

## Task 10: Dashboard API client + query hook

**Files:**
- Modify: `packages/dashboard-web/src/api.ts` (add `getUsageHistory`, mirror `getCacheInsights` ~line 968)
- Modify: `packages/dashboard-web/src/lib/query-keys.ts` (add `usageHistory` key)
- Modify: `packages/dashboard-web/src/hooks/queries.ts` (add `useUsageHistory`, mirror `useCacheInsights`)

**Interfaces:**
- Consumes: `UsageHistoryResponse` (Task 1), the `/api/usage-history` endpoint (Task 7).
- Produces: `api.getUsageHistory(account, range)`, `queryKeys.usageHistory(account, range)`, `useUsageHistory(account, range)` — consumed by Task 13.

- [ ] **Step 1: Add the query key** — in `query-keys.ts`, after `storage: ...`:

```typescript
	usageHistory: (account?: string, range?: string) =>
		[...queryKeys.all, "usage-history", { account, range }] as const,
```

- [ ] **Step 2: Add the API method** — in `api.ts`, mirroring `getCacheInsights`:

```typescript
	async getUsageHistory(
		account: string,
		range = "24h",
	): Promise<UsageHistoryResponse> {
		const params = new URLSearchParams({ account, range });
		return this.get<UsageHistoryResponse>(
			`/api/usage-history?${params.toString()}`,
		);
	}
```

  and import the type at the top of `api.ts` (with the other `@better-ccflare/types` imports):

```typescript
import type { UsageHistoryResponse } from "@better-ccflare/types";
```

- [ ] **Step 3: Add the hook** — in `hooks/queries.ts`, mirroring `useCacheInsights`:

```typescript
export const useUsageHistory = (account: string, range: string) => {
	return useQuery({
		queryKey: queryKeys.usageHistory(account, range),
		queryFn: () => api.getUsageHistory(account, range),
		staleTime: 45000,
		refetchInterval: 60000,
		refetchIntervalInBackground: false,
		gcTime: 15 * 60 * 1000,
		enabled: !!account,
	});
};
```

- [ ] **Step 4: Verify**

Run: `cd packages/dashboard-web && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard-web/src/api.ts packages/dashboard-web/src/lib/query-keys.ts packages/dashboard-web/src/hooks/queries.ts
git commit -m "feat(dashboard): add usage-history API client + query hook"
```

---

## Task 11: `BaseLineChart` — vertical reference lines, dashed lines, null gaps

**Files:**
- Modify: `packages/dashboard-web/src/components/charts/types.ts` (`ChartDataPoint` ~line 2)
- Modify: `packages/dashboard-web/src/components/charts/BaseLineChart.tsx` (`LineConfig` + `ReferenceLineConfig` interfaces ~line 21-30; `BaseLineChartProps` ~line 33-39; the `<XAxis>` ~line 86-93, the `Line`/`referenceLines.map(...)` render ~line 107-129)

**Interfaces:**
- Produces: `ChartDataPoint` widened to allow `null` (gap values); `LineConfig` gains optional `strokeDasharray`; `ReferenceLineConfig` gains optional `x?: number | string` (vertical marker); `BaseLineChartProps` gains optional `xAxisType?: "number" | "category"` + `xAxisDomain?: [number | string, number | string]` so a numeric time axis can place future reset/forecast marks. Existing callers unaffected — consumed by Tasks 12, 13.

> **Why (Fable review H1):** `BaseLineChart`'s `<XAxis>` has no `type`, so recharts defaults to `type="category"`. On a category axis a `<ReferenceLine x={futureTs}>` only renders if `x` equals an existing row's value — a future `resets_at`/`etaExhaustMs` never does, so **reset markers and the forecast endpoint silently vanish**, and real time gaps are drawn evenly. The Usage History chart therefore needs a **numeric** x axis with a domain extended to cover the future marks. `tsc` passes either way — this only fails visually — so it must be built in, not left to a "verify no breakage" step.

- [ ] **Step 1: Widen `ChartDataPoint`** — in `packages/dashboard-web/src/components/charts/types.ts`, allow `null` so merged rows with gaps typecheck (recharts renders `null` as a break; use `connectNulls` to bridge). Replace:

```typescript
export type ChartDataPoint = Record<string, string | number | null>;
```

> Verify the exact current shape first (it may be an interface). Only widen the value type to include `null`; do not change key typing. If other charts rely on non-null values, this is still safe (adding `null` to the union is backward-compatible for readers that never produce it).

- [ ] **Step 2: Extend the line + reference-line configs** — in `BaseLineChart.tsx`, add `strokeDasharray` to `LineConfig` and `x` to `ReferenceLineConfig`:

```typescript
interface LineConfig {
	dataKey: string;
	stroke?: string;
	strokeWidth?: number;
	dot?: boolean;
	name?: string;
	strokeDasharray?: string;
	connectNulls?: boolean;
}

interface ReferenceLineConfig {
	x?: number | string;
	y?: number;
	stroke?: string;
	strokeDasharray?: string;
	label?: string;
}
```

  and pass `strokeDasharray`/`connectNulls` through in the `lineConfigs.map(...)` render (add these two props to the existing `<Line>`). Default `connectNulls` to **false** (recharts' own default) so existing callers are unchanged; the Usage History chart opts in explicitly:

```typescript
							strokeDasharray={lineConfig.strokeDasharray}
							connectNulls={lineConfig.connectNulls ?? false}
```

- [ ] **Step 2b: Numeric x-axis support** — add two optional props to `BaseLineChartProps` and thread them to `<XAxis>` so a caller can request a numeric time axis with an explicit domain:

```typescript
// in BaseLineChartProps
	xAxisType?: "number" | "category";
	xAxisDomain?: [number | string, number | string];
```

  destructure them in the component signature (alongside the other `xAxis*` props), then update `<XAxis>`:

```tsx
					<XAxis
						dataKey={xAxisKey}
						type={xAxisType}
						domain={xAxisDomain}
						allowDataOverflow
						className="text-xs"
						angle={xAxisAngle}
						textAnchor={xAxisTextAnchor}
						height={xAxisHeight}
						tickFormatter={xAxisTickFormatter}
					/>
```

  `type`/`domain` are `undefined` for every existing caller → recharts keeps its category default, so no other chart changes.

- [ ] **Step 3: Pass `x` through** — in the `referenceLines.map(...)` block, change the `<ReferenceLine>` to include `x` and a stable index key:

```typescript
					{referenceLines.map((refLine, refIndex) => (
						<ReferenceLine
							key={`ref-line-${refIndex}`}
							x={refLine.x}
							y={refLine.y}
							stroke={refLine.stroke || COLORS.primary}
							strokeDasharray={
								refLine.strokeDasharray || CHART_PROPS.strokeDasharray
							}
							label={refLine.label}
						/>
					))}
```

- [ ] **Step 4: Verify no existing chart breaks** — `y`-only callers are unaffected (`x` is `undefined`, ignored by recharts); `strokeDasharray`/`connectNulls` are optional.

Run: `cd packages/dashboard-web && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard-web/src/components/charts/types.ts packages/dashboard-web/src/components/charts/BaseLineChart.tsx
git commit -m "feat(dashboard): BaseLineChart vertical/dashed lines + nullable data"
```

---

## Task 12: Chart-data transforms (pure)

**Files:**
- Create: `packages/dashboard-web/src/components/usage-history/chart-data.ts`
- Test: `packages/dashboard-web/src/components/usage-history/__tests__/chart-data.test.ts`

**Interfaces:**
- Consumes: `UsageHistoryWindowSeries` (Task 1).
- Produces:
  - `buildUsageChartData(windows): { rows: ChartRow[]; windowKeys: string[]; predictionKeys: string[]; markers: { x: number; label: string }[] }` — merges actual points AND a 2-point prediction segment per rising window into one recharts dataset.
  - `resetMarkers(windows): { x: number; label: string }[]`
  - `formatPredictionAnnotation(series, now): string`
  — consumed by Task 13.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "bun:test";
import type { UsageHistoryWindowSeries } from "@better-ccflare/types";
import {
	buildUsageChartData,
	formatPredictionAnnotation,
	resetMarkers,
} from "../chart-data";

const H = 60 * 60 * 1000;

function series(): UsageHistoryWindowSeries[] {
	return [
		{
			window: "five_hour",
			points: [
				{ t: 1000, utilization: 10, resetsAt: 5 * H },
				{ t: 2000, utilization: 20, resetsAt: 5 * H },
			],
			prediction: {
				slopePerHour: 10,
				etaExhaustMs: 4 * H,
				predictedAtReset: 100,
				resetsAtMs: 5 * H,
				willExhaustBeforeReset: true,
				state: "rising",
				lowConfidence: false,
			},
		},
		{
			window: "seven_day",
			points: [{ t: 2000, utilization: 3, resetsAt: null }],
			prediction: {
				slopePerHour: 0,
				etaExhaustMs: null,
				predictedAtReset: null,
				resetsAtMs: null,
				willExhaustBeforeReset: false,
				state: "stable",
				lowConfidence: false,
			},
		},
	];
}

describe("buildUsageChartData", () => {
	it("merges actual + prediction segments into one dataset", () => {
		const { rows, windowKeys, predictionKeys } = buildUsageChartData(series());
		expect(windowKeys).toEqual(["five_hour", "seven_day"]);
		expect(predictionKeys).toEqual(["five_hour__pred"]); // only the rising window
		// distinct timestamps: 1000, 2000 (actual) + 4h (eta endpoint) = 3 rows
		expect(rows.map((r) => r.t)).toEqual([1000, 2000, 4 * H]);
		const t2 = rows.find((r) => r.t === 2000)!;
		expect(t2.five_hour).toBe(20);
		expect(t2.seven_day).toBe(3);
		expect(t2.five_hour__pred).toBe(20); // prediction anchored at last actual
		const eta = rows.find((r) => r.t === 4 * H)!;
		expect(eta.five_hour__pred).toBe(100); // dashed line reaches the limit
		expect(eta.five_hour).toBeNull(); // no actual point there
		const t1 = rows.find((r) => r.t === 1000)!;
		expect(t1.seven_day).toBeNull(); // gap
	});

	it("caps the forecast at the reset when the ETA is beyond it", () => {
		const windows = [
			{
				window: "seven_day",
				points: [
					{ t: 0, utilization: 40, resetsAt: 10 * H },
					{ t: 1 * H, utilization: 42, resetsAt: 10 * H },
				],
				prediction: {
					slopePerHour: 2,
					etaExhaustMs: 30 * H, // ETA far beyond the 10h reset
					predictedAtReset: 58,
					resetsAtMs: 10 * H,
					willExhaustBeforeReset: false,
					state: "rising" as const,
					lowConfidence: false,
				},
			},
		];
		const { rows, predictionKeys } = buildUsageChartData(windows);
		expect(predictionKeys).toEqual(["seven_day__pred"]);
		// forecast endpoint is at the reset (10h), value = predictedAtReset (58), NOT 30h/100
		expect(rows.map((r) => r.t)).toEqual([0, 1 * H, 10 * H]);
		expect(rows.find((r) => r.t === 10 * H)!.seven_day__pred).toBe(58);
	});
});

describe("resetMarkers", () => {
	it("returns one deduped marker per distinct resetsAt", () => {
		expect(resetMarkers(series()).map((m) => m.x)).toEqual([5 * H]);
	});
});

describe("formatPredictionAnnotation", () => {
	it("summarizes a rising window that will exhaust before reset", () => {
		const out = formatPredictionAnnotation(series()[0], 3 * H);
		expect(out).toContain("five_hour");
		expect(out.toLowerCase()).toContain("limit");
	});
	it("says stable for a stable window", () => {
		expect(
			formatPredictionAnnotation(series()[1], 0).toLowerCase(),
		).toContain("stable");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/dashboard-web/src/components/usage-history/__tests__/chart-data.test.ts`
Expected: FAIL — cannot find module `../chart-data`.

- [ ] **Step 3: Implement**

```typescript
// packages/dashboard-web/src/components/usage-history/chart-data.ts
import type { UsageHistoryWindowSeries } from "@better-ccflare/types";

export interface ChartRow {
	t: number;
	[key: string]: number | string | null;
}

const PRED_SUFFIX = "__pred";
const LIMIT = 100;

/**
 * Merge per-window actual points AND a 2-point dashed prediction segment for
 * each rising window into a single time-indexed recharts dataset. The forecast
 * segment runs from the last actual point to whichever comes first — the ETA
 * (endpoint 100%) or the window reset (endpoint = predictedAtReset) — so a
 * barely-positive slope can't stretch the x-domain weeks out (Fable M2).
 * Missing values are `null` (gaps).
 */
export function buildUsageChartData(windows: UsageHistoryWindowSeries[]): {
	rows: ChartRow[];
	windowKeys: string[];
	predictionKeys: string[];
	markers: { x: number; label: string }[];
} {
	const windowKeys = windows.map((w) => w.window);
	const predictionKeys: string[] = [];
	const byTime = new Map<number, ChartRow>();
	const ensureRow = (t: number): ChartRow => {
		let row = byTime.get(t);
		if (!row) {
			row = { t };
			byTime.set(t, row);
		}
		return row;
	};

	for (const w of windows) {
		for (const p of w.points) ensureRow(p.t)[w.window] = p.utilization;

		const { state, etaExhaustMs, resetsAtMs, predictedAtReset } = w.prediction;
		if (state === "rising" && etaExhaustMs != null && w.points.length > 0) {
			const predKey = `${w.window}${PRED_SUFFIX}`;
			const last = w.points[w.points.length - 1];
			ensureRow(last.t)[predKey] = last.utilization;
			// Cap the drawn forecast at the reset when the ETA is beyond it.
			if (resetsAtMs != null && etaExhaustMs > resetsAtMs) {
				ensureRow(resetsAtMs)[predKey] = predictedAtReset ?? LIMIT;
			} else {
				ensureRow(etaExhaustMs)[predKey] = LIMIT;
			}
			predictionKeys.push(predKey);
		}
	}

	const allKeys = [...windowKeys, ...predictionKeys];
	const rows = [...byTime.values()].sort((a, b) => a.t - b.t);
	for (const row of rows) {
		for (const k of allKeys) if (!(k in row)) row[k] = null;
	}

	return { rows, windowKeys, predictionKeys, markers: resetMarkers(windows) };
}

/** One deduped vertical marker per distinct window reset time. */
export function resetMarkers(
	windows: UsageHistoryWindowSeries[],
): { x: number; label: string }[] {
	const seen = new Set<number>();
	const out: { x: number; label: string }[] = [];
	for (const w of windows) {
		for (const p of w.points) {
			if (p.resetsAt != null && !seen.has(p.resetsAt)) {
				seen.add(p.resetsAt);
				out.push({ x: p.resetsAt, label: "reset" });
			}
		}
	}
	return out.sort((a, b) => a.x - b.x);
}

/** Human-readable one-liner about a window's prediction. `now` is injected for determinism. */
export function formatPredictionAnnotation(
	series: UsageHistoryWindowSeries,
	now: number,
): string {
	const { window, prediction } = series;
	const atReset =
		prediction.predictedAtReset != null
			? ` (~${Math.round(prediction.predictedAtReset)}% at reset)`
			: "";
	// Handle terminal/stable states BEFORE lowConfidence — a stable window with a
	// short span is "stable", not "rising" (Fable M6).
	if (prediction.state === "insufficient_data") return `${window}: collecting data…`;
	if (prediction.state === "exhausted") return `${window}: at limit (100%+) ⛔`;
	if (prediction.state === "stable") {
		return `${window}: stable — no exhaustion predicted${atReset}`;
	}
	// Only "rising" remains.
	if (prediction.lowConfidence) {
		return `${window}: rising — low confidence (need >5 min of data)`;
	}
	if (prediction.etaExhaustMs == null) return `${window}: rising${atReset}`;
	const hours = Math.max(0, (prediction.etaExhaustMs - now) / (60 * 60 * 1000));
	const eta = hours < 1 ? `${Math.round(hours * 60)}m` : `${hours.toFixed(1)}h`;
	if (prediction.willExhaustBeforeReset) {
		return `${window}: ~${eta} to limit ⚠${atReset}`;
	}
	// Don't claim "safe until reset" when there is no known reset window (Fable M6).
	return prediction.resetsAtMs == null
		? `${window}: rising${atReset}`
		: `${window}: rising, safe until reset${atReset}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/dashboard-web/src/components/usage-history/__tests__/chart-data.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard-web/src/components/usage-history/chart-data.ts packages/dashboard-web/src/components/usage-history/__tests__/chart-data.test.ts
git commit -m "feat(dashboard): usage-history chart-data transforms"
```

---

## Task 13: `UsageHistoryChart` + `UsageHistoryTab`

**Files:**
- Create: `packages/dashboard-web/src/components/usage-history/UsageHistoryChart.tsx`
- Create: `packages/dashboard-web/src/components/usage-history/UsageHistoryTab.tsx`

**Interfaces:**
- Consumes: `buildUsageChartData`, `formatPredictionAnnotation` (Task 12); `BaseLineChart` + `LineConfig.strokeDasharray` + `ReferenceLineConfig.x` (Task 11); `useUsageHistory` (Task 10); `useAccounts` (existing); `COLORS` (existing constants).
- Produces: `<UsageHistoryTab />` — consumed by Task 14.

- [ ] **Step 1: Implement the chart** (`UsageHistoryChart.tsx`)

```tsx
import type { UsageHistoryWindowSeries } from "@better-ccflare/types";
import { COLORS } from "../../constants";
import { BaseLineChart } from "../charts/BaseLineChart";
import { buildUsageChartData } from "./chart-data";

const WINDOW_COLORS: Record<string, string> = {
	five_hour: COLORS.primary,
	seven_day: COLORS.blue,
	seven_day_opus: COLORS.purple,
	seven_day_sonnet: COLORS.cyan,
};

interface Props {
	windows: UsageHistoryWindowSeries[];
	loading?: boolean;
	height?: number;
}

export function UsageHistoryChart({ windows, loading, height = 400 }: Props) {
	const { rows, windowKeys, predictionKeys, markers } =
		buildUsageChartData(windows);

	const lines = [
		...windowKeys.map((key) => ({
			dataKey: key,
			stroke: WINDOW_COLORS[key] ?? COLORS.indigo,
			name: key,
			connectNulls: true, // bridge the gaps left by per-window sampling
		})),
		// dashed forecast line per rising window, same colour as its actual line
		...predictionKeys.map((key) => {
			const base = key.replace("__pred", "");
			return {
				dataKey: key,
				stroke: WINDOW_COLORS[base] ?? COLORS.indigo,
				name: `${base} (forecast)`,
				strokeDasharray: "6 4",
				strokeWidth: 1,
				connectNulls: true,
			};
		}),
	];

	const referenceLines = markers.map((m) => ({
		x: m.x,
		stroke: COLORS.warning,
		label: m.label,
	}));

	// Numeric time axis with a domain extended to cover future reset markers and
	// forecast endpoints — otherwise recharts (category axis / data-bounded domain)
	// drops them entirely (Fable H1). Y headroom keeps overage (>100%) visible (L6).
	const xs = [
		...rows.map((r) => r.t),
		...markers.map((m) => m.x),
	];
	const xDomain: [number, number] = xs.length
		? [Math.min(...xs), Math.max(...xs)]
		: [0, 1];
	const yMax = Math.max(
		100,
		...rows.flatMap((r) =>
			[...windowKeys, ...predictionKeys]
				.map((k) => r[k])
				.filter((v): v is number => typeof v === "number"),
		),
	);

	return (
		<BaseLineChart
			data={rows}
			xAxisKey="t"
			xAxisType="number"
			xAxisDomain={xDomain}
			lines={lines}
			referenceLines={referenceLines}
			loading={loading}
			height={height}
			showLegend
			yAxisDomain={[0, yMax]}
			emptyState="Collecting usage data…"
			xAxisTickFormatter={(v) => new Date(Number(v)).toLocaleString()}
			tooltipLabelFormatter={(v) => new Date(Number(v)).toLocaleString()}
			tooltipFormatter={(value, name) => [`${value}%`, String(name)]}
		/>
	);
}
```

> `emptyState` is a `CommonChartProps` field consumed by `ChartContainer` — confirm its expected type (string vs `ReactNode`); pass a matching value. Confirm `xAxisKey`/`yAxisDomain`/`tooltipFormatter`/`tooltipLabelFormatter`/`xAxisTickFormatter` names against `chart-utils.ts`.

> Confirm the exact `BaseLineChart` prop names for the x-axis key and formatters against `CommonChartProps`/`CommonAxisProps` in `components/charts/chart-utils.ts` (e.g. `xAxisKey`, `xAxisTickFormatter`, `yAxisDomain`, `tooltipFormatter`, `tooltipLabelFormatter`). Adjust names to match; do not invent props.

- [ ] **Step 2: Implement the tab** (`UsageHistoryTab.tsx`)

```tsx
import { useState } from "react";
import type { TimeRange } from "../../constants";
import { useAccounts } from "../../hooks/queries";
import { useUsageHistory } from "../../hooks/queries";
import { Card } from "../ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { UsageHistoryChart } from "./UsageHistoryChart";
import { formatPredictionAnnotation } from "./chart-data";

// Match the ranges the endpoint accepts (getRangeConfig: 1h/6h/24h/7d/30d).
const RANGES: TimeRange[] = ["1h", "6h", "24h", "7d", "30d"];

export function UsageHistoryTab() {
	const { data: accounts } = useAccounts();
	const [accountId, setAccountId] = useState<string>("");
	const [range, setRange] = useState<string>("24h");

	const selected = accountId || accounts?.[0]?.id || "";
	const { data, isLoading } = useUsageHistory(selected, range);
	const windows = data?.windows ?? [];

	return (
		<div className="space-y-4">
			<div className="flex gap-3">
				<Select value={selected} onValueChange={setAccountId}>
					<SelectTrigger className="w-64">
						<SelectValue placeholder="Select account" />
					</SelectTrigger>
					<SelectContent>
						{(accounts ?? []).map((a) => (
							<SelectItem key={a.id} value={a.id}>
								{a.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select value={range} onValueChange={setRange}>
					<SelectTrigger className="w-28">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{RANGES.map((r) => (
							<SelectItem key={r} value={r}>
								{r}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<Card className="p-4">
				<UsageHistoryChart windows={windows} loading={isLoading} />
			</Card>

			{windows.length > 0 && (
				<Card className="p-4 space-y-1 text-sm">
					{windows.map((w) => (
						<div key={w.window}>
							{formatPredictionAnnotation(w, Date.now())}
						</div>
					))}
				</Card>
			)}
		</div>
	);
}
```

> Confirm the import paths/prop APIs for `Card` and `Select` against `components/ui/card.tsx` and `components/ui/select.tsx` (both exist per the tree). Match how another tab (e.g. Analytics) uses them. The empty state is handled inside `BaseLineChart`/`ChartContainer` (it renders an empty view when `data` is empty).

- [ ] **Step 3: Verify**

Run: `cd packages/dashboard-web && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard-web/src/components/usage-history/UsageHistoryChart.tsx packages/dashboard-web/src/components/usage-history/UsageHistoryTab.tsx
git commit -m "feat(dashboard): UsageHistoryChart + UsageHistoryTab"
```

---

## Task 14: Register the tab

**Files:**
- Modify: `packages/dashboard-web/src/components/navigation.tsx` (icon import ~line 2-19; nav item in the `useMemo` ~line 77-106)
- Modify: `packages/dashboard-web/src/App.tsx` (lazy import ~line 27-36; route in `baseRoutes` ~line 66-143)

**Interfaces:**
- Consumes: `<UsageHistoryTab />` (Task 13).

- [ ] **Step 1: Add the nav item** — in `navigation.tsx`, import a lucide icon (with the others):

```typescript
import { History } from "lucide-react";
```

  and push into `baseItems` in the `useMemo` (e.g. after Accounts):

```typescript
			{ label: "Usage History", icon: History, path: "/usage-history" },
```

- [ ] **Step 2: Add the route** — in `App.tsx`, lazy-load the tab (with the other `lazy(...)` imports ~line 27-36):

```typescript
const LazyUsageHistoryTab = lazy(() =>
	import("./components/usage-history/UsageHistoryTab").then((m) => ({
		default: m.UsageHistoryTab,
	})),
);
```

  and add to `baseRoutes` (order to match the nav):

```typescript
			{
				path: "/usage-history",
				element: (
					<Suspense fallback={<LoadingSkeleton />}>
						<LazyUsageHistoryTab />
					</Suspense>
				),
				title: "Usage History",
				subtitle: "Per-account usage windows over time, with limit prediction",
			},
```

> Confirm `lazy`, `Suspense`, and `LoadingSkeleton` are already imported in `App.tsx` (the Analytics/Insights routes use them). If `UsageHistoryTab` is exported as a named export, the `.then((m) => ({ default: m.UsageHistoryTab }))` shim above is required; if you add a `default` export instead, simplify to `lazy(() => import(...))`.

- [ ] **Step 3: Verify (typecheck + build + manual)**

Run: `cd packages/dashboard-web && bunx tsc --noEmit`
Expected: no errors.
Manual: build/serve the dashboard, click the "Usage History" tab, pick an account, confirm the chart renders (or shows the empty state before data exists).

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard-web/src/components/navigation.tsx packages/dashboard-web/src/App.tsx
git commit -m "feat(dashboard): register Usage History tab"
```

---

## Final Verification

- [ ] **Full test suite:** `bun test` — expect all new tests green, no regressions.
- [ ] **Lint/format:** `bunx biome check --write .` (or the repo's configured command) — expect clean.
- [ ] **Typecheck all touched packages:** `bunx tsc --noEmit` in `packages/types`, `packages/config`, `packages/database`, `packages/http-api`, `packages/providers`, `apps/server`, `packages/dashboard-web`.

## Manual Verification (end-to-end)

1. Run the server against a real Anthropic OAuth account (`bun run` per the repo README).
2. Let it poll for ~3–5 minutes (poll interval ~90s). Generate a little Claude traffic so utilization moves.
3. Inspect the DB: `SELECT window_key, utilization, timestamp, resets_at FROM usage_snapshots ORDER BY timestamp DESC LIMIT 20;` — expect one row per window per poll for `five_hour`/`seven_day` (and `opus`/`sonnet` if present), including consecutive identical utilization values (no dedup — every poll is stored).
4. `curl 'http://localhost:8080/api/usage-history?account=<id>&range=24h'` (with auth header if API keys enabled) — expect `{ accountId, range, windows: [{ window, points, prediction }] }`.
5. Open the dashboard → "Usage History" → select the account → confirm the multi-line chart, vertical reset markers, and the prediction annotations render.

---

## Self-Review

**Spec coverage:** table + dual migration (T3) ✓; capture via existing poll, no new API calls (T8, `onSnapshot` at site 366 + 2 direct-fetch paths) ✓; one row per poll, no dedup (T4) ✓; dynamic windows (T4 duck-typing) ✓; endpoint + server-side prediction with segmentation/guards (T6, T7) ✓; retention env + cleanup wiring (T2, T9) ✓; UI tab + account selector + numeric-axis multi-line chart + reset markers + capped prediction line (T10–T14) ✓; error handling (best-effort `.catch` on capture T8; try/catch + BadRequest/InternalServerError in handler T7) ✓; tests across prediction/repo/migration/handler/config/transforms ✓.

**Applied from Fable 5 review:** numeric x-axis so reset markers/forecast actually render (H1, T11/T13); removed dedup so flat/idle windows don't vanish from range queries and the fit stays uniform (H2, T4); prediction ported from robsonek/claude-usage-dashboard with current-usage-anchored ETA, ≥5pp gift segmentation, idle-null-reset filtering, `predictedAtReset`, `lowConfidence` (T6); wire `onSnapshot` only at the Anthropic site 366 (M3, T8); forecast capped at reset (M2, T12); `showLegend` + Y overage headroom (M5/L6, T13); annotation ordering + no false "safe until reset" (M6, T12); `getRangeConfig` normalized range (L1, T7); `resets_at` NaN guard (L2, T4); no unit test for the plumbing-only T8 (L5); `log` not `logger` (L4, T9).

**Alignment with spec:** (1) `usage_snapshots` uses **no surrogate `id`** (house style forbids AUTOINCREMENT/SERIAL), pruned by `timestamp` — matches the spec's no-surrogate-key schema. (2) Spec "Resolved During Planning" items hold: utilization is **0–100** but can exceed 100 during overage (handled by the `exhausted` state); capture site is `UsageCache._doFetchAndCache` via an injected `onSnapshot` callback, plus best-effort writes on the two direct-fetch paths (auto-refresh scheduler + force-reset fallback) that bypass the poll loop.

**Placeholder scan:** the two capture-layer unit tests (T5 facade, T8 UsageCache) are marked conditional because they depend on constructability/mockability I could not fully verify from source; each has a concrete fallback (typecheck + manual E2E) and an explicit instruction NOT to refactor unrelated code to force a test. All other steps contain complete code.

**Type consistency:** `UsageSnapshotRow`/`PredictionPoint`/`UsagePrediction`/`UsageHistoryWindowSeries`/`UsageHistoryResponse` defined in T1 and consumed unchanged in T4/T6/T7/T10/T12/T13. `computeUsagePrediction(PredictionPoint[]) → UsagePrediction` consistent T6→T7. `recordUsageSnapshot(accountId, Record<string,unknown>, now)` consistent T5→T8. `ReferenceLineConfig.x` added T11, used T13.
