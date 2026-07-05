import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { UsageHistoryRepository } from "../usage-history.repository";

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
