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
	const xs = [...rows.map((r) => r.t), ...markers.map((m) => m.x)];
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
