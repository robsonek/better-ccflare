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
		expect(rows.find((r) => r.t === 10 * H)?.seven_day__pred).toBe(58);
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
		expect(formatPredictionAnnotation(series()[1], 0).toLowerCase()).toContain(
			"stable",
		);
	});
});
