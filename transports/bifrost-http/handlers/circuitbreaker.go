package handlers

import (
	"encoding/json"
	"time"

	"github.com/fasthttp/router"
	"github.com/maximhq/bifrost/core/circuitbreaker"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/transports/bifrost-http/lib"
	"github.com/valyala/fasthttp"
)

// CircuitBreakerEngineResolver returns the live CB engine (may be nil).
type CircuitBreakerEngineResolver func() *circuitbreaker.Engine

// CircuitBreakerHandler exposes CRUD + state for first-class circuit breaker.
type CircuitBreakerHandler struct {
	resolve CircuitBreakerEngineResolver
}

// NewCircuitBreakerHandler wires CB management routes.
func NewCircuitBreakerHandler(resolve CircuitBreakerEngineResolver) *CircuitBreakerHandler {
	return &CircuitBreakerHandler{resolve: resolve}
}

func (h *CircuitBreakerHandler) RegisterRoutes(r *router.Router, middlewares ...schemas.BifrostHTTPMiddleware) {
	r.GET("/api/circuit-breaker/policies", lib.ChainMiddlewares(h.listPolicies, middlewares...))
	r.POST("/api/circuit-breaker/policies", lib.ChainMiddlewares(h.createPolicy, middlewares...))
	r.PUT("/api/circuit-breaker/policies/{name}", lib.ChainMiddlewares(h.updatePolicy, middlewares...))
	r.DELETE("/api/circuit-breaker/policies/{name}", lib.ChainMiddlewares(h.deletePolicy, middlewares...))
	r.GET("/api/circuit-breaker/state", lib.ChainMiddlewares(h.getState, middlewares...))
	r.POST("/api/circuit-breaker/policies/{name}/reset", lib.ChainMiddlewares(h.resetPolicy, middlewares...))
}

func (h *CircuitBreakerHandler) engineOrError(ctx *fasthttp.RequestCtx) *circuitbreaker.Engine {
	if h.resolve == nil {
		SendError(ctx, fasthttp.StatusServiceUnavailable, "circuit breaker is not initialized")
		return nil
	}
	e := h.resolve()
	if e == nil {
		SendError(ctx, fasthttp.StatusServiceUnavailable, "circuit breaker is not initialized")
		return nil
	}
	return e
}

type policyWire struct {
	Name             string                    `json:"name"`
	Enabled          *bool                     `json:"enabled,omitempty"`
	PrimaryProvider  string                    `json:"primary_provider"`
	PrimaryModel     string                    `json:"primary_model"`
	PrimaryKeyIDs    []string                  `json:"primary_key_ids,omitempty"`
	Fallbacks        []circuitbreaker.FallbackHop `json:"fallbacks,omitempty"`
	FallbackProvider string                    `json:"fallback_provider,omitempty"`
	FallbackModel    string                    `json:"fallback_model,omitempty"`
	FallbackKeyID    string                    `json:"fallback_key_id,omitempty"`
	DefaultCooldown  string                    `json:"default_cooldown,omitempty"`
	CooldownHeader   string                    `json:"cooldown_header,omitempty"`
	FailureThreshold int                       `json:"failure_threshold,omitempty"`
	FailureWindow    string                    `json:"failure_window,omitempty"`
	Condition        *circuitbreaker.Condition `json:"condition,omitempty"`
}

func policyToWire(p circuitbreaker.Policy) policyWire {
	en := p.Enabled
	return policyWire{
		Name:             p.Name,
		Enabled:          &en,
		PrimaryProvider:  p.PrimaryProvider,
		PrimaryModel:     p.PrimaryModel,
		PrimaryKeyIDs:    p.PrimaryKeyIDs,
		Fallbacks:        p.Fallbacks,
		FallbackProvider: p.FallbackProvider,
		FallbackModel:    p.FallbackModel,
		FallbackKeyID:    p.FallbackKeyID,
		DefaultCooldown:  p.DefaultCooldown.String(),
		CooldownHeader:   p.CooldownHeader,
		FailureThreshold: p.FailureThreshold,
		FailureWindow:    p.FailureWindow.String(),
		Condition:        p.Condition,
	}
}

func wireToPolicy(w policyWire) (circuitbreaker.Policy, error) {
	p := circuitbreaker.Policy{
		Name:             w.Name,
		PrimaryProvider:  w.PrimaryProvider,
		PrimaryModel:     w.PrimaryModel,
		PrimaryKeyIDs:    w.PrimaryKeyIDs,
		Fallbacks:        w.Fallbacks,
		FallbackProvider: w.FallbackProvider,
		FallbackModel:    w.FallbackModel,
		FallbackKeyID:    w.FallbackKeyID,
		CooldownHeader:   w.CooldownHeader,
		FailureThreshold: w.FailureThreshold,
		Condition:        w.Condition,
		Enabled:          true,
	}
	if w.Enabled != nil {
		p.Enabled = *w.Enabled
	}
	if w.DefaultCooldown != "" {
		d, err := time.ParseDuration(w.DefaultCooldown)
		if err != nil {
			return p, err
		}
		p.DefaultCooldown = d
	}
	if w.FailureWindow != "" {
		d, err := time.ParseDuration(w.FailureWindow)
		if err != nil {
			return p, err
		}
		p.FailureWindow = d
	}
	return p, nil
}

func (h *CircuitBreakerHandler) listPolicies(ctx *fasthttp.RequestCtx) {
	e := h.engineOrError(ctx)
	if e == nil {
		return
	}
	pols := e.ListPolicies()
	out := make([]policyWire, 0, len(pols))
	for _, p := range pols {
		out = append(out, policyToWire(p))
	}
	SendJSON(ctx, map[string]interface{}{"policies": out})
}

func (h *CircuitBreakerHandler) createPolicy(ctx *fasthttp.RequestCtx) {
	e := h.engineOrError(ctx)
	if e == nil {
		return
	}
	var w policyWire
	if err := json.Unmarshal(ctx.PostBody(), &w); err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, "invalid JSON body")
		return
	}
	if _, exists := e.GetPolicy(w.Name); exists {
		SendError(ctx, fasthttp.StatusConflict, "policy with this name already exists")
		return
	}
	p, err := wireToPolicy(w)
	if err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, err.Error())
		return
	}
	if err := e.UpsertPolicy(p); err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, err.Error())
		return
	}
	got, _ := e.GetPolicy(p.Name)
	ctx.SetStatusCode(fasthttp.StatusCreated)
	SendJSON(ctx, policyToWire(got))
}

func (h *CircuitBreakerHandler) updatePolicy(ctx *fasthttp.RequestCtx) {
	e := h.engineOrError(ctx)
	if e == nil {
		return
	}
	name, _ := ctx.UserValue("name").(string)
	if name == "" {
		SendError(ctx, fasthttp.StatusBadRequest, "name is required")
		return
	}
	var w policyWire
	if err := json.Unmarshal(ctx.PostBody(), &w); err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, "invalid JSON body")
		return
	}
	if w.Name == "" {
		w.Name = name
	}
	if w.Name != name {
		SendError(ctx, fasthttp.StatusBadRequest, "name in body must match URL or be omitted")
		return
	}
	if _, ok := e.GetPolicy(name); !ok {
		SendError(ctx, fasthttp.StatusNotFound, "policy not found")
		return
	}
	p, err := wireToPolicy(w)
	if err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, err.Error())
		return
	}
	if err := e.UpsertPolicy(p); err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, err.Error())
		return
	}
	got, _ := e.GetPolicy(name)
	SendJSON(ctx, policyToWire(got))
}

func (h *CircuitBreakerHandler) deletePolicy(ctx *fasthttp.RequestCtx) {
	e := h.engineOrError(ctx)
	if e == nil {
		return
	}
	name, _ := ctx.UserValue("name").(string)
	if err := e.DeletePolicy(name); err != nil {
		SendError(ctx, fasthttp.StatusNotFound, err.Error())
		return
	}
	SendJSON(ctx, map[string]string{"status": "deleted"})
}

func (h *CircuitBreakerHandler) getState(ctx *fasthttp.RequestCtx) {
	e := h.engineOrError(ctx)
	if e == nil {
		return
	}
	SendJSON(ctx, map[string]interface{}{"states": e.SnapshotState()})
}

func (h *CircuitBreakerHandler) resetPolicy(ctx *fasthttp.RequestCtx) {
	e := h.engineOrError(ctx)
	if e == nil {
		return
	}
	name, _ := ctx.UserValue("name").(string)
	if err := e.Reset(name); err != nil {
		SendError(ctx, fasthttp.StatusNotFound, err.Error())
		return
	}
	SendJSON(ctx, map[string]string{"status": "reset"})
}
