/**
 * Circuit Breaker view — routing-rules style list + sheet editor.
 * Supports multi primary models, multi-model fallback hops, key scoping.
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

type HopForm = { provider: string; models: string[]; key_id: string };

const emptyHop = (): HopForm => ({ provider: "", models: [], key_id: "" });

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

function hopModelsOf(h: CircuitBreakerFallbackHop): string[] {
	const ms = [...(h.models || [])];
	if (h.model && !ms.includes(h.model)) ms.unshift(h.model);
	return ms.filter(Boolean);
}

function autoName(primaryProv: string, primaryModels: string[], hops: HopForm[]) {
	const a = slugPart(primaryProv);
	const b = slugPart(primaryModels[0] || "");
	if (!a || !b) return "";
	const multi = primaryModels.length > 1 ? `-${primaryModels.length}m` : "";
	const last = hops.find((h) => h.provider && h.models.length > 0) || hops[0];
	if (last?.provider && last.models[0]) {
		return `${a}-${b}${multi}-to-${slugPart(last.provider)}-${slugPart(last.models[0])}`.replace(/-+/g, "-");
	}
	return `${a}-${b}${multi}-cb`;
}

function primaryModelsOf(p: CircuitBreakerPolicy): string[] {
	const ms = [...(p.primary_models || [])];
	if (p.primary_model && !ms.includes(p.primary_model)) ms.unshift(p.primary_model);
	return ms.filter(Boolean);
}

/** Collapse consecutive same provider+key hops into multi-model hops for editing. */
function hopsFromPolicy(p: CircuitBreakerPolicy): HopForm[] {
	const raw: HopForm[] = [];
	if (p.fallbacks && p.fallbacks.length > 0) {
		for (const h of p.fallbacks) {
			const models = hopModelsOf(h);
			if (!h.provider || models.length === 0) continue;
			const key = h.key_id || "";
			const prev = raw[raw.length - 1];
			if (prev && prev.provider === h.provider && prev.key_id === key) {
				for (const m of models) {
					if (!prev.models.includes(m)) prev.models.push(m);
				}
			} else {
				raw.push({ provider: h.provider, models: [...models], key_id: key });
			}
		}
	} else if (p.fallback_provider && p.fallback_model) {
		raw.push({
			provider: p.fallback_provider,
			models: [p.fallback_model],
			key_id: p.fallback_key_id || "",
		});
	}
	return raw.length > 0 ? raw : [emptyHop()];
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
			title={open ? "主线路已挂，当前流量走备用" : "主线路正常，请求还在走主线路"}
		>
			{open ? "已切备用" : "正常"}
		</span>
	);
}

function shortModel(m: string) {
	return m.replace(/^gpt-5\.6-/, "").replace(/^gpt-/, "");
}

function chainLabel(p: CircuitBreakerPolicy) {
	const hops = hopsFromPolicy(p).filter((h) => h.provider && h.models.length > 0);
	const models = primaryModelsOf(p).map(shortModel);
	const head = models.length ? `主：${models.join("、")}` : "主：?";
	if (hops.length === 0) return head;
	const rest = hops.map((h, i) => {
		const ms = h.models.map(shortModel).join("、");
		const keyHint = h.key_id ? "" : "";
		return `备${i + 1}：${ms}${keyHint}`;
	});
	return [head, ...rest].join(" → ");
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
					models: [],
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
			.filter((h) => h.provider.trim() && h.models.some((m) => m.trim()))
			.map((h) => {
				const models = h.models.map((m) => m.trim()).filter(Boolean);
				return {
					provider: h.provider.trim(),
					models,
					model: models[0],
					...(h.key_id.trim() ? { key_id: h.key_id.trim() } : {}),
				};
			});
		const primaryModels = form.primary_models.map((m) => m.trim()).filter(Boolean);
		if (!form.primary_provider.trim() || primaryModels.length === 0) {
			setError("请选择平时用的渠道，并至少选一个模型");
			return;
		}
		if (hops.length === 0) {
			setError("请至少加一档备用（渠道 + 至少一个模型）");
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
			fallback_model: hops[0].model || hops[0].models?.[0],
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
		<div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 p-3 sm:gap-6 sm:p-6" data-testid="circuit-breaker-page">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
				<div className="flex items-start gap-3">
					<CircuitBoard className="text-primary mt-1 h-7 w-7 shrink-0 sm:h-8 sm:w-8" strokeWidth={1.5} />
					<div className="min-w-0">
						<h1 className="text-lg font-semibold sm:text-xl">熔断器</h1>
						<p className="text-muted-foreground mt-1 max-w-2xl text-xs sm:text-sm">
							一句话：主线路老失败 → 自动换备用 → 过一会儿再试主线路。
							<br className="hidden sm:block" />
							<span className="sm:hidden"> </span>
							绿色「正常」= 还在走主线路（不是坏了）。红色「已切备用」= 已经切到备用了。
						</p>
					</div>
				</div>
				<div className="flex shrink-0 gap-2">
					<Button
						variant="outline"
						size="sm"
						className="flex-1 sm:flex-none"
						onClick={() => {
							refetchPolicies();
							refetchState();
						}}
					>
						<RefreshCw className="mr-2 h-4 w-4" />
						刷新
					</Button>
					<Button size="sm" className="flex-1 sm:flex-none" onClick={openCreate} data-testid="circuit-breaker-create-open">
						<Plus className="mr-2 h-4 w-4" />
						新建规则
					</Button>
				</div>
			</div>

			<div className="rounded-lg border">
				<div className="bg-muted/40 flex items-center justify-between border-b px-4 py-3">
					<div className="text-sm font-medium">
						我的切换规则
						<span className="text-muted-foreground ml-2 font-normal">
							{loadingPolicies || loadingState ? "加载中…" : `共 ${policies.length} 条`}
						</span>
					</div>
				</div>
				{policies.length === 0 && !loadingPolicies ? (
					<div className="text-muted-foreground flex flex-col items-center gap-3 px-4 py-16 text-center text-sm">
						<CircuitBoard className="h-10 w-10 opacity-40" />
						<p>还没有规则。点右上角「新建规则」，告诉网关：平时走哪条，挂了换哪条。</p>
						<Button size="sm" onClick={openCreate}>
							<Plus className="mr-2 h-4 w-4" />
							新建规则
						</Button>
					</div>
				) : (
					<ul className="divide-y">
						{policies.map((p) => {
							const st = stateByName.get(p.name);
							const hops = hopsFromPolicy(p).filter((h) => h.provider && h.models.length > 0);
							const models = primaryModelsOf(p);
							const keyNameById = new Map(allKeysData.map((k) => [k.key_id, k.name || k.key_id]));
							return (
								<li
									key={p.name}
									className="hover:bg-muted/30 flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4 sm:py-4"
									data-testid={`circuit-breaker-policy-${p.name}`}
								>
									<button type="button" className="min-w-0 flex-1 text-left" onClick={() => openEdit(p)}>
										<div className="flex flex-wrap items-center gap-2">
											<span className="font-medium">{p.name}</span>
											{stateBadge(st?.state ?? "closed")}
											{p.enabled === false && <span className="text-muted-foreground text-xs">已停用</span>}
											{models.length > 0 && (
												<span className="bg-muted rounded px-1.5 py-0.5 text-[10px] font-medium">
													监控 {models.map(shortModel).join("、")}
												</span>
											)}
											{(p.primary_key_ids?.length ?? 0) > 0 && (
												<span className="bg-muted rounded px-1.5 py-0.5 text-[10px] font-medium">
													主密钥 {p.primary_key_ids!.map((id) => keyNameById.get(id) || id.slice(0, 8)).join("、")}
												</span>
											)}
											{hops.length > 0 && (
												<span className="bg-muted rounded px-1.5 py-0.5 text-[10px] font-medium">{hops.length} 档备用</span>
											)}
										</div>
										<p className="text-muted-foreground mt-1 text-xs">{chainLabel(p)}</p>
										{st && (
											<p className="text-muted-foreground mt-1 text-xs">
												{st.state === "open"
													? `正在走备用；约 ${st.open_until ? new Date(st.open_until).toLocaleString() : "稍后"} 再试主线路`
													: st.failure_count > 0
														? `主线路最近失败 ${st.failure_count} 次（还没到换线门槛）`
														: "主线路正常，暂无失败记录"}
												{st.last_reason ? ` · 原因：${st.last_reason}` : ""}
											</p>
										)}
										{st?.key_states && st.key_states.length > 0 && (
											<div className="mt-2 flex flex-wrap gap-1.5">
												{st.key_states.map((ks) => (
													<span
														key={ks.key_id}
														className="bg-muted inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
													>
														<span className="max-w-[100px] truncate">
															{keyNameById.get(ks.key_id) || ks.key_id.slice(0, 8)}
														</span>
														{stateBadge(ks.state)}
													</span>
												))}
											</div>
										)}
									</button>
									<div className="flex w-full shrink-0 flex-wrap gap-2 sm:w-auto">
										<Button
											variant="outline"
											size="sm"
											className="flex-1 sm:flex-none"
											onClick={async () => {
												await resetPolicy(p.name);
												refetchState();
												toast.success("已恢复主线路");
											}}
										>
											<RotateCcw className="mr-1 h-3.5 w-3.5" />
											恢复主线路
										</Button>
										<Button variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={() => openEdit(p)}>
											修改
										</Button>
										<Button
											variant="destructive"
											size="sm"
											className="sm:flex-none"
											onClick={async () => {
												await deletePolicy(p.name);
												refetchPolicies();
												refetchState();
												toast.success("已删除");
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
				<SheetContent className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl" side="right">
					<SheetHeader className="border-b px-6 py-4 text-left">
						<SheetTitle>{editing ? `修改 · ${editing.name}` : "新建切换规则"}</SheetTitle>
						<SheetDescription>
							分三块填：① 平时走哪条 ② 挂了换哪几档备用 ③ 失败几次、休息多久。
						</SheetDescription>
					</SheetHeader>

					<div className="flex flex-1 flex-col gap-6 px-6 py-5">
						<div className="space-y-4">
							<div className="space-y-2">
								<Label>规则名称</Label>
								<Input
									value={form.name}
									onChange={(e) => setForm({ ...form, name: e.target.value, nameTouched: true })}
									placeholder="可自动生成，也可自己起名"
									disabled={!!editing}
								/>
							</div>
							<div className="flex items-center gap-2">
								<Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} id="cb-en" />
								<Label htmlFor="cb-en">启用这条规则</Label>
							</div>
						</div>

						<Separator />

						<div className="space-y-3">
							<div>
								<Label className="text-base">① 平时走哪条（主线路）</Label>
								<p className="text-muted-foreground mt-0.5 text-xs">
									选渠道 + 模型。密钥可勾多个：勾了就按密钥分别计数；都挂了才换备用。不勾=该模型下所有密钥一起算。
								</p>
							</div>
							<div className="space-y-3 rounded-lg border p-3">
								<div className="space-y-1.5">
									<Label className="text-xs">渠道</Label>
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
										placeholder="选渠道，比如 catai"
										emptyMessage="还没有渠道，先去「模型提供商」添加"
										noPortal
									/>
								</div>
								<div className="space-y-1.5">
									<Label className="text-xs">模型（可多选）</Label>
									<ModelMultiselect
										provider={form.primary_provider || undefined}
										value={form.primary_models}
										onChange={(models) => setForm((prev) => ({ ...prev, primary_models: models }))}
										placeholder="例如同时勾 sol 和 terra"
										disabled={!form.primary_provider}
										clearable
										className="w-full"
									/>
								</div>
								<div className="space-y-1.5">
									<Label className="text-xs">主线路密钥（可选，可多选）</Label>
									{primaryKeyOptions.length === 0 ? (
										<p className="text-muted-foreground text-xs">该渠道还没有密钥，先去「模型提供商」添加</p>
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
									<Label className="text-base">② 挂了换哪几档（备用）</Label>
									<p className="text-muted-foreground mt-0.5 text-xs">
										从上到下试：第 1 档先上，不行再第 2 档。每一档里也可以多选模型。
									</p>
								</div>
								<Button type="button" variant="outline" size="sm" onClick={addHop} className="gap-1">
									<Plus className="h-4 w-4" />
									加一档备用
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
												<span className="text-muted-foreground text-sm font-medium">备用第 {index + 1} 档</span>
												{form.fallbacks.length > 1 && (
													<Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => removeHop(index)}>
														<Trash2 className="h-4 w-4" />
													</Button>
												)}
											</div>
											<div className="space-y-2">
												<div className="space-y-1">
													<Label className="text-xs">渠道</Label>
													<ComboboxSelect
														options={providerOptions}
														value={hop.provider || null}
														onValueChange={(v) => setHop(index, { provider: v ?? "", models: [], key_id: "" })}
														placeholder="选渠道"
														className="h-9"
														noPortal
													/>
												</div>
												<div className="space-y-1">
													<Label className="text-xs">模型（可多选）</Label>
													<ModelMultiselect
														provider={hop.provider || undefined}
														value={hop.models}
														onChange={(models) => setHop(index, { models })}
														placeholder="例如 sol + terra"
														disabled={!hop.provider}
														clearable
														className="w-full"
													/>
												</div>
												<div className="space-y-1">
													<Label className="text-xs">用哪把密钥（可选）</Label>
													<ComboboxSelect
														options={[{ label: "不指定，系统自动选", value: "" }, ...hopKeys]}
														value={hop.key_id || ""}
														onValueChange={(v) => setHop(index, { key_id: v ?? "" })}
														placeholder="可选：指定密钥"
														className="h-9"
														noPortal
														disabled={!hop.provider}
													/>
												</div>
											</div>
										</div>
									);
								})}
							</div>
							<p className="text-muted-foreground text-xs">
								实际顺序：第1档里的模型按勾选顺序试完，再试第2档……
							</p>
						</div>

						<Separator />

						<div className="space-y-2">
							<Label className="text-base">③ 什么时候换线</Label>
							<p className="text-muted-foreground text-xs">
								例如：60 秒内失败 3 次就切备用，休息 30 秒后再试主线路。
							</p>
						</div>
						<div className="grid gap-3 sm:grid-cols-3">
							<div className="space-y-1.5">
								<Label className="text-xs">失败几次就换线</Label>
								<Input
									type="number"
									value={form.failure_threshold}
									onChange={(e) => setForm({ ...form, failure_threshold: Number(e.target.value) })}
								/>
							</div>
							<div className="space-y-1.5">
								<Label className="text-xs">在多长时间内计数</Label>
								<Input
									value={form.failure_window}
									onChange={(e) => setForm({ ...form, failure_window: e.target.value })}
									placeholder="如 60s"
								/>
							</div>
							<div className="space-y-1.5">
								<Label className="text-xs">休息多久再试主线路</Label>
								<Input
									value={form.default_cooldown}
									onChange={(e) => setForm({ ...form, default_cooldown: e.target.value })}
									placeholder="如 30s"
								/>
							</div>
						</div>

						{error && <p className="text-destructive text-sm">{error}</p>}
					</div>

					<div className="bg-card sticky bottom-0 flex justify-end gap-3 border-t px-6 py-4">
						<Button type="button" variant="outline" onClick={() => setSheetOpen(false)} disabled={saving}>
							取消
						</Button>
						<Button type="button" onClick={onSave} disabled={saving} data-testid="circuit-breaker-save">
							{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
							{editing ? "保存" : "创建"}
						</Button>
					</div>
				</SheetContent>
			</Sheet>
		</div>
	);
}
