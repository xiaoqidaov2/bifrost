import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
	HistogramDimension,
	ProviderCostHistogramResponse,
	ProviderLatencyHistogramResponse,
	ProviderTokenHistogramResponse,
} from "@/lib/types/logs";
import { COMPACT_NUMBER_FORMAT } from "@/lib/utils/numbers";
import NumberFlow from "@number-flow/react";
import { memo, useMemo } from "react";
import {
	CHART_COLORS,
	CHART_HEADER_LEGEND_CLASS,
	LATENCY_COLORS,
	OTHER_SERIES_COLOR,
	OTHER_SERIES_KEY,
	OTHER_SERIES_LABEL,
	getModelColor,
} from "../utils/chartUtils";
import { ChartCard } from "./charts/chartCard";
import { type ChartType, ChartTypeToggle } from "./charts/chartTypeToggle";
import { ProviderCostChart } from "./charts/providerCostChart";
import { ProviderFilterSelect } from "./charts/providerFilterSelect";
import { ProviderLatencyChart } from "./charts/providerLatencyChart";
import { ProviderTokenChart } from "./charts/providerTokenChart";

const DIMENSION_OPTIONS: { value: HistogramDimension; label: string }[] = [
	{ value: "provider", label: "Provider" },
	{ value: "team_id", label: "Team" },
	{ value: "customer_id", label: "Customer" },
	{ value: "user_id", label: "User" },
	{ value: "business_unit_id", label: "Business Unit" },
];

export interface DimensionUsageTabProps {
	dimension: string;
	onDimensionChange: (dimension: string) => void;
	costData: ProviderCostHistogramResponse | null;
	tokenData: ProviderTokenHistogramResponse | null;
	latencyData: ProviderLatencyHistogramResponse | null;
	loadingCost: boolean;
	loadingTokens: boolean;
	loadingLatency: boolean;
	startTime: number;
	endTime: number;
	costChartType: ChartType;
	tokenChartType: ChartType;
	latencyChartType: ChartType;
	costValue: string;
	tokenValue: string;
	latencyValue: string;
	availableValues: string[];
	costValues: string[];
	tokenValues: string[];
	latencyValues: string[];
	onCostChartToggle: (type: ChartType) => void;
	onTokenChartToggle: (type: ChartType) => void;
	onLatencyChartToggle: (type: ChartType) => void;
	onCostValueChange: (value: string) => void;
	onTokenValueChange: (value: string) => void;
	onLatencyValueChange: (value: string) => void;
}

function DimensionUsageTabImpl({
	dimension,
	onDimensionChange,
	costData,
	tokenData,
	latencyData,
	loadingCost,
	loadingTokens,
	loadingLatency,
	startTime,
	endTime,
	costChartType,
	tokenChartType,
	latencyChartType,
	costValue,
	tokenValue,
	latencyValue,
	availableValues,
	costValues,
	tokenValues,
	latencyValues,
	onCostChartToggle,
	onTokenChartToggle,
	onLatencyChartToggle,
	onCostValueChange,
	onTokenValueChange,
	onLatencyValueChange,
}: DimensionUsageTabProps) {
	const costTotal = useMemo(() => {
		if (!costData?.buckets) return null;
		if (costValue === "all") {
			return costData.buckets.reduce((sum, b) => sum + (b.total_cost ?? 0), 0);
		}
		return costData.buckets.reduce((sum, b) => sum + (b.by_provider?.[costValue] ?? 0), 0);
	}, [costData, costValue]);

	const tokenTotal = useMemo(() => {
		if (!tokenData?.buckets) return null;
		let sum = 0;
		for (const b of tokenData.buckets) {
			if (!b.by_provider) continue;
			if (tokenValue === "all") {
				for (const p of tokenData.providers) sum += b.by_provider[p]?.total_tokens ?? 0;
			} else {
				sum += b.by_provider[tokenValue]?.total_tokens ?? 0;
			}
		}
		return sum;
	}, [tokenData, tokenValue]);

	const latencyAvg = useMemo(() => {
		if (!latencyData?.buckets) return null;
		let weighted = 0;
		let count = 0;
		for (const b of latencyData.buckets) {
			if (!b.by_provider) continue;
			const values = latencyValue === "all" ? latencyData.providers : [latencyValue];
			for (const p of values) {
				const s = b.by_provider[p];
				if (!s || !s.total_requests) continue;
				weighted += (s.avg_latency ?? 0) * s.total_requests;
				count += s.total_requests;
			}
		}
		return count > 0 ? weighted / count : null;
	}, [latencyData, latencyValue]);

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-muted-foreground text-sm">Group by</span>
				<Select value={dimension} onValueChange={onDimensionChange}>
					<SelectTrigger className="w-[200px]" data-testid="dashboard-dimension-select">
						<SelectValue placeholder="Dimension" />
					</SelectTrigger>
					<SelectContent>
						{DIMENSION_OPTIONS.map((opt) => (
							<SelectItem key={opt.value} value={opt.value}>
								{opt.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<span className="text-muted-foreground text-xs">
					Cost / tokens / latency over time for the selected dimension (backend by-dimension histograms).
				</span>
			</div>

			<div className="grid grid-cols-1 gap-2 lg:grid-cols-2 2xl:grid-cols-3">
				<ChartCard
					title="Dimension Cost"
					loading={loadingCost}
					testId="chart-dimension-cost"
					totalLabel="Total"
					total={
						costTotal !== null ? (
							<NumberFlow value={costTotal} format={{ ...COMPACT_NUMBER_FORMAT, style: "currency", currency: "USD" }} />
						) : undefined
					}
					totalTooltip={
						costTotal !== null
							? costTotal.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 })
							: undefined
					}
					legend={
						<div className={CHART_HEADER_LEGEND_CLASS}>
							{costValue === "all" ? (
								costValues.length > 0 && (
									<>
										<Tooltip>
											<TooltipTrigger asChild>
												<span data-testid="dimension-cost-legend-trigger" className="flex items-center gap-1">
													<span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: getModelColor(0) }} />
													<span className="text-muted-foreground max-w-[100px] truncate">{costValues[0]}</span>
												</span>
											</TooltipTrigger>
											<TooltipContent>{costValues[0]}</TooltipContent>
										</Tooltip>
										{costValues.length > 1 && (
											<span className="text-muted-foreground">+{costValues.length - 1} more</span>
										)}
									</>
								)
							) : (
								<span className="flex items-center gap-1">
									<span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: getModelColor(0) }} />
									<span className="text-muted-foreground max-w-[100px] truncate">{costValue}</span>
								</span>
							)}
						</div>
					}
					controls={
						<>
							<ProviderFilterSelect
								providers={availableValues}
								selectedProvider={costValue}
								onProviderChange={onCostValueChange}
								data-testid="dashboard-dimension-cost-filter"
							/>
							<ChartTypeToggle
								chartType={costChartType}
								onToggle={onCostChartToggle}
								data-testid="dashboard-dimension-cost-chart-toggle"
							/>
						</>
					}
				>
					<ProviderCostChart
						data={costData}
						chartType={costChartType}
						startTime={startTime}
						endTime={endTime}
						selectedProvider={costValue}
					/>
				</ChartCard>

				<ChartCard
					title="Dimension Token Usage"
					loading={loadingTokens}
					testId="chart-dimension-tokens"
					totalLabel="Total"
					total={tokenTotal !== null ? <NumberFlow value={tokenTotal} format={COMPACT_NUMBER_FORMAT} /> : undefined}
					totalTooltip={tokenTotal !== null ? tokenTotal.toLocaleString("en-US") : undefined}
					legend={
						<div className={CHART_HEADER_LEGEND_CLASS}>
							{tokenValue === "all" ? (
								tokenValues.length > 0 && (
									<>
										<span className="flex items-center gap-1">
											<span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: getModelColor(0) }} />
											<span className="text-muted-foreground max-w-[100px] truncate">{tokenValues[0]}</span>
										</span>
										{tokenValues.length > 1 && (
											<span className="text-muted-foreground">+{tokenValues.length - 1} more</span>
										)}
									</>
								)
							) : (
								<>
									<span className="flex items-center gap-1">
										<span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: CHART_COLORS.promptTokens }} />
										<span className="text-muted-foreground">Input</span>
									</span>
									<span className="flex items-center gap-1">
										<span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: CHART_COLORS.completionTokens }} />
										<span className="text-muted-foreground">Output</span>
									</span>
								</>
							)}
						</div>
					}
					controls={
						<>
							<ProviderFilterSelect
								providers={availableValues}
								selectedProvider={tokenValue}
								onProviderChange={onTokenValueChange}
								data-testid="dashboard-dimension-token-filter"
							/>
							<ChartTypeToggle
								chartType={tokenChartType}
								onToggle={onTokenChartToggle}
								data-testid="dashboard-dimension-token-chart-toggle"
							/>
						</>
					}
				>
					<ProviderTokenChart
						data={tokenData}
						chartType={tokenChartType}
						startTime={startTime}
						endTime={endTime}
						selectedProvider={tokenValue}
					/>
				</ChartCard>

				<ChartCard
					title="Dimension Latency"
					loading={loadingLatency}
					testId="chart-dimension-latency"
					totalLabel="Avg"
					total={
						latencyAvg !== null ? (
							<NumberFlow value={latencyAvg} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} suffix="ms" />
						) : undefined
					}
					totalTooltip={
						latencyAvg !== null ? `${latencyAvg.toLocaleString("en-US", { maximumFractionDigits: 6 })}ms` : undefined
					}
					legend={
						<div className={CHART_HEADER_LEGEND_CLASS}>
							{latencyValue === "all" ? (
								latencyValues.length > 0 && (
									<span className="flex items-center gap-1">
										<span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: getModelColor(0) }} />
										<span className="text-muted-foreground max-w-[100px] truncate">{latencyValues[0]}</span>
									</span>
								)
							) : (
								<>
									<span className="flex items-center gap-1">
										<span className="h-2 w-2 rounded-full" style={{ backgroundColor: LATENCY_COLORS.avg }} />
										<span className="text-muted-foreground">Avg</span>
									</span>
									<span className="flex items-center gap-1">
										<span className="h-2 w-2 rounded-full" style={{ backgroundColor: LATENCY_COLORS.p99 }} />
										<span className="text-muted-foreground">P99</span>
									</span>
								</>
							)}
							{/* silence unused import guards */}
							{false && OTHER_SERIES_KEY && OTHER_SERIES_COLOR && OTHER_SERIES_LABEL}
						</div>
					}
					controls={
						<>
							<ProviderFilterSelect
								providers={availableValues}
								selectedProvider={latencyValue}
								onProviderChange={onLatencyValueChange}
								data-testid="dashboard-dimension-latency-filter"
							/>
							<ChartTypeToggle
								chartType={latencyChartType}
								onToggle={onLatencyChartToggle}
								data-testid="dashboard-dimension-latency-chart-toggle"
							/>
						</>
					}
				>
					<ProviderLatencyChart
						data={latencyData}
						chartType={latencyChartType}
						startTime={startTime}
						endTime={endTime}
						selectedProvider={latencyValue}
					/>
				</ChartCard>
			</div>
		</div>
	);
}

export const DimensionUsageTab = memo(DimensionUsageTabImpl);
