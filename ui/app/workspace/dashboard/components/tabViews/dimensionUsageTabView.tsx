import {
	useGetLogsDimensionCostHistogramQuery,
	useGetLogsDimensionLatencyHistogramQuery,
	useGetLogsDimensionTokenHistogramQuery,
	useLazyGetLogsDimensionCostHistogramQuery,
	useLazyGetLogsDimensionLatencyHistogramQuery,
	useLazyGetLogsDimensionTokenHistogramQuery,
} from "@/lib/store";
import type {
	DimensionCostHistogramResponse,
	DimensionLatencyHistogramResponse,
	DimensionTokenHistogramResponse,
	HistogramDimension,
	LogFilters,
	ProviderCostHistogramResponse,
	ProviderLatencyHistogramResponse,
	ProviderTokenHistogramResponse,
} from "@/lib/types/logs";
import { forwardRef, useCallback, useImperativeHandle, useMemo } from "react";
import { computeDisplaySeries } from "../../utils/chartUtils";
import type { DashboardData } from "../../utils/exportUtils";
import type { ChartType } from "../charts/chartTypeToggle";
import { DimensionUsageTab } from "../dimensionUsageTab";

export interface DimensionUsageTabViewHandle {
	getData: () => Partial<DashboardData>;
	loadData: () => Promise<void>;
}

const sanitizeSeriesLabels = (values?: string[]): string[] => {
	if (!values) return [];
	const trimmed = values.map((v) => v.trim()).filter((v) => v.length > 0);
	return [...new Set(trimmed)];
};

function toProviderCost(data?: DimensionCostHistogramResponse): ProviderCostHistogramResponse | null {
	if (!data) return null;
	return {
		buckets: (data.buckets ?? []).map((b) => ({
			timestamp: b.timestamp,
			total_cost: b.total_cost,
			by_provider: b.by_dimension ?? {},
		})),
		bucket_size_seconds: data.bucket_size_seconds,
		providers: data.dimension_values ?? [],
	};
}

function toProviderToken(data?: DimensionTokenHistogramResponse): ProviderTokenHistogramResponse | null {
	if (!data) return null;
	return {
		buckets: (data.buckets ?? []).map((b) => ({
			timestamp: b.timestamp,
			by_provider: b.by_dimension ?? {},
		})),
		bucket_size_seconds: data.bucket_size_seconds,
		providers: data.dimension_values ?? [],
	};
}

function toProviderLatency(data?: DimensionLatencyHistogramResponse): ProviderLatencyHistogramResponse | null {
	if (!data) return null;
	return {
		buckets: (data.buckets ?? []).map((b) => ({
			timestamp: b.timestamp,
			by_provider: b.by_dimension ?? {},
		})),
		bucket_size_seconds: data.bucket_size_seconds,
		providers: data.dimension_values ?? [],
	};
}

interface DimensionUsageTabViewProps {
	filters: LogFilters;
	active: boolean;
	startTime: number;
	endTime: number;
	dimension: HistogramDimension | string;
	costChartType: ChartType;
	tokenChartType: ChartType;
	latencyChartType: ChartType;
	costValue: string;
	tokenValue: string;
	latencyValue: string;
	onDimensionChange: (dimension: string) => void;
	onCostChartToggle: (type: ChartType) => void;
	onTokenChartToggle: (type: ChartType) => void;
	onLatencyChartToggle: (type: ChartType) => void;
	onCostValueChange: (value: string) => void;
	onTokenValueChange: (value: string) => void;
	onLatencyValueChange: (value: string) => void;
}

export const DimensionUsageTabView = forwardRef<DimensionUsageTabViewHandle, DimensionUsageTabViewProps>(
	function DimensionUsageTabView(
		{
			filters,
			active,
			startTime,
			endTime,
			dimension,
			costChartType,
			tokenChartType,
			latencyChartType,
			costValue,
			tokenValue,
			latencyValue,
			onDimensionChange,
			onCostChartToggle,
			onTokenChartToggle,
			onLatencyChartToggle,
			onCostValueChange,
			onTokenValueChange,
			onLatencyValueChange,
		},
		ref,
	) {
		const fetchArg = useMemo(() => ({ filters, dimension }), [filters, dimension]);
		const skipOpts = useMemo(() => ({ skip: !active }), [active]);

		const { data: rawCost, isLoading: loadingCost } = useGetLogsDimensionCostHistogramQuery(fetchArg, skipOpts);
		const { data: rawToken, isLoading: loadingTokens } = useGetLogsDimensionTokenHistogramQuery(fetchArg, skipOpts);
		const { data: rawLatency, isLoading: loadingLatency } = useGetLogsDimensionLatencyHistogramQuery(fetchArg, skipOpts);

		const [triggerCost] = useLazyGetLogsDimensionCostHistogramQuery();
		const [triggerTokens] = useLazyGetLogsDimensionTokenHistogramQuery();
		const [triggerLatency] = useLazyGetLogsDimensionLatencyHistogramQuery();

		const costData = useMemo(() => toProviderCost(rawCost), [rawCost]);
		const tokenData = useMemo(() => toProviderToken(rawToken), [rawToken]);
		const latencyData = useMemo(() => toProviderLatency(rawLatency), [rawLatency]);

		const loadData = useCallback(async () => {
			await Promise.all([triggerCost(fetchArg, true), triggerTokens(fetchArg, true), triggerLatency(fetchArg, true)]);
		}, [fetchArg, triggerCost, triggerTokens, triggerLatency]);

		useImperativeHandle(
			ref,
			() => ({
				getData: () => ({
					providerCostData: costData,
					providerTokenData: tokenData,
					providerLatencyData: latencyData,
				}),
				loadData,
			}),
			[costData, tokenData, latencyData, loadData],
		);

		const availableValues = useMemo(
			() => sanitizeSeriesLabels([...(costData?.providers ?? []), ...(tokenData?.providers ?? []), ...(latencyData?.providers ?? [])]),
			[costData?.providers, tokenData?.providers, latencyData?.providers],
		);

		const costValues = useMemo(
			() => computeDisplaySeries(costData?.buckets, costData?.providers, (b, p) => b.by_provider?.[p] ?? 0),
			[costData],
		);
		const tokenValues = useMemo(
			() => computeDisplaySeries(tokenData?.buckets, tokenData?.providers, (b, p) => b.by_provider?.[p]?.total_tokens ?? 0),
			[tokenData],
		);
		const latencyValues = useMemo(
			() => computeDisplaySeries(latencyData?.buckets, latencyData?.providers, (b, p) => b.by_provider?.[p]?.total_requests ?? 0, false),
			[latencyData],
		);

		return (
			<DimensionUsageTab
				dimension={dimension}
				onDimensionChange={onDimensionChange}
				costData={costData}
				tokenData={tokenData}
				latencyData={latencyData}
				loadingCost={loadingCost}
				loadingTokens={loadingTokens}
				loadingLatency={loadingLatency}
				startTime={startTime}
				endTime={endTime}
				costChartType={costChartType}
				tokenChartType={tokenChartType}
				latencyChartType={latencyChartType}
				costValue={costValue}
				tokenValue={tokenValue}
				latencyValue={latencyValue}
				availableValues={availableValues}
				costValues={costValues}
				tokenValues={tokenValues}
				latencyValues={latencyValues}
				onCostChartToggle={onCostChartToggle}
				onTokenChartToggle={onTokenChartToggle}
				onLatencyChartToggle={onLatencyChartToggle}
				onCostValueChange={onCostValueChange}
				onTokenValueChange={onTokenValueChange}
				onLatencyValueChange={onLatencyValueChange}
			/>
		);
	},
);
