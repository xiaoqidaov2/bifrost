import { CircuitBoard, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
	useCreateCircuitBreakerPolicyMutation,
	useDeleteCircuitBreakerPolicyMutation,
	useGetCircuitBreakerPoliciesQuery,
	useGetCircuitBreakerStateQuery,
	useResetCircuitBreakerPolicyMutation,
	type CircuitBreakerPolicy,
} from "@/lib/store/apis/circuitBreakerApi";

const emptyForm = {
	name: "",
	enabled: true,
	primary_provider: "",
	primary_model: "",
	fallback_provider: "",
	fallback_model: "",
	default_cooldown: "30s",
	failure_threshold: 5,
	failure_window: "60s",
};

export default function CircuitBreakerView() {
	const { data: policiesData, isLoading: loadingPolicies, refetch: refetchPolicies } = useGetCircuitBreakerPoliciesQuery();
	const { data: stateData, isLoading: loadingState, refetch: refetchState } = useGetCircuitBreakerStateQuery(undefined, {
		pollingInterval: 5000,
	});
	const [createPolicy, { isLoading: creating }] = useCreateCircuitBreakerPolicyMutation();
	const [deletePolicy] = useDeleteCircuitBreakerPolicyMutation();
	const [resetPolicy] = useResetCircuitBreakerPolicyMutation();
	const [form, setForm] = useState(emptyForm);
	const [error, setError] = useState<string | null>(null);

	const stateByName = useMemo(() => {
		const m = new Map<string, { state: string; failure_count: number; last_reason?: string; open_until?: string }>();
		for (const s of stateData?.states ?? []) {
			m.set(s.name, s);
		}
		return m;
	}, [stateData]);

	const onCreate = async () => {
		setError(null);
		try {
			const body: CircuitBreakerPolicy = {
				name: form.name.trim(),
				enabled: form.enabled,
				primary_provider: form.primary_provider.trim(),
				primary_model: form.primary_model.trim(),
				fallback_provider: form.fallback_provider.trim(),
				fallback_model: form.fallback_model.trim(),
				default_cooldown: form.default_cooldown.trim() || "30s",
				failure_threshold: Number(form.failure_threshold) || 5,
				failure_window: form.failure_window.trim() || "60s",
			};
			await createPolicy(body).unwrap();
			setForm(emptyForm);
			refetchPolicies();
			refetchState();
		} catch (e: unknown) {
			const msg = e && typeof e === "object" && "data" in e ? JSON.stringify((e as { data: unknown }).data) : String(e);
			setError(msg);
		}
	};

	const policies = policiesData?.policies ?? [];

	return (
		<div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 p-6" data-testid="circuit-breaker-page">
			<div className="flex items-start justify-between gap-4">
				<div className="flex items-start gap-3">
					<CircuitBoard className="text-primary mt-1 h-8 w-8" strokeWidth={1.5} />
					<div>
						<h1 className="text-xl font-semibold">Circuit Breaker</h1>
						<p className="text-muted-foreground mt-1 max-w-2xl text-sm">
							When a primary provider/model keeps failing, Bifrost opens the circuit and routes traffic to your
							fallback for a cooldown window — first-class sticky failover (OSS).
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
					Refresh
				</Button>
			</div>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">Create policy</CardTitle>
					<CardDescription>Match primary provider+model; on trip, rewrite to fallback.</CardDescription>
				</CardHeader>
				<CardContent className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-2">
						<Label htmlFor="cb-name">Name</Label>
						<Input id="cb-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="openai-main-to-mini" />
					</div>
					<div className="flex items-end gap-2 pb-2">
						<Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} id="cb-enabled" />
						<Label htmlFor="cb-enabled">Enabled</Label>
					</div>
					<div className="space-y-2">
						<Label>Primary provider</Label>
						<Input value={form.primary_provider} onChange={(e) => setForm({ ...form, primary_provider: e.target.value })} placeholder="openai" />
					</div>
					<div className="space-y-2">
						<Label>Primary model</Label>
						<Input value={form.primary_model} onChange={(e) => setForm({ ...form, primary_model: e.target.value })} placeholder="gpt-4o" />
					</div>
					<div className="space-y-2">
						<Label>Fallback provider</Label>
						<Input value={form.fallback_provider} onChange={(e) => setForm({ ...form, fallback_provider: e.target.value })} placeholder="openai" />
					</div>
					<div className="space-y-2">
						<Label>Fallback model</Label>
						<Input value={form.fallback_model} onChange={(e) => setForm({ ...form, fallback_model: e.target.value })} placeholder="gpt-4o-mini" />
					</div>
					<div className="space-y-2">
						<Label>Cooldown</Label>
						<Input value={form.default_cooldown} onChange={(e) => setForm({ ...form, default_cooldown: e.target.value })} placeholder="30s" />
					</div>
					<div className="space-y-2">
						<Label>Failure threshold</Label>
						<Input
							type="number"
							value={form.failure_threshold}
							onChange={(e) => setForm({ ...form, failure_threshold: Number(e.target.value) })}
						/>
					</div>
					<div className="space-y-2">
						<Label>Failure window</Label>
						<Input value={form.failure_window} onChange={(e) => setForm({ ...form, failure_window: e.target.value })} placeholder="60s" />
					</div>
					<div className="flex items-end">
						<Button onClick={onCreate} disabled={creating || !form.name || !form.primary_provider || !form.primary_model} data-testid="circuit-breaker-create">
							{creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
							Create
						</Button>
					</div>
					{error && <p className="text-destructive col-span-full text-sm">{error}</p>}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">Policies</CardTitle>
					<CardDescription>
						{loadingPolicies || loadingState ? "Loading…" : `${policies.length} policy(ies)`}
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					{policies.length === 0 && !loadingPolicies && (
						<p className="text-muted-foreground text-sm">No policies yet. Create one above or set circuit_breaker_config in config.json.</p>
					)}
					{policies.map((p) => {
						const st = stateByName.get(p.name);
						const badge = st?.state ?? "closed";
						return (
							<div key={p.name} className="flex flex-col gap-2 rounded-md border p-4 sm:flex-row sm:items-center sm:justify-between" data-testid={`circuit-breaker-policy-${p.name}`}>
								<div className="min-w-0 space-y-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-medium">{p.name}</span>
										<span
											className={`rounded px-2 py-0.5 text-xs font-medium ${
												badge === "open" ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200" : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
											}`}
										>
											{badge}
										</span>
										{!p.enabled && <span className="text-muted-foreground text-xs">disabled</span>}
									</div>
									<p className="text-muted-foreground truncate text-sm">
										{p.primary_provider}/{p.primary_model} → {p.fallback_provider}/{p.fallback_model}
									</p>
									{st && (
										<p className="text-muted-foreground text-xs">
											failures={st.failure_count}
											{st.last_reason ? ` · ${st.last_reason}` : ""}
											{st.open_until ? ` · open until ${st.open_until}` : ""}
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
										Reset
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
