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
	runtime  map[string]*policyRuntime
	logger   schemas.Logger
	now      func() time.Time
}

// NewEngine creates an empty engine. Policies are loaded via SetPolicies/UpsertPolicy.
func NewEngine(logger schemas.Logger) *Engine {
	return &Engine{
		policies: make(map[string]Policy),
		runtime:  make(map[string]*policyRuntime),
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
	newRuntime := make(map[string]*policyRuntime, len(normalized))
	for _, p := range normalized {
		e.policies[p.Name] = p
		if old, ok := e.runtime[p.Name]; ok {
			newRuntime[p.Name] = migrateRuntime(old, p)
		} else {
			newRuntime[p.Name] = newPolicyRuntime(p)
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
	if old, ok := e.runtime[np.Name]; ok {
		e.runtime[np.Name] = migrateRuntime(old, np)
	} else {
		e.runtime[np.Name] = newPolicyRuntime(np)
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

// Reset clears open/failure state for a policy (all key sub-circuits).
func (e *Engine) Reset(name string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	p, ok := e.policies[name]
	if !ok {
		return fmt.Errorf("circuit breaker policy %q not found", name)
	}
	e.runtime[name] = newPolicyRuntime(p)
	rt := e.runtime[name]
	now := e.now()
	if rt.shared != nil {
		rt.shared.lastChangedAt = now
		rt.shared.lastReason = "manual_reset"
	}
	for _, ks := range rt.byKey {
		ks.lastChangedAt = now
		ks.lastReason = "manual_reset"
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
		pr := e.ensureRuntimeLocked(name, p)
		hops := effectiveFallbacks(p)
		view := PolicyStateView{
			Name:             name,
			Enabled:          p.Enabled,
			PrimaryProvider:  p.PrimaryProvider,
			PrimaryModel:     p.PrimaryModel,
			PrimaryModels:    append([]string(nil), p.PrimaryModels...),
			PrimaryKeyIDs:    append([]string(nil), p.PrimaryKeyIDs...),
			Fallbacks:        hops,
			FallbackProvider: firstHopProvider(hops, p),
			FallbackModel:    firstHopModel(hops, p),
		}
		if len(p.PrimaryKeyIDs) == 0 {
			rt := pr.shared
			e.lazyCloseLocked(rt, now)
			view.State = rt.state
			view.FailureCount = countInWindow(rt.failureTimes, now, p.FailureWindow)
			view.LastReason = rt.lastReason
			if rt.state == StateOpen && !rt.openUntil.IsZero() {
				t := rt.openUntil.UTC()
				view.OpenUntil = &t
			}
			if !rt.lastChangedAt.IsZero() {
				t := rt.lastChangedAt.UTC()
				view.LastChangedAt = &t
			}
		} else {
			// Aggregate: open only when ALL listed keys are open.
			allOpen := true
			maxFail := 0
			var latestReason string
			var latestChange time.Time
			var latestUntil time.Time
			view.KeyStates = make([]KeyStateView, 0, len(p.PrimaryKeyIDs))
			for _, kid := range p.PrimaryKeyIDs {
				rt := pr.keyState(kid)
				e.lazyCloseLocked(rt, now)
				ks := KeyStateView{
					KeyID:        kid,
					State:        rt.state,
					FailureCount: countInWindow(rt.failureTimes, now, p.FailureWindow),
					LastReason:   rt.lastReason,
				}
				if rt.state == StateOpen && !rt.openUntil.IsZero() {
					t := rt.openUntil.UTC()
					ks.OpenUntil = &t
					if t.After(latestUntil) {
						latestUntil = t
					}
				} else {
					allOpen = false
				}
				if ks.FailureCount > maxFail {
					maxFail = ks.FailureCount
				}
				if rt.lastChangedAt.After(latestChange) {
					latestChange = rt.lastChangedAt
					latestReason = rt.lastReason
				}
				if !rt.lastChangedAt.IsZero() {
					t := rt.lastChangedAt.UTC()
					ks.LastChangedAt = &t
				}
				view.KeyStates = append(view.KeyStates, ks)
			}
			if allOpen && len(p.PrimaryKeyIDs) > 0 {
				view.State = StateOpen
				if !latestUntil.IsZero() {
					t := latestUntil
					view.OpenUntil = &t
				}
			} else {
				view.State = StateClosed
			}
			view.FailureCount = maxFail
			view.LastReason = latestReason
			if !latestChange.IsZero() {
				t := latestChange.UTC()
				view.LastChangedAt = &t
			}
		}
		out = append(out, view)
	}
	return out
}

// ApplyIfOpen rewrites req to the multi-level fallback chain when the matching circuit is open.
// Call AFTER PreRequestHooks so governance already selected the primary.
func (e *Engine) ApplyIfOpen(ctx *schemas.BifrostContext, req *schemas.BifrostRequest) {
	if e == nil || req == nil {
		return
	}
	provider, model, _ := req.GetRequestFields()
	if provider == "" || model == "" {
		return
	}
	selectedKey := selectedKeyID(ctx)

	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.now()
	for name, p := range e.policies {
		if !p.Enabled {
			continue
		}
		if !policyMatchesPrimary(p, string(provider), model) {
			continue
		}
		if !primaryKeyMatches(p, selectedKey) {
			continue
		}
		pr := e.ensureRuntimeLocked(name, p)
		if !e.isStickyOpenLocked(p, pr, selectedKey, now) {
			continue
		}

		hops := effectiveFallbacks(p)
		if len(hops) == 0 {
			continue
		}
		first := hops[0]
		rest := hops[1:]

		origProvider := provider
		origModel := model
		req.SetProvider(schemas.ModelProvider(first.Provider))
		req.SetModel(first.Model)
		// Remaining hops become request-level fallbacks (multi-level chain).
		fb := make([]schemas.Fallback, 0, len(rest))
		for _, h := range rest {
			fb = append(fb, schemas.Fallback{
				Provider: schemas.ModelProvider(h.Provider),
				Model:    h.Model,
			})
		}
		req.SetFallbacks(fb)

		if ctx != nil {
			ctx.SetValue(ContextKeyRerouted, true)
			ctx.SetValue(ContextKeyPolicyName, name)
			ctx.SetValue(ContextKeyOriginalProv, string(origProvider))
			ctx.SetValue(ContextKeyOriginalModel, origModel)
			ctx.SetValue(ContextKeyOriginalKeyID, selectedKey)
			// Pin first hop key if configured.
			if first.KeyID != "" {
				ctx.SetValue(schemas.BifrostContextKeyRoutingPinnedAPIKeyID, first.KeyID)
				ctx.SetValue(schemas.BifrostContextKeyAPIKeyID, first.KeyID)
			}
			schemas.AppendToContextList(ctx, schemas.BifrostContextKeyRoutingEnginesUsed, schemas.RoutingEngineCircuitBreaker)
			chainDesc := formatHopChain(hops)
			ctx.AppendRoutingEngineLog(schemas.RoutingEngineCircuitBreaker, schemas.LogLevelInfo,
				fmt.Sprintf("Circuit open for policy %q; rerouting %s/%s (key=%s) -> chain [%s]",
					name, origProvider, origModel, selectedKey, chainDesc))
		}
		if e.logger != nil {
			e.logger.Info("[circuit-breaker] policy=%s open; %s/%s key=%s -> %s",
				name, origProvider, origModel, selectedKey, formatHopChain(hops))
		}
		return
	}
}

// ObserveAttempt records the outcome of a primary attempt (fallbackIndex == 0).
// CB-rerouted requests do not heal or trip the primary circuit from fallback traffic.
func (e *Engine) ObserveAttempt(ctx *schemas.BifrostContext, req *schemas.BifrostRequest, _ *schemas.BifrostResponse, bifrostErr *schemas.BifrostError) {
	if e == nil || req == nil {
		return
	}
	if ctx != nil {
		if rerouted, _ := ctx.Value(ContextKeyRerouted).(bool); rerouted {
			return
		}
		if idx, ok := ctx.Value(schemas.BifrostContextKeyFallbackIndex).(int); ok && idx != 0 {
			return
		}
	}

	provider, model, _ := req.GetRequestFields()
	if provider == "" || model == "" {
		return
	}
	selectedKey := selectedKeyID(ctx)

	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.now()

	for name, p := range e.policies {
		if !p.Enabled {
			continue
		}
		if !policyMatchesPrimary(p, string(provider), model) {
			continue
		}
		if !primaryKeyMatches(p, selectedKey) {
			continue
		}
		pr := e.ensureRuntimeLocked(name, p)
		rt := e.runtimeForAttemptLocked(p, pr, selectedKey)
		if rt == nil {
			continue
		}
		e.lazyCloseLocked(rt, now)

		if bifrostErr == nil {
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
				e.logger.Warn("[circuit-breaker] policy=%s key=%s OPEN after %d failures in %s; cooldown=%s reason=%s",
					name, selectedKey, count, p.FailureWindow, p.DefaultCooldown, reason)
			}
			if ctx != nil {
				ctx.AppendRoutingEngineLog(schemas.RoutingEngineCircuitBreaker, schemas.LogLevelWarn,
					fmt.Sprintf("Policy %q key=%s opened: %d failures in %s; cooldown %s; reason=%s",
						name, selectedKey, count, p.FailureWindow, p.DefaultCooldown, reason))
			}
		}
		return
	}
}

func (e *Engine) ensureRuntimeLocked(name string, p Policy) *policyRuntime {
	pr := e.runtime[name]
	if pr == nil {
		pr = newPolicyRuntime(p)
		e.runtime[name] = pr
	}
	return pr
}

func (e *Engine) runtimeForAttemptLocked(p Policy, pr *policyRuntime, selectedKey string) *runtimeState {
	if len(p.PrimaryKeyIDs) == 0 {
		return pr.shared
	}
	if selectedKey == "" {
		// Key-scoped policy but no key selected yet — do not trip shared.
		return nil
	}
	return pr.keyState(selectedKey)
}

func (e *Engine) isStickyOpenLocked(p Policy, pr *policyRuntime, selectedKey string, now time.Time) bool {
	if len(p.PrimaryKeyIDs) == 0 {
		e.lazyCloseLocked(pr.shared, now)
		return pr.shared.state == StateOpen
	}
	// Per-key mode:
	// - If selected key is listed and open → sticky (unless another listed key is still closed — then pin that key instead of full chain).
	// Enterprise shape: main circuit opens only when ALL listed keys are exhausted.
	// For request path: if selected key open but a peer listed key is still closed, pin a healthy peer key (stay on primary model).
	// If ALL listed keys open → apply fallback chain.
	allOpen := true
	var healthyPeer string
	for _, kid := range p.PrimaryKeyIDs {
		rt := pr.keyState(kid)
		e.lazyCloseLocked(rt, now)
		if rt.state != StateOpen {
			allOpen = false
			if healthyPeer == "" {
				healthyPeer = kid
			}
		}
	}
	if allOpen {
		return true
	}
	// Selected key open, peers healthy: pin healthy peer, do not leave primary model.
	if selectedKey != "" && containsFold(p.PrimaryKeyIDs, selectedKey) {
		rt := pr.keyState(selectedKey)
		e.lazyCloseLocked(rt, now)
		if rt.state == StateOpen && healthyPeer != "" {
			// Not full sticky open — caller should pin healthy peer. Handled below via special path.
			// We encode this by returning false here and letting a separate helper run — simpler: handle in ApplyIfOpen.
			_ = healthyPeer
		}
	}
	return false
}

// ApplyIfOpen already uses isStickyOpenLocked for full open.
// Additionally pin healthy peer when selected key is open but peers remain.
func (e *Engine) ApplyPeerKeyPin(ctx *schemas.BifrostContext, req *schemas.BifrostRequest) {
	if e == nil || req == nil || ctx == nil {
		return
	}
	provider, model, _ := req.GetRequestFields()
	if provider == "" || model == "" {
		return
	}
	selectedKey := selectedKeyID(ctx)

	e.mu.Lock()
	defer e.mu.Unlock()
	now := e.now()
	for name, p := range e.policies {
		if !p.Enabled || len(p.PrimaryKeyIDs) == 0 {
			continue
		}
		if !policyMatchesPrimary(p, string(provider), model) {
			continue
		}
		if selectedKey == "" || !containsFold(p.PrimaryKeyIDs, selectedKey) {
			continue
		}
		pr := e.ensureRuntimeLocked(name, p)
		sel := pr.keyState(selectedKey)
		e.lazyCloseLocked(sel, now)
		if sel.state != StateOpen {
			continue
		}
		// Find healthy peer
		var peer string
		for _, kid := range p.PrimaryKeyIDs {
			if strings.EqualFold(kid, selectedKey) {
				continue
			}
			rt := pr.keyState(kid)
			e.lazyCloseLocked(rt, now)
			if rt.state != StateOpen {
				peer = kid
				break
			}
		}
		if peer == "" {
			continue // all open — ApplyIfOpen handles chain
		}
		ctx.SetValue(schemas.BifrostContextKeyRoutingPinnedAPIKeyID, peer)
		ctx.SetValue(schemas.BifrostContextKeyAPIKeyID, peer)
		schemas.AppendToContextList(ctx, schemas.BifrostContextKeyRoutingEnginesUsed, schemas.RoutingEngineCircuitBreaker)
		ctx.AppendRoutingEngineLog(schemas.RoutingEngineCircuitBreaker, schemas.LogLevelInfo,
			fmt.Sprintf("Policy %q: primary key %s open; pinning healthy peer key %s (same model)", name, selectedKey, peer))
		if e.logger != nil {
			e.logger.Info("[circuit-breaker] policy=%s pin peer key %s (selected %s open)", name, peer, selectedKey)
		}
		return
	}
}

func (e *Engine) lazyCloseLocked(rt *runtimeState, now time.Time) {
	if rt == nil {
		return
	}
	if rt.state == StateOpen && !rt.openUntil.IsZero() && !now.Before(rt.openUntil) {
		rt.state = StateClosed
		rt.openUntil = time.Time{}
		rt.failureTimes = nil
		rt.lastReason = "cooldown_expired"
		rt.lastChangedAt = now
	}
}

func newPolicyRuntime(p Policy) *policyRuntime {
	pr := &policyRuntime{}
	if len(p.PrimaryKeyIDs) == 0 {
		pr.shared = &runtimeState{state: StateClosed}
	} else {
		pr.byKey = make(map[string]*runtimeState, len(p.PrimaryKeyIDs))
		for _, kid := range p.PrimaryKeyIDs {
			pr.byKey[kid] = &runtimeState{state: StateClosed}
		}
	}
	return pr
}

func migrateRuntime(old *policyRuntime, p Policy) *policyRuntime {
	pr := newPolicyRuntime(p)
	if old == nil {
		return pr
	}
	if pr.shared != nil && old.shared != nil {
		pr.shared = old.shared
	}
	if pr.byKey != nil {
		for kid := range pr.byKey {
			if old.byKey != nil {
				if s, ok := old.byKey[kid]; ok {
					pr.byKey[kid] = s
				}
			}
		}
	}
	return pr
}

func (pr *policyRuntime) keyState(keyID string) *runtimeState {
	if pr.byKey == nil {
		pr.byKey = make(map[string]*runtimeState)
	}
	if s, ok := pr.byKey[keyID]; ok {
		return s
	}
	s := &runtimeState{state: StateClosed}
	pr.byKey[keyID] = s
	return s
}

func normalizePolicy(p Policy) (Policy, error) {
	p.Name = strings.TrimSpace(p.Name)
	p.PrimaryProvider = strings.TrimSpace(p.PrimaryProvider)
	p.PrimaryModel = strings.TrimSpace(p.PrimaryModel)
	p.FallbackProvider = strings.TrimSpace(p.FallbackProvider)
	p.FallbackModel = strings.TrimSpace(p.FallbackModel)
	p.FallbackKeyID = strings.TrimSpace(p.FallbackKeyID)
	if p.Name == "" {
		return p, fmt.Errorf("circuit breaker policy name is required")
	}
	if p.PrimaryProvider == "" {
		return p, fmt.Errorf("policy %q: primary_provider is required", p.Name)
	}
	// Merge primary_models + legacy primary_model
	models := make([]string, 0, len(p.PrimaryModels)+1)
	seenM := map[string]struct{}{}
	addModel := func(m string) {
		m = strings.TrimSpace(m)
		if m == "" {
			return
		}
		if _, ok := seenM[m]; ok {
			return
		}
		seenM[m] = struct{}{}
		models = append(models, m)
	}
	for _, m := range p.PrimaryModels {
		addModel(m)
	}
	addModel(p.PrimaryModel)
	if len(models) == 0 {
		return p, fmt.Errorf("policy %q: at least one primary model is required (primary_models or primary_model)", p.Name)
	}
	p.PrimaryModels = models
	p.PrimaryModel = models[0]
	// Normalize key ids
	if len(p.PrimaryKeyIDs) > 0 {
		clean := make([]string, 0, len(p.PrimaryKeyIDs))
		seen := map[string]struct{}{}
		for _, k := range p.PrimaryKeyIDs {
			k = strings.TrimSpace(k)
			if k == "" {
				continue
			}
			if _, ok := seen[k]; ok {
				continue
			}
			seen[k] = struct{}{}
			clean = append(clean, k)
		}
		p.PrimaryKeyIDs = clean
	}
	// Build fallbacks from legacy fields if needed.
	// Each hop may list multiple models; keep Models[] and mirror Model=first.
	// Runtime expansion to a flat chain happens in effectiveFallbacks.
	hops := make([]FallbackHop, 0, len(p.Fallbacks)+1)
	for _, h := range p.Fallbacks {
		h.Provider = strings.TrimSpace(h.Provider)
		h.KeyID = strings.TrimSpace(h.KeyID)
		if h.Provider == "" {
			continue
		}
		ms := make([]string, 0, len(h.Models)+1)
		seenHop := map[string]struct{}{}
		addHopModel := func(m string) {
			m = strings.TrimSpace(m)
			if m == "" {
				return
			}
			if _, ok := seenHop[m]; ok {
				return
			}
			seenHop[m] = struct{}{}
			ms = append(ms, m)
		}
		for _, m := range h.Models {
			addHopModel(m)
		}
		addHopModel(h.Model)
		if len(ms) == 0 {
			continue
		}
		h.Models = ms
		h.Model = ms[0]
		hops = append(hops, h)
	}
	if len(hops) == 0 && p.FallbackProvider != "" && p.FallbackModel != "" {
		hops = append(hops, FallbackHop{
			Provider: p.FallbackProvider,
			Model:    p.FallbackModel,
			Models:   []string{p.FallbackModel},
			KeyID:    p.FallbackKeyID,
		})
	}
	if len(hops) == 0 {
		return p, fmt.Errorf("policy %q: at least one fallback hop is required (fallbacks[] or fallback_provider/model)", p.Name)
	}
	p.Fallbacks = hops
	// Keep legacy mirrors of first hop for older UI clients.
	p.FallbackProvider = hops[0].Provider
	p.FallbackModel = hops[0].Model
	p.FallbackKeyID = hops[0].KeyID

	if p.DefaultCooldown <= 0 {
		p.DefaultCooldown = defaultCooldown
	}
	if p.FailureThreshold <= 0 {
		p.FailureThreshold = defaultFailureThreshold
	}
	if p.FailureWindow <= 0 {
		p.FailureWindow = defaultFailureWindow
	}
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
			PrimaryModels:    fp.PrimaryModels,
			PrimaryKeyIDs:    fp.PrimaryKeyIDs,
			Fallbacks:        fp.Fallbacks,
			FallbackProvider: fp.FallbackProvider,
			FallbackModel:    fp.FallbackModel,
			FallbackKeyID:    fp.FallbackKeyID,
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

// effectiveFallbacks returns a flat ordered chain for runtime rewrite.
// Multi-model hops expand as: hop.models[0], hop.models[1], ... then next hop.
func effectiveFallbacks(p Policy) []FallbackHop {
	src := p.Fallbacks
	if len(src) == 0 && p.FallbackProvider != "" && p.FallbackModel != "" {
		src = []FallbackHop{{Provider: p.FallbackProvider, Model: p.FallbackModel, Models: []string{p.FallbackModel}, KeyID: p.FallbackKeyID}}
	}
	out := make([]FallbackHop, 0, len(src)*2)
	for _, h := range src {
		models := h.Models
		if len(models) == 0 && h.Model != "" {
			models = []string{h.Model}
		}
		for _, m := range models {
			m = strings.TrimSpace(m)
			if m == "" {
				continue
			}
			out = append(out, FallbackHop{
				Provider: h.Provider,
				Model:    m,
				Models:   []string{m},
				KeyID:    h.KeyID,
			})
		}
	}
	return out
}

func firstHopProvider(hops []FallbackHop, p Policy) string {
	if len(hops) > 0 {
		return hops[0].Provider
	}
	return p.FallbackProvider
}

func firstHopModel(hops []FallbackHop, p Policy) string {
	if len(hops) > 0 {
		return hops[0].Model
	}
	return p.FallbackModel
}

func formatHopChain(hops []FallbackHop) string {
	parts := make([]string, 0, len(hops))
	for i, h := range hops {
		models := h.Models
		if len(models) == 0 && h.Model != "" {
			models = []string{h.Model}
		}
		label := strings.Join(models, ",")
		if label == "" {
			label = h.Model
		}
		s := fmt.Sprintf("%d:%s/{%s}", i+1, h.Provider, label)
		if h.KeyID != "" {
			s += "@" + h.KeyID
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, " -> ")
}

func primaryKeyMatches(p Policy, selectedKey string) bool {
	if len(p.PrimaryKeyIDs) == 0 {
		return true
	}
	// Key-scoped: match if no key yet (will re-check after selection) OR selected is listed.
	// For Observe we require selected key in list; for Apply we also match listed keys.
	if selectedKey == "" {
		// Allow Apply/Observe to no-op carefully — Observe returns early if no key in key mode.
		return true
	}
	return containsFold(p.PrimaryKeyIDs, selectedKey)
}

func selectedKeyID(ctx *schemas.BifrostContext) string {
	if ctx == nil {
		return ""
	}
	if v, ok := ctx.Value(schemas.BifrostContextKeySelectedKeyID).(string); ok && v != "" {
		return v
	}
	if v, ok := ctx.Value(schemas.BifrostContextKeyAPIKeyID).(string); ok && v != "" {
		return v
	}
	if v, ok := ctx.Value(schemas.BifrostContextKeyRoutingPinnedAPIKeyID).(string); ok && v != "" {
		return v
	}
	return ""
}

func containsFold(list []string, want string) bool {
	for _, s := range list {
		if strings.EqualFold(s, want) {
			return true
		}
	}
	return false
}

func providerModelMatch(wantProv, wantModel, gotProv, gotModel string) bool {
	return strings.EqualFold(wantProv, gotProv) && wantModel == gotModel
}

// policyMatchesPrimary matches provider + any configured primary model.
func policyMatchesPrimary(p Policy, gotProv, gotModel string) bool {
	if !strings.EqualFold(p.PrimaryProvider, gotProv) {
		return false
	}
	models := p.PrimaryModels
	if len(models) == 0 && p.PrimaryModel != "" {
		models = []string{p.PrimaryModel}
	}
	for _, m := range models {
		if m == gotModel {
			return true
		}
	}
	return false
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
		if code >= 400 && code < 500 {
			return false
		}
	}
	if err.Error != nil {
		msg := strings.ToLower(err.Error.Message)
		if strings.Contains(msg, "timeout") ||
			strings.Contains(msg, "timed out") ||
			strings.Contains(msg, "connection") ||
			strings.Contains(msg, "unavailable") ||
			strings.Contains(msg, "eof") ||
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
