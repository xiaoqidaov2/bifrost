package circuitbreaker

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/maximhq/bifrost/core/schemas"
)

const (
	defaultCooldown         = 30 * time.Second
	defaultFailureThreshold = 5
	defaultFailureWindow    = 60 * time.Second
)

// Engine is the first-class sticky circuit-breaker router.
type Engine struct {
	mu       sync.RWMutex
	policies map[string]Policy
	runtime  map[string]*runtimeState
	logger   schemas.Logger
	now      func() time.Time
}

// NewEngine creates an empty engine. Policies are loaded via SetPolicies/UpsertPolicy.
func NewEngine(logger schemas.Logger) *Engine {
	return &Engine{
		policies: make(map[string]Policy),
		runtime:  make(map[string]*runtimeState),
		logger:   logger,
		now:      time.Now,
	}
}

// SetPolicies replaces all policies. Invalid policies are rejected as a group.
func (e *Engine) SetPolicies(policies []Policy) error {
	normalized := make([]Policy, 0, len(policies))
	seen := make(map[string]struct{}, len(policies))
	for _, p := range policies {
		np, err := normalizePolicy(p)
		if err != nil {
			return err
		}
		if _, ok := seen[np.Name]; ok {
			return fmt.Errorf("duplicate circuit breaker policy name %q", np.Name)
		}
		seen[np.Name] = struct{}{}
		normalized = append(normalized, np)
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	e.policies = make(map[string]Policy, len(normalized))
	newRuntime := make(map[string]*runtimeState, len(normalized))
	for _, p := range normalized {
		e.policies[p.Name] = p
		if old, ok := e.runtime[p.Name]; ok {
			newRuntime[p.Name] = old
		} else {
			newRuntime[p.Name] = &runtimeState{state: StateClosed}
		}
	}
	e.runtime = newRuntime
	return nil
}

// ListPolicies returns a copy of configured policies.
func (e *Engine) ListPolicies() []Policy {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := make([]Policy, 0, len(e.policies))
	for _, p := range e.policies {
		out = append(out, p)
	}
	return out
}

// GetPolicy returns a policy by name.
func (e *Engine) GetPolicy(name string) (Policy, bool) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	p, ok := e.policies[name]
	return p, ok
}

// UpsertPolicy creates or replaces one policy.
func (e *Engine) UpsertPolicy(p Policy) error {
	np, err := normalizePolicy(p)
	if err != nil {
		return err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.policies[np.Name] = np
	if _, ok := e.runtime[np.Name]; !ok {
		e.runtime[np.Name] = &runtimeState{state: StateClosed}
	}
	return nil
}

// DeletePolicy removes a policy and its runtime state.
func (e *Engine) DeletePolicy(name string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.policies[name]; !ok {
		return fmt.Errorf("circuit breaker policy %q not found", name)
	}
	delete(e.policies, name)
	delete(e.runtime, name)
	return nil
}

// Reset clears open/failure state for a policy.
func (e *Engine) Reset(name string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.policies[name]; !ok {
		return fmt.Errorf("circuit breaker policy %q not found", name)
	}
	e.runtime[name] = &runtimeState{
		state:         StateClosed,
		lastChangedAt: e.now(),
		lastReason:    "manual_reset",
	}
	return nil
}

// SnapshotState returns runtime views for all policies.
func (e *Engine) SnapshotState() []PolicyStateView {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.now()
	out := make([]PolicyStateView, 0, len(e.policies))
	for name, p := range e.policies {
		rt := e.runtime[name]
		if rt == nil {
			rt = &runtimeState{state: StateClosed}
			e.runtime[name] = rt
		}
		e.lazyCloseLocked(rt, now)
		view := PolicyStateView{
			Name:             name,
			Enabled:          p.Enabled,
			State:            rt.state,
			PrimaryProvider:  p.PrimaryProvider,
			PrimaryModel:     p.PrimaryModel,
			FallbackProvider: p.FallbackProvider,
			FallbackModel:    p.FallbackModel,
			FailureCount:     countInWindow(rt.failureTimes, now, p.FailureWindow),
			LastReason:       rt.lastReason,
		}
		if rt.state == StateOpen && !rt.openUntil.IsZero() {
			t := rt.openUntil.UTC()
			view.OpenUntil = &t
		}
		if !rt.lastChangedAt.IsZero() {
			t := rt.lastChangedAt.UTC()
			view.LastChangedAt = &t
		}
		out = append(out, view)
	}
	return out
}

// ApplyIfOpen rewrites req to the policy fallback when the matching circuit is open.
// Call AFTER PreRequestHooks so governance already selected the primary.
func (e *Engine) ApplyIfOpen(ctx *schemas.BifrostContext, req *schemas.BifrostRequest) {
	if e == nil || req == nil {
		return
	}
	provider, model, _ := req.GetRequestFields()
	if provider == "" || model == "" {
		return
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.now()
	for name, p := range e.policies {
		if !p.Enabled {
			continue
		}
		if !providerModelMatch(p.PrimaryProvider, p.PrimaryModel, string(provider), model) {
			continue
		}
		rt := e.runtime[name]
		if rt == nil {
			rt = &runtimeState{state: StateClosed}
			e.runtime[name] = rt
		}
		e.lazyCloseLocked(rt, now)
		if rt.state != StateOpen {
			continue
		}

		// Sticky open: do not contact primary; rewrite to fallback.
		origProvider := provider
		origModel := model
		req.SetProvider(schemas.ModelProvider(p.FallbackProvider))
		req.SetModel(p.FallbackModel)
		if ctx != nil {
			ctx.SetValue(ContextKeyRerouted, true)
			ctx.SetValue(ContextKeyPolicyName, name)
			ctx.SetValue(ContextKeyOriginalProv, string(origProvider))
			ctx.SetValue(ContextKeyOriginalModel, origModel)
			schemas.AppendToContextList(ctx, schemas.BifrostContextKeyRoutingEnginesUsed, schemas.RoutingEngineCircuitBreaker)
			ctx.AppendRoutingEngineLog(schemas.RoutingEngineCircuitBreaker, schemas.LogLevelInfo,
				fmt.Sprintf("Circuit open for policy %q; rerouting %s/%s -> %s/%s (open until %s, reason=%s)",
					name, origProvider, origModel, p.FallbackProvider, p.FallbackModel, rt.openUntil.UTC().Format(time.RFC3339), rt.lastReason))
		}
		if e.logger != nil {
			e.logger.Info("[circuit-breaker] policy=%s open; %s/%s -> %s/%s",
				name, origProvider, origModel, p.FallbackProvider, p.FallbackModel)
		}
		return // one policy wins
	}
}

// ObserveAttempt records the outcome of a primary attempt (fallbackIndex == 0).
// CB-rerouted requests do not heal or trip the primary circuit from fallback traffic.
func (e *Engine) ObserveAttempt(ctx *schemas.BifrostContext, req *schemas.BifrostRequest, _ *schemas.BifrostResponse, bifrostErr *schemas.BifrostError) {
	if e == nil || req == nil {
		return
	}
	// Skip sticky-open fallback traffic — success there must not close primary.
	if ctx != nil {
		if rerouted, _ := ctx.Value(ContextKeyRerouted).(bool); rerouted {
			return
		}
		// Only count the primary attempt (index 0). Core sets this before tryRequest.
		if idx, ok := ctx.Value(schemas.BifrostContextKeyFallbackIndex).(int); ok && idx != 0 {
			return
		}
	}

	provider, model, _ := req.GetRequestFields()
	if provider == "" || model == "" {
		return
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.now()

	for name, p := range e.policies {
		if !p.Enabled {
			continue
		}
		if !providerModelMatch(p.PrimaryProvider, p.PrimaryModel, string(provider), model) {
			continue
		}
		rt := e.runtime[name]
		if rt == nil {
			rt = &runtimeState{state: StateClosed}
			e.runtime[name] = rt
		}
		e.lazyCloseLocked(rt, now)

		if bifrostErr == nil {
			// Success on primary: clear failure window.
			rt.failureTimes = nil
			if rt.state != StateClosed {
				rt.state = StateClosed
				rt.openUntil = time.Time{}
				rt.lastReason = "primary_success"
				rt.lastChangedAt = now
			}
			return
		}

		if !isTripWorthy(bifrostErr) {
			return
		}

		// Record failure and maybe open.
		rt.failureTimes = append(rt.failureTimes, now)
		rt.failureTimes = filterWindow(rt.failureTimes, now, p.FailureWindow)
		count := len(rt.failureTimes)
		reason := tripReason(bifrostErr)
		if count >= p.FailureThreshold && rt.state != StateOpen {
			rt.state = StateOpen
			rt.openUntil = now.Add(p.DefaultCooldown)
			rt.lastReason = reason
			rt.lastChangedAt = now
			if e.logger != nil {
				e.logger.Warn("[circuit-breaker] policy=%s OPEN after %d failures in %s; cooldown=%s reason=%s",
					name, count, p.FailureWindow, p.DefaultCooldown, reason)
			}
			if ctx != nil {
				ctx.AppendRoutingEngineLog(schemas.RoutingEngineCircuitBreaker, schemas.LogLevelWarn,
					fmt.Sprintf("Policy %q opened: %d failures in %s; cooldown %s; reason=%s",
						name, count, p.FailureWindow, p.DefaultCooldown, reason))
			}
		}
		return
	}
}

func (e *Engine) lazyCloseLocked(rt *runtimeState, now time.Time) {
	if rt.state == StateOpen && !rt.openUntil.IsZero() && !now.Before(rt.openUntil) {
		rt.state = StateClosed
		rt.openUntil = time.Time{}
		rt.failureTimes = nil
		rt.lastReason = "cooldown_expired"
		rt.lastChangedAt = now
	}
}

func normalizePolicy(p Policy) (Policy, error) {
	p.Name = strings.TrimSpace(p.Name)
	p.PrimaryProvider = strings.TrimSpace(p.PrimaryProvider)
	p.PrimaryModel = strings.TrimSpace(p.PrimaryModel)
	p.FallbackProvider = strings.TrimSpace(p.FallbackProvider)
	p.FallbackModel = strings.TrimSpace(p.FallbackModel)
	if p.Name == "" {
		return p, fmt.Errorf("circuit breaker policy name is required")
	}
	if p.PrimaryProvider == "" || p.PrimaryModel == "" {
		return p, fmt.Errorf("policy %q: primary_provider and primary_model are required", p.Name)
	}
	if p.FallbackProvider == "" || p.FallbackModel == "" {
		return p, fmt.Errorf("policy %q: fallback_provider and fallback_model are required", p.Name)
	}
	if p.DefaultCooldown <= 0 {
		p.DefaultCooldown = defaultCooldown
	}
	if p.FailureThreshold <= 0 {
		p.FailureThreshold = defaultFailureThreshold
	}
	if p.FailureWindow <= 0 {
		p.FailureWindow = defaultFailureWindow
	}
	// Enabled defaults to true when loading from FilePolicy with nil; here bool zero is false.
	// Callers that want default-true should set Enabled explicitly (API/file loader does).
	return p, nil
}

// ParseFileConfig converts JSON file config into engine policies.
func ParseFileConfig(fc *FileConfig) ([]Policy, error) {
	if fc == nil {
		return nil, nil
	}
	out := make([]Policy, 0, len(fc.Policies))
	for _, fp := range fc.Policies {
		p := Policy{
			Name:             fp.Name,
			PrimaryProvider:  fp.PrimaryProvider,
			PrimaryModel:     fp.PrimaryModel,
			FallbackProvider: fp.FallbackProvider,
			FallbackModel:    fp.FallbackModel,
			CooldownHeader:   fp.CooldownHeader,
			FailureThreshold: fp.FailureThreshold,
			Condition:        fp.Condition,
			Enabled:          true,
		}
		if fp.Enabled != nil {
			p.Enabled = *fp.Enabled
		}
		if fp.DefaultCooldown != "" {
			d, err := time.ParseDuration(fp.DefaultCooldown)
			if err != nil {
				return nil, fmt.Errorf("policy %q: invalid default_cooldown %q: %w", fp.Name, fp.DefaultCooldown, err)
			}
			p.DefaultCooldown = d
		}
		if fp.FailureWindow != "" {
			d, err := time.ParseDuration(fp.FailureWindow)
			if err != nil {
				return nil, fmt.Errorf("policy %q: invalid failure_window %q: %w", fp.Name, fp.FailureWindow, err)
			}
			p.FailureWindow = d
		}
		np, err := normalizePolicy(p)
		if err != nil {
			return nil, err
		}
		out = append(out, np)
	}
	return out, nil
}

func providerModelMatch(wantProv, wantModel, gotProv, gotModel string) bool {
	return strings.EqualFold(wantProv, gotProv) && wantModel == gotModel
}

func filterWindow(times []time.Time, now time.Time, window time.Duration) []time.Time {
	if window <= 0 {
		return times
	}
	cut := now.Add(-window)
	i := 0
	for i < len(times) && times[i].Before(cut) {
		i++
	}
	if i == 0 {
		return times
	}
	return append([]time.Time(nil), times[i:]...)
}

func countInWindow(times []time.Time, now time.Time, window time.Duration) int {
	return len(filterWindow(times, now, window))
}

func isTripWorthy(err *schemas.BifrostError) bool {
	if err == nil {
		return false
	}
	if err.Error != nil && err.Error.Type != nil && *err.Error.Type == schemas.RequestCancelled {
		return false
	}
	if err.StatusCode != nil {
		code := *err.StatusCode
		if code >= 500 {
			return true
		}
		// Phase 1: do not trip on 4xx (including 429).
		if code >= 400 && code < 500 {
			return false
		}
	}
	// No status: treat as transport/provider failure (timeout, connection, etc.)
	if err.Error != nil {
		msg := strings.ToLower(err.Error.Message)
		if strings.Contains(msg, "timeout") ||
			strings.Contains(msg, "timed out") ||
			strings.Contains(msg, "connection") ||
			strings.Contains(msg, "unavailable") ||
			strings.Contains(msg, "EOF") ||
			strings.Contains(msg, "reset by peer") {
			return true
		}
		if err.Error.Type != nil {
			t := strings.ToLower(*err.Error.Type)
			if strings.Contains(t, "timeout") || strings.Contains(t, "unavailable") || strings.Contains(t, "network") {
				return true
			}
		}
	}
	// Default: unknown errors without 4xx status are trip-worthy (provider blew up).
	if err.StatusCode == nil {
		return true
	}
	return false
}

func tripReason(err *schemas.BifrostError) string {
	if err == nil {
		return "unknown"
	}
	if err.StatusCode != nil {
		return fmt.Sprintf("http_%d", *err.StatusCode)
	}
	if err.Error != nil {
		if err.Error.Type != nil && *err.Error.Type != "" {
			return *err.Error.Type
		}
		if err.Error.Message != "" {
			return truncate(err.Error.Message, 120)
		}
	}
	return "error"
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
