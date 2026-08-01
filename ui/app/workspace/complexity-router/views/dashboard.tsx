/**
 * Complexity Tier Dashboard
 *
 * Complexity classification is evaluated only while a routing rule needs it.
 * The result is not persisted in request logs, so no truthful per-tier
 * aggregate is available to render here yet.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity } from "lucide-react";

export function ComplexityDashboard() {
	return (
		<Card className="rounded-sm border">
			<CardHeader className="flex flex-row items-center gap-2 space-y-0">
				<Activity className="text-muted-foreground size-4" aria-hidden="true" />
				<CardTitle className="text-sm font-medium">复杂度统计暂不可用</CardTitle>
			</CardHeader>
			<CardContent className="space-y-2">
				<p className="text-muted-foreground text-sm">
					当前版本不会持久化每个请求的复杂度分档结果，因此无法提供准确的 Tier 请求量或延迟统计。
				</p>
				<p className="text-muted-foreground text-xs">仪表盘不会展示模拟数据；配置的复杂度路由规则仍会在请求处理时正常生效。</p>
			</CardContent>
		</Card>
	);
}