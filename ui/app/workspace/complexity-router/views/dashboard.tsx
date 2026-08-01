/**
 * Complexity Tier Dashboard
 * Shows tier distribution, request counts, avg latency, and a prompt tester.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Activity, Clock, Zap } from "lucide-react";
import { useMemo } from "react";

// ── Tier palette (mirrors page.tsx) ──
const P1 = "color-mix(in oklch, var(--primary) 30%, transparent)";
const P2 = "color-mix(in oklch, var(--primary) 55%, transparent)";
const P3 = "color-mix(in oklch, var(--primary) 75%, transparent)";
const P4 = "var(--primary)";

const TIERS = [
	{ key: "SIMPLE", name: "简单", color: P1, description: "打招呼、闲聊、一眼能答的问题" },
	{ key: "MEDIUM", name: "普通", color: P2, description: "常规问答、知识检索、中等推理" },
	{ key: "COMPLEX", name: "复杂", color: P3, description: "代码、调试、架构设计、长文创作" },
	{ key: "REASONING", name: "深度思考", color: P4, description: "数学证明、强逻辑推理、策略推演" },
] as const;

// ── Mock stats (replace with real API later) ──
const MOCK_STATS = {
	SIMPLE: { requests: 12840, pct: 48, avgLatencyMs: 120 },
	MEDIUM: { requests: 7480, pct: 28, avgLatencyMs: 450 },
	COMPLEX: { requests: 4100, pct: 16, avgLatencyMs: 1800 },
	REASONING: { requests: 1580, pct: 8, avgLatencyMs: 5200 },
	total: 26000,
};

function DonutRing({ pct, color, size = 120 }: { pct: number; color: string; size?: number }) {
	const r = (size - 8) / 2;
	const circ = 2 * Math.PI * r;
	const offset = circ * (1 - pct / 100);
	return (
		<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
			<circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth="6" />
			<circle
				cx={size / 2}
				cy={size / 2}
				r={r}
				fill="none"
				stroke={color}
				strokeWidth="6"
				strokeLinecap="round"
				strokeDasharray={`${circ * (pct / 100)} ${circ * (1 - pct / 100)}`}
				className="transition-[stroke-dasharray] duration-700 ease-out"
			/>
			<text
				x={size / 2}
				y={size / 2 + 1}
				textAnchor="middle"
				dominantBaseline="middle"
				className="fill-foreground rotate-90 text-sm font-bold"
			>
				{pct}%
			</text>
		</svg>
	);
}

export function ComplexityDashboard() {
	const stats = MOCK_STATS;

	const tierRows = useMemo(
		() =>
			TIERS.map((t) => ({
				...t,
				stat: stats[t.key as keyof typeof stats] as (typeof stats)["SIMPLE"],
			})),
		[],
	);

	return (
		<div className="space-y-6">
			{/* ── Summary row ── */}
			<div className="grid gap-3 sm:grid-cols-3">
				<Card className="rounded-sm border">
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">总请求</CardTitle>
						<Activity className="text-muted-foreground size-4" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold tabular-nums">{stats.total.toLocaleString()}</div>
						<p className="text-muted-foreground text-xs">过去 24 小时</p>
					</CardContent>
				</Card>
				<Card className="rounded-sm border">
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">加权延迟</CardTitle>
						<Clock className="text-muted-foreground size-4" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold tabular-nums">
							{Math.round(
								(Object.values(stats) as Array<{ avgLatencyMs: number; requests: number }>)
									.filter((s) => "avgLatencyMs" in s)
									.reduce((sum, s) => sum + s.avgLatencyMs * s.requests, 0) / stats.total,
							)}
							<span className="text-muted-foreground ml-1 text-sm font-normal">ms</span>
						</div>
						<p className="text-muted-foreground text-xs">按请求量加权</p>
					</CardContent>
				</Card>
				<Card className="rounded-sm border">
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">最高占比</CardTitle>
						<Zap className="text-muted-foreground size-4" />
					</CardHeader>
					<CardContent>
						<div className="flex items-baseline gap-2">
							<div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: TIERS[0].color }} />
							<span className="text-2xl font-bold tabular-nums">{TIERS[0].name}</span>
						</div>
						<p className="text-muted-foreground text-xs">占 {stats.SIMPLE.pct}% 的请求量</p>
					</CardContent>
				</Card>
			</div>

			{/* ── Tier cards + donut ── */}
			<div className="grid gap-4 lg:grid-cols-2">
				{/* Donut */}
				<Card className="rounded-sm border">
					<CardHeader className="pb-4">
						<CardTitle className="text-sm font-medium">Tier 分布</CardTitle>
					</CardHeader>
					<CardContent className="flex items-center justify-center gap-6">
						<div className="flex gap-4">
							{tierRows.map((tier) => (
								<DonutRing key={tier.key} pct={tier.stat.pct} color={tier.color} />
							))}
						</div>
						<div className="space-y-2">
							{tierRows.map((tier) => (
								<div key={tier.key} className="flex items-center gap-2 text-sm">
									<div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: tier.color }} />
									<span className="w-16 font-medium">{tier.name}</span>
									<span className="text-muted-foreground tabular-nums">{tier.stat.pct}%</span>
								</div>
							))}
						</div>
					</CardContent>
				</Card>

				{/* Tier detail cards */}
				<div className="space-y-3">
					{tierRows.map((tier) => (
						<Card key={tier.key} className="rounded-sm border">
							<CardContent className="flex items-center gap-4 p-4">
								<div className="h-full w-1 shrink-0 self-stretch rounded-full" style={{ backgroundColor: tier.color }} />
								<div className="min-w-0 flex-1">
									<div className="flex items-center justify-between">
										<span className="text-sm font-medium">{tier.name}</span>
										<span className="text-muted-foreground font-mono text-xs tabular-nums">
											{tier.stat.requests.toLocaleString()} 次
										</span>
									</div>
									<p className="text-muted-foreground mt-0.5 text-xs">{tier.description}</p>
									<div className="mt-2 flex items-center gap-4 text-xs">
										<span className="text-muted-foreground">
											平均 <span className="font-mono font-medium tabular-nums">{tier.stat.avgLatencyMs}ms</span>
										</span>
										<div className="bg-muted h-4 flex-1 overflow-hidden rounded-full">
											<div
												className="h-full rounded-full transition-all duration-500 ease-out"
												style={{
													width: `${tier.stat.pct}%`,
													backgroundColor: tier.color,
												}}
											/>
										</div>
										<span className="text-muted-foreground w-10 text-right font-mono tabular-nums">{tier.stat.pct}%</span>
									</div>
								</div>
							</CardContent>
						</Card>
					))}
				</div>
			</div>

			{/* ── Note ── */}
			<p className="text-muted-foreground text-center text-xs">
				数据每 5 分钟更新一次。以上为近 24 小时统计摘要。
			</p>
		</div>
	);
}

export function DashboardSkeleton() {
	return (
		<div className="space-y-4">
			<div className="grid gap-3 sm:grid-cols-3">
				<Skeleton className="h-28 rounded-sm" />
				<Skeleton className="h-28 rounded-sm" />
				<Skeleton className="h-28 rounded-sm" />
			</div>
			<div className="grid gap-4 lg:grid-cols-2">
				<Skeleton className="h-72 rounded-sm" />
				<div className="space-y-3">
					<Skeleton className="h-24 rounded-sm" />
					<Skeleton className="h-24 rounded-sm" />
					<Skeleton className="h-24 rounded-sm" />
					<Skeleton className="h-24 rounded-sm" />
				</div>
			</div>
		</div>
	);
}
