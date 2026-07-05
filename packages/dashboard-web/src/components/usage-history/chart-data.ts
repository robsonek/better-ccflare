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
	if (prediction.state === "insufficient_data")
		return `${window}: collecting data…`;
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
