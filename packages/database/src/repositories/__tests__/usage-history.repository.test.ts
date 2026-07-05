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
