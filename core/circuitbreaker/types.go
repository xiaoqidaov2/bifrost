// Package circuitbreaker implements first-class sticky failover for Bifrost.
//
// This is an OSS built-in routing capability aligned with circuit_breaker_config
// (see transports/config.schema.json). It is not a third-party bolt-on: the
// engine is owned by core and applied on the primary request path after
// PreRequestHooks (so governance/routing already chose a primary).
package circuitbreaker

import (
	"time"

	"github.com/maximhq/bifrost/core/schemas"
)

// State is the circuit state for one policy (or one key sub-circuit).
type State string

const (
	StateClosed State = "closed"
	StateOpen   State = "open"
)

// FallbackHop is one hop in a multi-level fallback chain.
// KeyID is optional; when set, Bifrost pins that provider API key.
// Model is legacy single-model; Models allows multiple models at the same level
// (expanded in order when building the runtime chain).
type FallbackHop struct {
	Provider string   `json:"provider"`
	Model    string   `json:"model,omitempty"`
	Models   []string `json:"models,omitempty"`
	KeyID    string   `json:"key_id,omitempty"`
}

// Policy is one circuit-breaker policy.
// Phase 1 trips on primary attempt errors (timeout/5xx/connection).
type Policy struct {
	Name            string `json:"name"`
	Enabled         bool   `json:"enabled"`
	PrimaryProvider string `json:"primary_provider"`
	// PrimaryModel is the legacy single primary model (mirrored as PrimaryModels[0]).
	PrimaryModel string `json:"primary_model,omitempty"`
	// PrimaryModels lists all primary models this policy monitors (same provider + key/fallback chain).
	// Prefer this over repeating one policy per model.
	PrimaryModels []string `json:"primary_models,omitempty"`
	// PrimaryKeyIDs optionally scopes the policy to specific provider API keys.
	// Empty = one shared circuit for all keys serving primary_provider+primary_model.
	// Non-empty = per-key sub-circuits; sticky fallback chain applies only when
	// every listed key is open (or the selected key is open and no healthy peer remains).
	PrimaryKeyIDs []string `json:"primary_key_ids,omitempty"`
	// Fallbacks is the ordered multi-level backup chain (hop 0 first).
	// When empty, FallbackProvider/FallbackModel form a single hop (legacy).
	Fallbacks []FallbackHop `json:"fallbacks,omitempty"`
	// Legacy single-hop fields kept for backward compatibility with early OSS UI/API.
	FallbackProvider string        `json:"fallback_provider,omitempty"`
	FallbackModel    string        `json:"fallback_model,omitempty"`
	FallbackKeyID    string        `json:"fallback_key_id,omitempty"`
	DefaultCooldown  time.Duration `json:"default_cooldown"`
	CooldownHeader   string        `json:"cooldown_header,omitempty"`
	// FailureThreshold is how many trip-worthy primary failures within
	// FailureWindow open the circuit. Defaults to 5.
	FailureThreshold int `json:"failure_threshold,omitempty"`
	// FailureWindow is the sliding window for failure counting. Defaults to 60s.
	FailureWindow time.Duration `json:"failure_window,omitempty"`
	Condition     *Condition    `json:"condition,omitempty"`
}

// Condition is the enterprise-shaped signal group (OR/AND over signals).
type Condition struct {
	Operator string   `json:"operator,omitempty"`
	Signals  []Signal `json:"signals,omitempty"`
}

// Signal is one trip signal. Phase 1 primarily uses error counting on the policy;
// response_header signals are reserved for Phase 2.
type Signal struct {
	Source         string `json:"source"`
	HeaderName     string `json:"header_name,omitempty"`
	HeaderValue    string `json:"header_value,omitempty"`
	HeaderContains string `json:"header_contains,omitempty"`
}

// PolicyStateView is the API-facing snapshot of one policy's runtime state.
type PolicyStateView struct {
	Name             string            `json:"name"`
	Enabled          bool              `json:"enabled"`
	State            State             `json:"state"`
	PrimaryProvider  string            `json:"primary_provider"`
	PrimaryModel     string            `json:"primary_model,omitempty"`
	PrimaryModels    []string          `json:"primary_models,omitempty"`
	PrimaryKeyIDs    []string          `json:"primary_key_ids,omitempty"`
	Fallbacks        []FallbackHop     `json:"fallbacks,omitempty"`
	FallbackProvider string            `json:"fallback_provider,omitempty"`
	FallbackModel    string            `json:"fallback_model,omitempty"`
	FailureCount     int               `json:"failure_count"`
	OpenUntil        *time.Time        `json:"open_until,omitempty"`
	LastReason       string            `json:"last_reason,omitempty"`
	LastChangedAt    *time.Time        `json:"last_changed_at,omitempty"`
	// KeyStates is populated when primary_key_ids is set (per-key sub-circuits).
	KeyStates []KeyStateView `json:"key_states,omitempty"`
}

// KeyStateView is the runtime state of one primary key sub-circuit.
type KeyStateView struct {
	KeyID         string     `json:"key_id"`
	State         State      `json:"state"`
	FailureCount  int        `json:"failure_count"`
	OpenUntil     *time.Time `json:"open_until,omitempty"`
	LastReason    string     `json:"last_reason,omitempty"`
	LastChangedAt *time.Time `json:"last_changed_at,omitempty"`
}

// FileConfig is the config.json / wire shape for circuit_breaker_config.
type FileConfig struct {
	Policies []FilePolicy `json:"policies"`
}

// FilePolicy is the JSON form of a policy (durations as Go duration strings).
type FilePolicy struct {
	Name             string        `json:"name"`
	Enabled          *bool         `json:"enabled,omitempty"`
	PrimaryProvider  string        `json:"primary_provider"`
	PrimaryModel     string        `json:"primary_model,omitempty"`
	PrimaryModels    []string      `json:"primary_models,omitempty"`
	PrimaryKeyIDs    []string      `json:"primary_key_ids,omitempty"`
	Fallbacks        []FallbackHop `json:"fallbacks,omitempty"`
	FallbackProvider string        `json:"fallback_provider,omitempty"`
	FallbackModel    string        `json:"fallback_model,omitempty"`
	FallbackKeyID    string        `json:"fallback_key_id,omitempty"`
	DefaultCooldown  string        `json:"default_cooldown,omitempty"`
	CooldownHeader   string        `json:"cooldown_header,omitempty"`
	FailureThreshold int           `json:"failure_threshold,omitempty"`
	FailureWindow    string        `json:"failure_window,omitempty"`
	Condition        *Condition    `json:"condition,omitempty"`
}

// Context keys used to mark CB-applied rewrites so Observe does not treat
// fallback success as healing the primary while sticky-open.
const (
	ContextKeyRerouted      schemas.BifrostContextKey = "bifrost-circuit-breaker-rerouted"
	ContextKeyPolicyName    schemas.BifrostContextKey = "bifrost-circuit-breaker-policy"
	ContextKeyOriginalProv  schemas.BifrostContextKey = "bifrost-circuit-breaker-original-provider"
	ContextKeyOriginalModel schemas.BifrostContextKey = "bifrost-circuit-breaker-original-model"
	ContextKeyOriginalKeyID schemas.BifrostContextKey = "bifrost-circuit-breaker-original-key-id"
)

// runtimeState is per-policy (shared) or per-key mutable state.
type runtimeState struct {
	state         State
	openUntil     time.Time
	failureTimes  []time.Time
	lastReason    string
	lastChangedAt time.Time
}

// policyRuntime holds shared + optional per-key sub-circuits.
type policyRuntime struct {
	// shared is used when PrimaryKeyIDs is empty.
	shared *runtimeState
	// byKey is used when PrimaryKeyIDs is non-empty (key id -> state).
	byKey map[string]*runtimeState
}
