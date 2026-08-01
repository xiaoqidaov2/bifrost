/**
 * Tier → Model Routing configuration
 * Maps each complexity tier to a default model group.
 */

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ModelMultiselect } from "@/components/ui/modelMultiselect";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Loader2, Save } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

// ── Tier palette (mirrors page.tsx) ──
const P1 = "color-mix(in oklch, var(--primary) 30%, transparent)";
const P2 = "color-mix(in oklch, var(--primary) 55%, transparent)";
const P3 = "color-mix(in oklch, var(--primary) 75%, transparent)";
const P4 = "var(--primary)";

interface TierRoutingEntry {
	tier: string;
	name: string;
	color: string;
	description: string;
	enabled: boolean;
	models: string[];
	recommended: string;
}

const DEFAULT_ROUTING: TierRoutingEntry[] = [
	{
		tier: "SIMPLE",
		name: "简单",
		color: P1,
		description: "打招呼、闲聊、一眼能答的问题 — 路由到最便宜的模型",
		enabled: true,
		models: [],
		recommended: "建议：gpt-4.1-nano / claude-haiku / gemini-flash",
	},
	{
		tier: "MEDIUM",
		name: "普通",
		color: P2,
		description: "常规问答、知识检索、中等推理 — 性价比优先",
		enabled: true,
		models: [],
		recommended: "建议：gpt-4.1-mini / claude-sonnet / gemini-pro",
	},
	{
		tier: "COMPLEX",
		name: "复杂",
		color: P3,
		description: "代码生成、调试、架构设计、长文创作 — 准确率优先",
		enabled: true,
		models: [],
		recommended: "建议：gpt-5 / claude-sonnet-4 / gemini-ultra",
	},
	{
		tier: "REASONING",
		name: "深度思考",
		color: P4,
		description: "数学证明、强逻辑推理、策略推演 — 最强模型",
		enabled: true,
		models: [],
		recommended: "建议：gpt-5.6-sol / claude-opus / deepseek-r1",
	},
];

export function TierRouting() {
	const [routing, setRouting] = useState<TierRoutingEntry[]>(DEFAULT_ROUTING);
	const [isSaving, setIsSaving] = useState(false);

	const handleSave = async () => {
		setIsSaving(true);
		// TODO: wire to real API — POST /governance/complexity-tier-routing
		await new Promise((r) => setTimeout(r, 600));
		setIsSaving(false);
		toast.success("Tier 路由已保存", { position: "top-right" });
	};

	const toggleTier = (idx: number) => {
		setRouting((prev) => prev.map((r, i) => (i === idx ? { ...r, enabled: !r.enabled } : r)));
	};

	const setModels = (idx: number, models: string[]) => {
		setRouting((prev) => prev.map((r, i) => (i === idx ? { ...r, models } : r)));
	};

	return (
		<div className="space-y-6">
			<div className="space-y-1">
				<h2 className="text-sm font-semibold">Tier → 模型路由</h2>
				<p className="text-muted-foreground text-xs">
					为每个复杂度档位指定默认路由的模型组。路由规则中可用{" "}
					<code className="bg-muted rounded-sm px-1 py-0.5 font-mono text-[11px]">complexity_tier</code>{" "}
					条件匹配。
				</p>
			</div>

			<div className="space-y-3">
				{routing.map((entry, idx) => (
					<Card key={entry.tier} className={cn("rounded-sm border transition-opacity", !entry.enabled && "opacity-60")}>
						<CardHeader className="pb-3">
							<div className="flex items-start justify-between gap-4">
								<div className="flex items-center gap-3">
									<div className="h-8 w-1 shrink-0 self-stretch rounded-full" style={{ backgroundColor: entry.color }} />
									<div>
										<CardTitle className="text-sm">{entry.name}</CardTitle>
										<CardDescription className="mt-0.5 text-xs">{entry.description}</CardDescription>
									</div>
								</div>
								<Switch
									checked={entry.enabled}
									onCheckedChange={() => toggleTier(idx)}
									aria-label={`${entry.name} 路由开关`}
								/>
							</div>
						</CardHeader>
						<CardContent className="space-y-3">
							<div className="space-y-1.5">
								<Label className="text-muted-foreground text-xs">默认模型</Label>
								<ModelMultiselect
									placeholder="选择模型…"
									loadModelsOnEmptyProvider={true}
									value={entry.models}
									onChange={(models: string[]) => setModels(idx, models)}
									disabled={!entry.enabled}
								/>
							</div>
							{entry.models.length === 0 && (
								<p className="text-muted-foreground text-[11px]">{entry.recommended}</p>
							)}
						</CardContent>
					</Card>
				))}
			</div>

			<div className="bg-card sticky bottom-0 z-10 flex items-center justify-end border-t px-1 py-3 sm:py-4">
				<Button size="sm" onClick={handleSave} disabled={isSaving}>
					{isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
					{isSaving ? "保存中…" : "保存 Tier 路由"}
				</Button>
			</div>
		</div>
	);
}
