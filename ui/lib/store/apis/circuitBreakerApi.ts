import { baseApi } from "./baseApi";

export interface CircuitBreakerFallbackHop {
	provider: string;
	model: string;
	key_id?: string;
}

export interface CircuitBreakerPolicy {
	name: string;
	enabled?: boolean;
	primary_provider: string;
	primary_model?: string;
	primary_models?: string[];
	primary_key_ids?: string[];
	fallbacks?: CircuitBreakerFallbackHop[];
	/** @deprecated prefer fallbacks[] */
	fallback_provider?: string;
	/** @deprecated prefer fallbacks[] */
	fallback_model?: string;
	fallback_key_id?: string;
	default_cooldown?: string;
	cooldown_header?: string;
	failure_threshold?: number;
	failure_window?: string;
}

export interface CircuitBreakerKeyStateView {
	key_id: string;
	state: "closed" | "open" | string;
	failure_count: number;
	open_until?: string;
	last_reason?: string;
	last_changed_at?: string;
}

export interface CircuitBreakerStateView {
	name: string;
	enabled: boolean;
	state: "closed" | "open" | string;
	primary_provider: string;
	primary_model?: string;
	primary_models?: string[];
	primary_key_ids?: string[];
	fallbacks?: CircuitBreakerFallbackHop[];
	fallback_provider?: string;
	fallback_model?: string;
	failure_count: number;
	open_until?: string;
	last_reason?: string;
	last_changed_at?: string;
	key_states?: CircuitBreakerKeyStateView[];
}

export const circuitBreakerApi = baseApi.injectEndpoints({
	endpoints: (builder) => ({
		getCircuitBreakerPolicies: builder.query<{ policies: CircuitBreakerPolicy[] }, void>({
			query: () => ({ url: "/circuit-breaker/policies" }),
			providesTags: ["CircuitBreakerPolicies"],
		}),
		createCircuitBreakerPolicy: builder.mutation<CircuitBreakerPolicy, CircuitBreakerPolicy>({
			query: (body) => ({ url: "/circuit-breaker/policies", method: "POST", body }),
			invalidatesTags: ["CircuitBreakerPolicies", "CircuitBreakerState"],
		}),
		updateCircuitBreakerPolicy: builder.mutation<CircuitBreakerPolicy, { name: string; data: CircuitBreakerPolicy }>({
			query: ({ name, data }) => ({
				url: `/circuit-breaker/policies/${encodeURIComponent(name)}`,
				method: "PUT",
				body: data,
			}),
			invalidatesTags: ["CircuitBreakerPolicies", "CircuitBreakerState"],
		}),
		deleteCircuitBreakerPolicy: builder.mutation<{ status: string }, string>({
			query: (name) => ({
				url: `/circuit-breaker/policies/${encodeURIComponent(name)}`,
				method: "DELETE",
			}),
			invalidatesTags: ["CircuitBreakerPolicies", "CircuitBreakerState"],
		}),
		getCircuitBreakerState: builder.query<{ states: CircuitBreakerStateView[] }, void>({
			query: () => ({ url: "/circuit-breaker/state" }),
			providesTags: ["CircuitBreakerState"],
		}),
		resetCircuitBreakerPolicy: builder.mutation<{ status: string }, string>({
			query: (name) => ({
				url: `/circuit-breaker/policies/${encodeURIComponent(name)}/reset`,
				method: "POST",
			}),
			invalidatesTags: ["CircuitBreakerState"],
		}),
	}),
});

export const {
	useGetCircuitBreakerPoliciesQuery,
	useCreateCircuitBreakerPolicyMutation,
	useUpdateCircuitBreakerPolicyMutation,
	useDeleteCircuitBreakerPolicyMutation,
	useGetCircuitBreakerStateQuery,
	useResetCircuitBreakerPolicyMutation,
} = circuitBreakerApi;
