import { CircuitBoard, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ComboboxSelect } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModelMultiselect } from "@/components/ui/modelMultiselect";
import { Switch } from "@/components/ui/switch";
import { ProviderIconType, RenderProviderIcon } from "@/lib/constants/icons";
import { getProviderLabel } from "@/lib/constants/logs";
import { t } from "@/lib/i18n";
import {
	useCreateCircuitBreakerPolicyMutation,
	useDeleteCircuitBreakerPolicyMutation,
	useGetCircuitBreakerPoliciesQuery,
	useGetCircuitBreakerStateQuery,
	useResetCircuitBreakerPolicyMutation,
	type CircuitBreakerPolicy,
} from "@/lib/store/apis/circuitBreakerApi";
import { useGetProvidersQuery } from "@/lib/store/apis/providersApi";

const emptyForm = {
	name: "",
	nameTouched: false,
	enabled: true,
	primary_provider: "",
	primary_model: "",
	fallback_provider: "",
	fallback_model: "",
	default_cooldown: "30s",
	failure_threshold: 5,
	failure_window: "60s",
};

function slugPart(s: string) {
	return s
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
}

function autoName(primaryProv: string, primaryModel: string, fallbackProv: string, fallbackModel: string) {
	const a = slugPart(primaryProv);
	const b = slugPart(primaryModel);
	const c = slugPart(fallbackProv || primaryProv);
	const d = slugPart(fallbackModel);
	if (!a || !b) return "";
	if (d) return `${a}-${b}-to-${c}-${d}`.replace(/-+/g, "-");
	return `${a}-${b}-cb`;
}

function stateLabel(s: string) {
	if (s === "open") return t("open");
	if (s === "closed") return t("closed");
	return s;
}

export default function CircuitBreakerView() {
	const { data: policiesData, isLoading: loadingPolicies, refetch: refetchPolicies } = useGetCircuitBreakerPoliciesQuery();
	const { data: stateData, isLoading: loadingState, refetch: refetchState } = useGetCircuitBreakerStateQuery(undefined, {
		pollingInterval: 5000,
	});
	const { data: providersData = [] } = useGetProvidersQuery();
	const [createPolicy, { isLoading: creating }] = useCreateCircuitBreakerPolicyMutation();
	const [deletePolicy] = useDeleteCircuitBreakerPolicyMutation();
	const [resetPolicy] = useResetCircuitBreakerPolicyMutation();
	const [form, setForm] = useState(emptyForm);
	const [error, setError] = useState<string | null>(null);

	const providerOptions = useMemo(
		() =>
			providersData.map((p) => ({
				label: getProviderLabel(p.name),
				value: p.name,
				icon: <RenderProviderIcon provider={p.name as ProviderIconType} size="sm" className="h-4 w-4" />,
			})),
		[providersData],
	);

	// Prefill first provider once list loads (smart default).
	useEffect(() => {
		if (form.primary_provider || providersData.length === 0) return;
		const first = providersData[0]?.name ?? "";
		if (!first) return;
		setForm((prev) => ({
			...prev,
			primary_provider: first,
			fallback_provider: first,
			name: prev.nameTouched ? prev.name : autoName(first, prev.primary_model, first, prev.fallback_model),
		}));
	}, [providersData, form.primary_provider]);

	// Auto name from selections unless user edited name.
	useEffect(() => {
		if (form.nameTouched) return;
		const n = autoName(form.primary_provider, form.primary_model, form.fallback_provider, form.fallback_model);
		if (n && n !== form.name) {
			setForm((prev) => ({ ...prev, name: n }));
		}
	}, [form.primary_provider, form.primary_model, form.fallback_provider, form.fallback_model, form.nameTouched, form.name]);

	const stateByName = useMemo(() => {
		const m = new Map<string, { state: string; failure_count: number; last_reason?: string; open_until?: string }>();
		for (const s of stateData?.states ?? []) {
			m.set(s.name, s);
		}
		return m;
	}, [stateData]);

	const onCreate = async () => {
		setError(null);
		const name =
			form.name.trim() ||
			autoName(form.primary_provider, form.primary_model, form.fallback_provider, form.fallback_model);
		try {
			const body: CircuitBreakerPolicy = {
				name,
				enabled: form.enabled,
				primary_provider: form.primary_provider.trim(),
				primary_model: form.primary_model.trim(),
				fallback_provider: (form.fallback_provider || form.primary_provider).trim(),
				fallback_model: form.fallback_model.trim(),
				default_cooldown: form.default_cooldown.trim() || "30s",
				failure_threshold: Number(form.failure_threshold) || 5,
				failure_window: form.failure_window.trim() || "60s",
			};
			if (!body.primary_provider || !body.primary_model || !body.fallback_model) {
				setError("请选择主/备用提供商与模型");
				return;
			}
			await createPolicy(body).unwrap();
			setForm({
				...emptyForm,
				primary_provider: body.primary_provider,
				fallback_provider: body.fallback_provider,
			});
			refetchPolicies();
			refetchState();
		} catch (e: unknown) {
			const msg = e && typeof e === "object" && "data" in e ? JSON.stringify((e as { data: unknown }).data) : String(e);
			setError(msg);
		}
	};

	const policies = policiesData?.policies ?? [];
	const canCreate =
		!!form.primary_provider && !!form.primary_model && !!(form.fallback_provider || form.primary_provider) && !!form.fallback_model;

	return (
		<div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 p-6" data-testid="circuit-breaker-page">
			<div className="flex items-start justify-between gap-4">
				<div className="flex items-start gap-3">
					<CircuitBoard className="text-primary mt-1 h-8 w-8" strokeWidth={1.5} />
					<div>
						<h1 className="text-xl font-semibold">{t("Circuit Breaker")}</h1>
						<p className="text-muted-foreground mt-1 max-w-2xl text-sm">
							{t(
								"When a primary provider/model keeps failing, Bifrost opens the circuit and routes traffic to your fallback for a cooldown window — first-class sticky failover (OSS).",
							)}
						</p>
					</div>
				</div>
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						refetchPolicies();
						refetchState();
					}}
					data-testid="circuit-breaker-refresh"
				>
					<RefreshCw className="mr-2 h-4 w-4" />
					{t("Refresh")}
				</Button>
			</div>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">{t("Create policy")}</CardTitle>
					<CardDescription>
						{t("Pick from your configured providers and models — no manual typing needed.")}
					</CardDescription>
				</CardHeader>
				<CardContent className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-2 sm:col-span-2">
						<Label htmlFor="cb-name">{t("Name")}</Label>
						<Input
							id="cb-name"
							value={form.name}
							onChange={(e) => setForm({ ...form, name: e.target.value, nameTouched: true })}
							placeholder={t("Auto-generated from primary → fallback")}
						/>
						<p className="text-muted-foreground text-xs">{t("Auto-generated from primary → fallback")}</p>
					</div>
					<div className="flex items-end gap-2 pb-2">
						<Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} id="cb-enabled" />
						<Label htmlFor="cb-enabled">{t("Enabled")}</Label>
					</div>
					<div className="space-y-2">
						<Label>{t("Primary provider")}</Label>
						<ComboboxSelect
							options={providerOptions}
							value={form.primary_provider || null}
							onValueChange={(v) => {
								const prov = v ?? "";
								setForm((prev) => ({
									...prev,
									primary_provider: prov,
									// keep fallback provider in sync if empty or same as old primary
									fallback_provider:
										!prev.fallback_provider || prev.fallback_provider === prev.primary_provider ? prov : prev.fallback_provider,
									primary_model: "",
								}));
							}}
							placeholder={t("Select provider")}
							emptyMessage={t("No providers found")}
							data-testid="cb-primary-provider"
						/>
					</div>
					<div className="space-y-2">
						<Label>{t("Primary model")}</Label>
						<ModelMultiselect
							isSingleSelect
							provider={form.primary_provider || undefined}
							value={form.primary_model}
							onChange={(model) => setForm((prev) => ({ ...prev, primary_model: model }))}
							placeholder={t("Search models...")}
							disabled={!form.primary_provider}
							clearable
							data-testid="cb-primary-model"
						/>
					</div>
					<div className="space-y-2">
						<Label>{t("Fallback provider")}</Label>
						<ComboboxSelect
							options={providerOptions}
							value={form.fallback_provider || null}
							onValueChange={(v) => {
								const prov = v ?? "";
								setForm((prev) => ({
									...prev,
									fallback_provider: prov,
									fallback_model: prev.fallback_provider === prov ? prev.fallback_model : "",
								}));
							}}
							placeholder={t("Select provider")}
							emptyMessage={t("No providers found")}
							data-testid="cb-fallback-provider"
						/>
					</div>
					<div className="space-y-2">
						<Label>{t("Fallback model")}</Label>
						<ModelMultiselect
							isSingleSelect
							provider={form.fallback_provider || form.primary_provider || undefined}
							value={form.fallback_model}
							onChange={(model) => setForm((prev) => ({ ...prev, fallback_model: model }))}
							placeholder={t("Search models...")}
							disabled={!(form.fallback_provider || form.primary_provider)}
							clearable
							data-testid="cb-fallback-model"
						/>
					</div>
					<div className="space-y-2">
						<Label>{t("Cooldown")}</Label>
						<Input value={form.default_cooldown} onChange={(e) => setForm({ ...form, default_cooldown: e.target.value })} placeholder="30s" />
					</div>
					<div className="space-y-2">
						<Label>{t("Failure threshold")}</Label>
						<Input
							type="number"
							value={form.failure_threshold}
							onChange={(e) => setForm({ ...form, failure_threshold: Number(e.target.value) })}
						/>
					</div>
					<div className="space-y-2">
						<Label>{t("Failure window")}</Label>
						<Input value={form.failure_window} onChange={(e) => setForm({ ...form, failure_window: e.target.value })} placeholder="60s" />
					</div>
					<div className="flex items-end">
						<Button onClick={onCreate} disabled={creating || !canCreate} data-testid="circuit-breaker-create">
							{creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
							{t("Create")}
						</Button>
					</div>
					{error && <p className="text-destructive col-span-full text-sm">{error}</p>}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">{t("Policies")}</CardTitle>
					<CardDescription>
						{loadingPolicies || loadingState ? t("Loading…") : `${policies.length} ${t("policy(ies)")}`}
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					{policies.length === 0 && !loadingPolicies && (
						<p className="text-muted-foreground text-sm">
							{t("No policies yet. Create one above or set circuit_breaker_config in config.json.")}
						</p>
					)}
					{policies.map((p) => {
						const st = stateByName.get(p.name);
						const badge = st?.state ?? "closed";
						return (
							<div
								key={p.name}
								className="flex flex-col gap-2 rounded-md border p-4 sm:flex-row sm:items-center sm:justify-between"
								data-testid={`circuit-breaker-policy-${p.name}`}
							>
								<div className="min-w-0 space-y-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-medium">{p.name}</span>
										<span
											className={`rounded px-2 py-0.5 text-xs font-medium ${
												badge === "open"
													? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"
													: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
											}`}
										>
											{stateLabel(badge)}
										</span>
										{!p.enabled && <span className="text-muted-foreground text-xs">{t("disabled")}</span>}
									</div>
									<p className="text-muted-foreground truncate text-sm">
										{p.primary_provider}/{p.primary_model} → {p.fallback_provider}/{p.fallback_model}
									</p>
									{st && (
										<p className="text-muted-foreground text-xs">
											{t("failures")}={st.failure_count}
											{st.last_reason ? ` · ${st.last_reason}` : ""}
											{st.open_until ? ` · ${t("open until")} ${st.open_until}` : ""}
										</p>
									)}
								</div>
								<div className="flex shrink-0 gap-2">
									<Button
										variant="outline"
										size="sm"
										onClick={async () => {
											await resetPolicy(p.name);
											refetchState();
										}}
									>
										{t("Reset")}
									</Button>
									<Button
										variant="destructive"
										size="sm"
										onClick={async () => {
											await deletePolicy(p.name);
											refetchPolicies();
											refetchState();
										}}
									>
										<Trash2 className="h-4 w-4" />
									</Button>
								</div>
							</div>
						);
					})}
				</CardContent>
			</Card>
		</div>
	);
}
