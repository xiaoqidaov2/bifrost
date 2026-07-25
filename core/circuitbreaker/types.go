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

// State is the circuit state for one policy.
type State string

const (
	StateClosed State = "closed"
	StateOpen   State = "open"
)

// Policy is one circuit-breaker policy.
// Phase 1 trips on primary attempt errors (timeout/5xx/connection).
// Header-based Condition is stored for forward compatibility with the
// enterprise-shaped schema but is not required for Phase 1 error trips.
type Policy struct {
	Name             string        `json:"name"`
	Enabled          bool          `json:"enabled"`
	PrimaryProvider  string        `json:"primary_provider"`
	PrimaryModel     string        `json:"primary_model"`
	FallbackProvider string        `json:"fallback_provider"`
	FallbackModel    string        `json:"fallback_model"`
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
	Name            string     `json:"name"`
	Enabled         bool       `json:"enabled"`
	State           State      `json:"state"`
	PrimaryProvider string     `json:"primary_provider"`
	PrimaryModel    string     `json:"primary_model"`
	FallbackProvider string    `json:"fallback_provider"`
	FallbackModel   string     `json:"fallback_model"`
	FailureCount    int        `json:"failure_count"`
	OpenUntil       *time.Time `json:"open_until,omitempty"`
	LastReason      string     `json:"last_reason,omitempty"`
	LastChangedAt   *time.Time `json:"last_changed_at,omitempty"`
}

// FileConfig is the config.json / wire shape for circuit_breaker_config.
type FileConfig struct {
	Policies []FilePolicy `json:"policies"`
}

// FilePolicy is the JSON form of a policy (durations as Go duration strings).
type FilePolicy struct {
	Name             string     `json:"name"`
	Enabled          *bool      `json:"enabled,omitempty"`
	PrimaryProvider  string     `json:"primary_provider"`
	PrimaryModel     string     `json:"primary_model"`
	FallbackProvider string     `json:"fallback_provider"`
	FallbackModel    string     `json:"fallback_model"`
	DefaultCooldown  string     `json:"default_cooldown,omitempty"`
	CooldownHeader   string     `json:"cooldown_header,omitempty"`
	FailureThreshold int        `json:"failure_threshold,omitempty"`
	FailureWindow    string     `json:"failure_window,omitempty"`
	Condition        *Condition `json:"condition,omitempty"`
}

// Context keys used to mark CB-applied rewrites so Observe does not treat
// fallback success as healing the primary while sticky-open.
const (
	ContextKeyRerouted     schemas.BifrostContextKey = "bifrost-circuit-breaker-rerouted"
	ContextKeyPolicyName   schemas.BifrostContextKey = "bifrost-circuit-breaker-policy"
	ContextKeyOriginalProv schemas.BifrostContextKey = "bifrost-circuit-breaker-original-provider"
	ContextKeyOriginalModel schemas.BifrostContextKey = "bifrost-circuit-breaker-original-model"
)

// runtimeState is per-policy mutable state.
type runtimeState struct {
	state         State
	openUntil     time.Time
	failureTimes  []time.Time
	lastReason    string
	lastChangedAt time.Time
}
