/**
 * Circuit Breaker view — routing-rules style list + sheet editor.
 * Supports multi primary models, primary key scoping, multi-level fallbacks.
 */
import { Button } from "@/components/ui/button";
import { ComboboxSelect } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModelMultiselect } from "@/components/ui/modelMultiselect";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { ProviderIconType, RenderProviderIcon } from "@/lib/constants/icons";
import { getProviderLabel } from "@/lib/constants/logs";
import { t } from "@/lib/i18n";
import { getErrorMessage } from "@/lib/store";
import {
	useCreateCircuitBreakerPolicyMutation,
	useDeleteCircuitBreakerPolicyMutation,
	useGetCircuitBreakerPoliciesQuery,
	useGetCircuitBreakerStateQuery,
	useResetCircuitBreakerPolicyMutation,
	useUpdateCircuitBreakerPolicyMutation,
	type CircuitBreakerFallbackHop,
	type CircuitBreakerPolicy,
	type CircuitBreakerStateView,
} from "@/lib/store/apis/circuitBreakerApi";
import { useGetAllKeysQuery, useGetProvidersQuery } from "@/lib/store/apis/providersApi";
import { CircuitBoard, Loader2, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type HopForm = { provider: string; model: string; key_id: string };

const emptyHop = (): HopForm => ({ provider: "", model: "", key_id: "" });

type FormState = {
	name: string;
	nameTouched: boolean;
	enabled: boolean;
	primary_provider: string;
	primary_models: string[];
	primary_key_ids: string[];
	fallbacks: HopForm[];
	default_cooldown: string;
	failure_threshold: number;
	failure_window: string;
};

const emptyForm = (): FormState => ({
	name: "",
	nameTouched: false,
	enabled: true,
	primary_provider: "",
	primary_models: [],
	primary_key_ids: [],
	fallbacks: [emptyHop()],
	default_cooldown: "30s",
	failure_threshold: 5,
	failure_window: "60s",
});

function slugPart(s: string) {
	return s
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
}

function autoName(primaryProv: string, primaryModels: string[], hops: HopForm[]) {
	const a = slugPart(primaryProv);
	const b = slugPart(primaryModels[0] || "");
	if (!a || !b) return "";
	const multi = primaryModels.length > 1 ? `-${primaryModels.length}m` : "";
	const last = hops.find((h) => h.provider && h.model) || hops[0];
	if (last?.provider && last?.model) {
		return `${a}-${b}${multi}-to-${slugPart(last.provider)}-${slugPart(last.model)}`.replace(/-+/g, "-");
	}
	return `${a}-${b}${multi}-cb`;
}

function primaryModelsOf(p: CircuitBreakerPolicy): string[] {
	const ms = [...(p.primary_models || [])];
	if (p.primary_model && !ms.includes(p.primary_model)) ms.unshift(p.primary_model);
	return ms.filter(Boolean);
}

function hopsFromPolicy(p: CircuitBreakerPolicy): HopForm[] {
	if (p.fallbacks && p.fallbacks.length > 0) {
		return p.fallbacks.map((h) => ({
			provider: h.provider || "",
			model: h.model || "",
			key_id: h.key_id || "",
		}));
	}
	if (p.fallback_provider && p.fallback_model) {
		return [
			{
				provider: p.fallback_provider,
				model: p.fallback_model,
				key_id: p.fallback_key_id || "",
			},
		];
	}
	return [emptyHop()];
}

function stateBadge(state: string) {
	const open = state === "open";
	return (
		<span
			className={`rounded px-2 py-0.5 text-xs font-medium ${
				open
					? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"
					: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
			}`}
		>
			{state === "open" ? t("open") : state === "closed" ? t("closed") : state}
		</span>
	);
}

function chainLabel(p: CircuitBreakerPolicy) {
	const hops = hopsFromPolicy(p).filter((h) => h.provider && h.model);
	const models = primaryModelsOf(p);
	const head = models.length
		? `${p.primary_provider}/{${models.join(",")}}`
		: `${p.primary_provider}/${p.primary_model || "?"}`;
	if (hops.length === 0) return head;
	return [head, ...hops.map((h) => `${h.provider}/${h.model}`)].join(" → ");
}

export default function CircuitBreakerView() {
	const { data: policiesData, isLoading: loadingPolicies, refetch: refetchPolicies } = useGetCircuitBreakerPoliciesQuery();
	const { data: stateData, isLoading: loadingState, refetch: refetchState } = useGetCircuitBreakerStateQuery(undefined, {
		pollingInterval: 5000,
	});
	const { data: providersData = [] } = useGetProvidersQuery();
	const { data: allKeysData = [] } = useGetAllKeysQuery();
	const [createPolicy, { isLoading: creating }] = useCreateCircuitBreakerPolicyMutation();
	const [updatePolicy, { isLoading: updating }] = useUpdateCircuitBreakerPolicyMutation();
	const [deletePolicy] = useDeleteCircuitBreakerPolicyMutation();
	const [resetPolicy] = useResetCircuitBreakerPolicyMutation();

	const [sheetOpen, setSheetOpen] = useState(false);
	const [editing, setEditing] = useState<CircuitBreakerPolicy | null>(null);
	const [form, setForm] = useState<FormState>(emptyForm());
	const [error, setError] = useState<string | null>(null);

	const policies = policiesData?.policies ?? [];
	const stateByName = useMemo(() => {
		const m = new Map<string, CircuitBreakerStateView>();
		for (const s of stateData?.states ?? []) m.set(s.name, s);
		return m;
	}, [stateData]);

	const providerOptions = useMemo(
		() =>
			providersData.map((p) => ({
				label: getProviderLabel(p.name),
				value: p.name,
				icon: <RenderProviderIcon provider={p.name as ProviderIconType} size="sm" className="h-4 w-4" />,
			})),
		[providersData],
	);

	const primaryKeyOptions = useMemo(() => {
		if (!form.primary_provider) return [];
		return allKeysData
			.filter((k) => k.provider === form.primary_provider)
			.map((k) => ({
				label: k.name ? `${k.name} (${k.key_id.slice(0, 8)}…)` : k.key_id,
				value: k.key_id,
			}));
	}, [allKeysData, form.primary_provider]);

	useEffect(() => {
		if (sheetOpen && !editing && !form.primary_provider && providersData[0]?.name) {
			const first = providersData[0].name;
			setForm((prev) => ({
				...prev,
				primary_provider: first,
				fallbacks: prev.fallbacks.map((h, i) => (i === 0 && !h.provider ? { ...h, provider: first } : h)),
			}));
		}
	}, [sheetOpen, editing, form.primary_provider, providersData]);

	useEffect(() => {
		if (!sheetOpen || form.nameTouched || editing) return;
		const n = autoName(form.primary_provider, form.primary_models, form.fallbacks);
		if (n && n !== form.name) setForm((prev) => ({ ...prev, name: n }));
	}, [sheetOpen, form.primary_provider, form.primary_models, form.fallbacks, form.nameTouched, form.name, editing]);

	const openCreate = () => {
		setEditing(null);
		setForm(emptyForm());
		setError(null);
		setSheetOpen(true);
	};

	const openEdit = (p: CircuitBreakerPolicy) => {
		setEditing(p);
		setForm({
			name: p.name,
			nameTouched: true,
			enabled: p.enabled !== false,
			primary_provider: p.primary_provider,
			primary_models: primaryModelsOf(p),
			primary_key_ids: p.primary_key_ids ?? [],
			fallbacks: hopsFromPolicy(p),
			default_cooldown: p.default_cooldown || "30s",
			failure_threshold: p.failure_threshold || 5,
			failure_window: p.failure_window || "60s",
		});
		setError(null);
		setSheetOpen(true);
	};

	const setHop = (index: number, patch: Partial<HopForm>) => {
		setForm((prev) => ({
			...prev,
			fallbacks: prev.fallbacks.map((h, i) => (i === index ? { ...h, ...patch } : h)),
		}));
	};

	const addHop = () => {
		setForm((prev) => ({
			...prev,
			fallbacks: [
				...prev.fallbacks,
				{
					provider: prev.primary_provider || "",
					model: "",
					key_id: "",
				},
			],
		}));
	};

	const removeHop = (index: number) => {
		setForm((prev) => ({
			...prev,
			fallbacks: prev.fallbacks.length <= 1 ? prev.fallbacks : prev.fallbacks.filter((_, i) => i !== index),
		}));
	};

	const onSave = async () => {
		setError(null);
		const hops: CircuitBreakerFallbackHop[] = form.fallbacks
			.filter((h) => h.provider.trim() && h.model.trim())
			.map((h) => ({
				provider: h.provider.trim(),
				model: h.model.trim(),
				...(h.key_id.trim() ? { key_id: h.key_id.trim() } : {}),
			}));
		const primaryModels = form.primary_models.map((m) => m.trim()).filter(Boolean);
		if (!form.primary_provider.trim() || primaryModels.length === 0) {
			setError("请选择主提供商，并至少选择一个主模型");
			return;
		}
		if (hops.length === 0) {
			setError("请至少配置一级备用（提供商+模型）");
			return;
		}
		const name =
			form.name.trim() || autoName(form.primary_provider, primaryModels, form.fallbacks) || `cb-${Date.now()}`;
		const body: CircuitBreakerPolicy = {
			name,
			enabled: form.enabled,
			primary_provider: form.primary_provider.trim(),
			primary_models: primaryModels,
			primary_model: primaryModels[0],
			primary_key_ids: form.primary_key_ids.length > 0 ? form.primary_key_ids : undefined,
			fallbacks: hops,
			fallback_provider: hops[0].provider,
			fallback_model: hops[0].model,
			fallback_key_id: hops[0].key_id,
			default_cooldown: form.default_cooldown.trim() || "30s",
			failure_threshold: Number(form.failure_threshold) || 5,
			failure_window: form.failure_window.trim() || "60s",
		};
		try {
			if (editing) {
				await updatePolicy({ name: editing.name, data: body }).unwrap();
				toast.success(t("Updated successfully"));
			} else {
				await createPolicy(body).unwrap();
				toast.success(t("Created successfully"));
			}
			setSheetOpen(false);
			refetchPolicies();
			refetchState();
		} catch (e: unknown) {
			const msg = getErrorMessage(e) || String(e);
			setError(msg);
			toast.error(msg);
		}
	};

	const saving = creating || updating;

	return (
		<div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 p-6" data-testid="circuit-breaker-page">
			<div className="flex items-start justify-between gap-4">
				<div className="flex items-start gap-3">
					<CircuitBoard className="text-primary mt-1 h-8 w-8" strokeWidth={1.5} />
					<div>
						<h1 className="text-xl font-semibold">{t("Circuit Breaker")}</h1>
						<p className="text-muted-foreground mt-1 max-w-2xl text-sm">
							支持多主模型、API Key 级熔断与多级备用链。主通道持续失败后自动按序切备，冷却后再试主。
						</p>
					</div>
				</div>
				<div className="flex shrink-0 gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							refetchPolicies();
							refetchState();
						}}
					>
						<RefreshCw className="mr-2 h-4 w-4" />
						{t("Refresh")}
					</Button>
					<Button size="sm" onClick={openCreate} data-testid="circuit-breaker-create-open">
						<Plus className="mr-2 h-4 w-4" />
						{t("Create policy")}
					</Button>
				</div>
			</div>

			<div className="rounded-lg border">
				<div className="bg-muted/40 flex items-center justify-between border-b px-4 py-3">
					<div className="text-sm font-medium">
						{t("Policies")}
						<span className="text-muted-foreground ml-2 font-normal">
							{loadingPolicies || loadingState ? t("Loading…") : `${policies.length} ${t("policy(ies)")}`}
						</span>
					</div>
				</div>
				{policies.length === 0 && !loadingPolicies ? (
					<div className="text-muted-foreground flex flex-col items-center gap-3 px-4 py-16 text-center text-sm">
						<CircuitBoard className="h-10 w-10 opacity-40" />
						<p>{t("No policies yet. Create one above or set circuit_breaker_config in config.json.")}</p>
						<Button size="sm" onClick={openCreate}>
							<Plus className="mr-2 h-4 w-4" />
							{t("Create policy")}
						</Button>
					</div>
				) : (
					<ul className="divide-y">
						{policies.map((p) => {
							const st = stateByName.get(p.name);
							const hops = hopsFromPolicy(p).filter((h) => h.provider && h.model);
							const models = primaryModelsOf(p);
							return (
								<li
									key={p.name}
									className="hover:bg-muted/30 flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
									data-testid={`circuit-breaker-policy-${p.name}`}
								>
									<button type="button" className="min-w-0 flex-1 text-left" onClick={() => openEdit(p)}>
										<div className="flex flex-wrap items-center gap-2">
											<span className="font-medium">{p.name}</span>
											{stateBadge(st?.state ?? "closed")}
											{p.enabled === false && <span className="text-muted-foreground text-xs">{t("disabled")}</span>}
											{models.length > 1 && (
												<span className="bg-muted rounded px-1.5 py-0.5 text-[10px] font-medium">{models.length} 主模型</span>
											)}
											{(p.primary_key_ids?.length ?? 0) > 0 && (
												<span className="bg-muted rounded px-1.5 py-0.5 text-[10px] font-medium">
													{p.primary_key_ids!.length} key
												</span>
											)}
											{hops.length > 1 && (
												<span className="bg-muted rounded px-1.5 py-0.5 text-[10px] font-medium">{hops.length} 级备用</span>
											)}
										</div>
										<p className="text-muted-foreground mt-1 truncate font-mono text-xs">{chainLabel(p)}</p>
										{st && (
											<p className="text-muted-foreground mt-1 text-xs">
												{t("failures")}={st.failure_count}
												{st.last_reason ? ` · ${st.last_reason}` : ""}
												{st.open_until ? ` · ${t("open until")} ${st.open_until}` : ""}
											</p>
										)}
										{st?.key_states && st.key_states.length > 0 && (
											<div className="mt-2 flex flex-wrap gap-1.5">
												{st.key_states.map((ks) => (
													<span
														key={ks.key_id}
														className="bg-muted inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
													>
														<code className="max-w-[72px] truncate">{ks.key_id}</code>
														{stateBadge(ks.state)}
													</span>
												))}
											</div>
										)}
									</button>
									<div className="flex shrink-0 gap-2">
										<Button
											variant="outline"
											size="sm"
											onClick={async () => {
												await resetPolicy(p.name);
												refetchState();
												toast.success("已复位");
											}}
										>
											<RotateCcw className="mr-1 h-3.5 w-3.5" />
											{t("Reset")}
										</Button>
										<Button variant="outline" size="sm" onClick={() => openEdit(p)}>
											{t("Edit")}
										</Button>
										<Button
											variant="destructive"
											size="sm"
											onClick={async () => {
												await deletePolicy(p.name);
												refetchPolicies();
												refetchState();
												toast.success(t("Deleted successfully"));
											}}
										>
											<Trash2 className="h-4 w-4" />
										</Button>
									</div>
								</li>
							);
						})}
					</ul>
				)}
			</div>

			<Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
				<SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-xl" side="right">
					<SheetHeader className="border-b px-6 py-4 text-left">
						<SheetTitle>{editing ? `${t("Edit")} · ${editing.name}` : t("Create policy")}</SheetTitle>
						<SheetDescription>
							主：提供商 + 多模型 + Key（可选）。备：有序多级链，每级可指定 Key。
						</SheetDescription>
					</SheetHeader>

					<div className="flex flex-1 flex-col gap-6 px-6 py-5">
						<div className="space-y-4">
							<div className="space-y-2">
								<Label>{t("Name")}</Label>
								<Input
									value={form.name}
									onChange={(e) => setForm({ ...form, name: e.target.value, nameTouched: true })}
									placeholder={t("Auto-generated from primary → fallback")}
									disabled={!!editing}
								/>
							</div>
							<div className="flex items-center gap-2">
								<Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} id="cb-en" />
								<Label htmlFor="cb-en">{t("Enabled")}</Label>
							</div>
						</div>

						<Separator />

						<div className="space-y-3">
							<div>
								<Label className="text-base">主通道（监控对象）</Label>
								<p className="text-muted-foreground mt-0.5 text-xs">
									可多选主模型（同一套 Key/备用链）。Key 勾选后按 Key 分别熔断；全部 Key 熔断才走备用链。
								</p>
							</div>
							<div className="space-y-3 rounded-lg border p-3">
								<div className="space-y-1.5">
									<Label className="text-xs">{t("Primary provider")}</Label>
									<ComboboxSelect
										options={providerOptions}
										value={form.primary_provider || null}
										onValueChange={(v) =>
											setForm((prev) => ({
												...prev,
												primary_provider: v ?? "",
												primary_models: [],
												primary_key_ids: [],
											}))
										}
										placeholder={t("Select provider")}
										emptyMessage={t("No providers found")}
										noPortal
									/>
								</div>
								<div className="space-y-1.5">
									<Label className="text-xs">主模型（可多选）</Label>
									<ModelMultiselect
										provider={form.primary_provider || undefined}
										value={form.primary_models}
										onChange={(models) => setForm((prev) => ({ ...prev, primary_models: models }))}
										placeholder="选择一个或多个主模型，如 sol + terra"
										disabled={!form.primary_provider}
										clearable
										className="w-full"
									/>
									<p className="text-muted-foreground text-[11px]">
										同一策略监控多个主模型，共用 Key 与多级备用链，无需每个模型单独建策略。
									</p>
								</div>
								<div className="space-y-1.5">
									<Label className="text-xs">主 API Key（可多选，可选）</Label>
									{primaryKeyOptions.length === 0 ? (
										<p className="text-muted-foreground text-xs">该提供商暂无 Key，或先到「模型提供商」添加</p>
									) : (
										<div className="flex flex-col gap-1.5">
											{primaryKeyOptions.map((opt) => {
												const checked = form.primary_key_ids.includes(opt.value);
												return (
													<label
														key={opt.value}
														className="hover:bg-muted/50 flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm"
													>
														<input
															type="checkbox"
															className="accent-primary h-4 w-4"
															checked={checked}
															onChange={() => {
																setForm((prev) => ({
																	...prev,
																	primary_key_ids: checked
																		? prev.primary_key_ids.filter((id) => id !== opt.value)
																		: [...prev.primary_key_ids, opt.value],
																}));
															}}
														/>
														<span className="truncate">{opt.label}</span>
													</label>
												);
											})}
										</div>
									)}
								</div>
							</div>
						</div>

						<Separator />

						<div className="space-y-3">
							<div className="flex items-center justify-between gap-2">
								<div>
									<Label className="text-base">多级备用链</Label>
									<p className="text-muted-foreground mt-0.5 text-xs">
										按顺序尝试；第 1 级先接，失败再下一级（与路由规则 Fallbacks 类似）
									</p>
								</div>
								<Button type="button" variant="outline" size="sm" onClick={addHop} className="gap-1">
									<Plus className="h-4 w-4" />
									添加备用级
								</Button>
							</div>
							<div className="space-y-3">
								{form.fallbacks.map((hop, index) => {
									const hopKeys = hop.provider
										? allKeysData
												.filter((k) => k.provider === hop.provider)
												.map((k) => ({
													label: k.name ? `${k.name}` : k.key_id,
													value: k.key_id,
												}))
										: [];
									return (
										<div key={index} className="space-y-2 rounded-lg border p-3" data-testid={`cb-hop-${index}`}>
											<div className="flex items-center justify-between">
												<span className="text-muted-foreground text-sm font-medium">备用级 {index + 1}</span>
												{form.fallbacks.length > 1 && (
													<Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => removeHop(index)}>
														<Trash2 className="h-4 w-4" />
													</Button>
												)}
											</div>
											<div className="grid gap-2 sm:grid-cols-2">
												<ComboboxSelect
													options={providerOptions}
													value={hop.provider || null}
													onValueChange={(v) => setHop(index, { provider: v ?? "", model: "", key_id: "" })}
													placeholder={t("Select provider")}
													className="h-9"
													noPortal
												/>
												<ModelMultiselect
													isSingleSelect
													provider={hop.provider || undefined}
													value={hop.model}
													onChange={(model) => setHop(index, { model })}
													placeholder={t("Search models...")}
													disabled={!hop.provider}
													clearable
													className="!h-9 !min-h-9 w-full"
												/>
											</div>
											<div className="space-y-1">
												<Label className="text-xs">备用 Key（可选）</Label>
												<ComboboxSelect
													options={[{ label: "（不指定 / 自动选）", value: "" }, ...hopKeys]}
													value={hop.key_id || ""}
													onValueChange={(v) => setHop(index, { key_id: v ?? "" })}
													placeholder="可选：钉死某个 Key"
													className="h-9"
													noPortal
													disabled={!hop.provider}
												/>
											</div>
										</div>
									);
								})}
							</div>
							<p className="text-muted-foreground text-xs">
								熔断打开后：请求改写到第 1 级，其余级写入请求 fallbacks，按序接力。
							</p>
						</div>

						<Separator />

						<div className="grid gap-3 sm:grid-cols-3">
							<div className="space-y-1.5">
								<Label className="text-xs">{t("Cooldown")}</Label>
								<Input
									value={form.default_cooldown}
									onChange={(e) => setForm({ ...form, default_cooldown: e.target.value })}
								/>
							</div>
							<div className="space-y-1.5">
								<Label className="text-xs">{t("Failure threshold")}</Label>
								<Input
									type="number"
									value={form.failure_threshold}
									onChange={(e) => setForm({ ...form, failure_threshold: Number(e.target.value) })}
								/>
							</div>
							<div className="space-y-1.5">
								<Label className="text-xs">{t("Failure window")}</Label>
								<Input
									value={form.failure_window}
									onChange={(e) => setForm({ ...form, failure_window: e.target.value })}
								/>
							</div>
						</div>

						{error && <p className="text-destructive text-sm">{error}</p>}
					</div>

					<div className="bg-card sticky bottom-0 flex justify-end gap-3 border-t px-6 py-4">
						<Button type="button" variant="outline" onClick={() => setSheetOpen(false)} disabled={saving}>
							{t("Cancel")}
						</Button>
						<Button type="button" onClick={onSave} disabled={saving} data-testid="circuit-breaker-save">
							{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
							{editing ? t("Update") : t("Create")}
						</Button>
					</div>
				</SheetContent>
			</Sheet>
		</div>
	);
}
