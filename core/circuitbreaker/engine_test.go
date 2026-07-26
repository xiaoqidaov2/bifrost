package circuitbreaker

import (
	"testing"
	"time"

	"github.com/maximhq/bifrost/core/schemas"
)

func TestEngine_TripsAfterThresholdAndReroutes(t *testing.T) {
	e := NewEngine(nil)
	fixed := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	e.now = func() time.Time { return fixed }

	if err := e.SetPolicies([]Policy{{
		Name:             "main",
		Enabled:          true,
		PrimaryProvider:  "openai",
		PrimaryModel:     "gpt-4o",
		FallbackProvider: "openai",
		FallbackModel:    "gpt-4o-mini",
		DefaultCooldown:  30 * time.Second,
		FailureThreshold: 3,
		FailureWindow:    time.Minute,
	}}); err != nil {
		t.Fatal(err)
	}

	req := &schemas.BifrostRequest{
		RequestType: schemas.ChatCompletionRequest,
		ChatRequest: &schemas.BifrostChatRequest{
			Provider: schemas.OpenAI,
			Model:    "gpt-4o",
		},
	}
	ctx := schemas.NewBifrostContext(nil, schemas.NoDeadline)
	ctx.SetValue(schemas.BifrostContextKeyFallbackIndex, 0)

	status := 503
	fail := &schemas.BifrostError{
		StatusCode: &status,
		Error:      &schemas.ErrorField{Message: "service unavailable"},
	}

	for i := 0; i < 2; i++ {
		e.ObserveAttempt(ctx, req, nil, fail)
	}
	// Not open yet
	e.ApplyIfOpen(ctx, req)
	p, m, _ := req.GetRequestFields()
	if string(p) != "openai" || m != "gpt-4o" {
		t.Fatalf("should not reroute before threshold, got %s/%s", p, m)
	}

	e.ObserveAttempt(ctx, req, nil, fail)
	// Now open
	e.ApplyIfOpen(ctx, req)
	p, m, _ = req.GetRequestFields()
	if string(p) != "openai" || m != "gpt-4o-mini" {
		t.Fatalf("expected fallback rewrite, got %s/%s", p, m)
	}
	if rerouted, _ := ctx.Value(ContextKeyRerouted).(bool); !rerouted {
		t.Fatal("expected rerouted context flag")
	}

	// Fallback success must not close
	e.ObserveAttempt(ctx, req, &schemas.BifrostResponse{}, nil)
	states := e.SnapshotState()
	if len(states) != 1 || states[0].State != StateOpen {
		t.Fatalf("expected still open after fallback success, got %+v", states)
	}
}

func TestEngine_FourXXDoesNotTrip(t *testing.T) {
	e := NewEngine(nil)
	_ = e.SetPolicies([]Policy{{
		Name:             "main",
		Enabled:          true,
		PrimaryProvider:  "openai",
		PrimaryModel:     "gpt-4o",
		FallbackProvider: "openai",
		FallbackModel:    "mini",
		FailureThreshold: 1,
		FailureWindow:    time.Minute,
		DefaultCooldown:  time.Minute,
	}})
	req := &schemas.BifrostRequest{
		RequestType: schemas.ChatCompletionRequest,
		ChatRequest: &schemas.BifrostChatRequest{Provider: schemas.OpenAI, Model: "gpt-4o"},
	}
	ctx := schemas.NewBifrostContext(nil, schemas.NoDeadline)
	ctx.SetValue(schemas.BifrostContextKeyFallbackIndex, 0)
	code := 400
	e.ObserveAttempt(ctx, req, nil, &schemas.BifrostError{
		StatusCode: &code,
		Error:      &schemas.ErrorField{Message: "bad request"},
	})
	st := e.SnapshotState()
	if st[0].State != StateClosed {
		t.Fatalf("4xx should not open, got %s", st[0].State)
	}
}

func TestEngine_CooldownExpiryCloses(t *testing.T) {
	e := NewEngine(nil)
	start := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	now := start
	e.now = func() time.Time { return now }

	_ = e.SetPolicies([]Policy{{
		Name:             "main",
		Enabled:          true,
		PrimaryProvider:  "openai",
		PrimaryModel:     "gpt-4o",
		FallbackProvider: "openai",
		FallbackModel:    "mini",
		FailureThreshold: 1,
		FailureWindow:    time.Minute,
		DefaultCooldown:  10 * time.Second,
	}})
	req := &schemas.BifrostRequest{
		RequestType: schemas.ChatCompletionRequest,
		ChatRequest: &schemas.BifrostChatRequest{Provider: schemas.OpenAI, Model: "gpt-4o"},
	}
	ctx := schemas.NewBifrostContext(nil, schemas.NoDeadline)
	ctx.SetValue(schemas.BifrostContextKeyFallbackIndex, 0)
	code := 500
	e.ObserveAttempt(ctx, req, nil, &schemas.BifrostError{StatusCode: &code, Error: &schemas.ErrorField{Message: "boom"}})

	now = start.Add(11 * time.Second)
	st := e.SnapshotState()
	if st[0].State != StateClosed {
		t.Fatalf("expected closed after cooldown, got %s", st[0].State)
	}
}

func TestEngine_Reset(t *testing.T) {
	e := NewEngine(nil)
	_ = e.SetPolicies([]Policy{{
		Name: "main", Enabled: true,
		PrimaryProvider: "openai", PrimaryModel: "gpt-4o",
		FallbackProvider: "openai", FallbackModel: "mini",
		FailureThreshold: 1, FailureWindow: time.Minute, DefaultCooldown: time.Hour,
	}})
	req := &schemas.BifrostRequest{
		RequestType: schemas.ChatCompletionRequest,
		ChatRequest: &schemas.BifrostChatRequest{Provider: schemas.OpenAI, Model: "gpt-4o"},
	}
	ctx := schemas.NewBifrostContext(nil, schemas.NoDeadline)
	ctx.SetValue(schemas.BifrostContextKeyFallbackIndex, 0)
	code := 502
	e.ObserveAttempt(ctx, req, nil, &schemas.BifrostError{StatusCode: &code, Error: &schemas.ErrorField{Message: "bad gateway"}})
	if err := e.Reset("main"); err != nil {
		t.Fatal(err)
	}
	if e.SnapshotState()[0].State != StateClosed {
		t.Fatal("reset should close")
	}
}

func TestParseFileConfig(t *testing.T) {
	en := true
	pols, err := ParseFileConfig(&FileConfig{Policies: []FilePolicy{{
		Name: "p1", Enabled: &en,
		PrimaryProvider: "azure", PrimaryModel: "ptu",
		FallbackProvider: "azure", FallbackModel: "paygo",
		DefaultCooldown: "45s", FailureThreshold: 2, FailureWindow: "30s",
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(pols) != 1 || pols[0].DefaultCooldown != 45*time.Second || pols[0].FailureWindow != 30*time.Second {
		t.Fatalf("unexpected parse: %+v", pols)
	}
}

func TestEngine_MultiLevelFallbacksAndKeys(t *testing.T) {
	e := NewEngine(nil)
	fixed := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	e.now = func() time.Time { return fixed }

	if err := e.SetPolicies([]Policy{{
		Name:            "keyed",
		Enabled:         true,
		PrimaryProvider: "openai",
		PrimaryModel:    "gpt-4o",
		PrimaryKeyIDs:   []string{"key-a", "key-b"},
		Fallbacks: []FallbackHop{
			{Provider: "openai", Model: "gpt-4o-mini", KeyID: "key-mini"},
			{Provider: "anthropic", Model: "claude-sonnet-4"},
		},
		DefaultCooldown:  30 * time.Second,
		FailureThreshold: 1,
		FailureWindow:    time.Minute,
	}}); err != nil {
		t.Fatal(err)
	}

	// Only key-a open → not full sticky; peer pin path
	req := &schemas.BifrostRequest{
		RequestType: schemas.ChatCompletionRequest,
		ChatRequest: &schemas.BifrostChatRequest{Provider: schemas.OpenAI, Model: "gpt-4o"},
	}
	ctx := schemas.NewBifrostContext(nil, schemas.NoDeadline)
	ctx.SetValue(schemas.BifrostContextKeyFallbackIndex, 0)
	ctx.SetValue(schemas.BifrostContextKeySelectedKeyID, "key-a")
	code := 503
	fail := &schemas.BifrostError{StatusCode: &code, Error: &schemas.ErrorField{Message: "down"}}
	e.ObserveAttempt(ctx, req, nil, fail)

	// key-b still closed → ApplyIfOpen should NOT rewrite model yet
	e.ApplyIfOpen(ctx, req)
	p, m, _ := req.GetRequestFields()
	if string(p) != "openai" || m != "gpt-4o" {
		t.Fatalf("expected stay on primary while peer healthy, got %s/%s", p, m)
	}
	e.ApplyPeerKeyPin(ctx, req)
	if pin, _ := ctx.Value(schemas.BifrostContextKeyAPIKeyID).(string); pin != "key-b" {
		t.Fatalf("expected peer pin key-b, got %q", pin)
	}

	// Open key-b too → full chain
	ctx2 := schemas.NewBifrostContext(nil, schemas.NoDeadline)
	ctx2.SetValue(schemas.BifrostContextKeyFallbackIndex, 0)
	ctx2.SetValue(schemas.BifrostContextKeySelectedKeyID, "key-b")
	e.ObserveAttempt(ctx2, req, nil, fail)

	ctx3 := schemas.NewBifrostContext(nil, schemas.NoDeadline)
	ctx3.SetValue(schemas.BifrostContextKeySelectedKeyID, "key-a")
	req2 := &schemas.BifrostRequest{
		RequestType: schemas.ChatCompletionRequest,
		ChatRequest: &schemas.BifrostChatRequest{Provider: schemas.OpenAI, Model: "gpt-4o"},
	}
	e.ApplyIfOpen(ctx3, req2)
	p, m, fbs := req2.GetRequestFields()
	if string(p) != "openai" || m != "gpt-4o-mini" {
		t.Fatalf("expected first hop mini, got %s/%s", p, m)
	}
	if len(fbs) != 1 || string(fbs[0].Provider) != "anthropic" || fbs[0].Model != "claude-sonnet-4" {
		t.Fatalf("expected remaining hop anthropic, got %+v", fbs)
	}
}

func TestEngine_MultiPrimaryModels(t *testing.T) {
	e := NewEngine(nil)
	if err := e.SetPolicies([]Policy{{
		Name:             "multi",
		Enabled:          true,
		PrimaryProvider:  "catai",
		PrimaryModels:    []string{"gpt-5.6-sol", "gpt-5.6-terra"},
		Fallbacks:        []FallbackHop{{Provider: "catai", Model: "gpt-5.6-sol", KeyID: "stable"}},
		DefaultCooldown:   30 * time.Second,
		FailureThreshold: 1,
		FailureWindow:    time.Minute,
	}}); err != nil {
		t.Fatal(err)
	}
	p, ok := e.GetPolicy("multi")
	if !ok || p.PrimaryModel != "gpt-5.6-sol" || len(p.PrimaryModels) != 2 {
		t.Fatalf("normalize failed: %+v", p)
	}
	status := 503
	fail := &schemas.BifrostError{StatusCode: &status, Error: &schemas.ErrorField{Message: "down"}}
	for _, model := range []string{"gpt-5.6-sol", "gpt-5.6-terra"} {
		req := &schemas.BifrostRequest{RequestType: schemas.ChatCompletionRequest, ChatRequest: &schemas.BifrostChatRequest{Provider: "catai", Model: model}}
		ctx := schemas.NewBifrostContext(nil, schemas.NoDeadline)
		ctx.SetValue(schemas.BifrostContextKeyFallbackIndex, 0)
		e.ObserveAttempt(ctx, req, nil, fail)
	}
	req := &schemas.BifrostRequest{RequestType: schemas.ChatCompletionRequest, ChatRequest: &schemas.BifrostChatRequest{Provider: "catai", Model: "gpt-5.6-terra"}}
	ctx := schemas.NewBifrostContext(nil, schemas.NoDeadline)
	e.ApplyIfOpen(ctx, req)
	prov, model, _ := req.GetRequestFields()
	if string(prov) != "catai" || model != "gpt-5.6-sol" {
		t.Fatalf("expected rewrite for terra primary, got %s/%s", prov, model)
	}
}
