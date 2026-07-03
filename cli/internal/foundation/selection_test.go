package foundation

import "testing"

func TestSelectCallerOrderAndBranches(t *testing.T) {
	cfg := Config{Callers: []CallerConfig{
		{Name: "alpha", CallerID: "caller_alpha"},
		{Name: "beta", CallerID: "caller_beta"},
	}}

	caller, err := SelectCaller("alpha", nil, cfg)
	if err != nil {
		t.Fatalf("flag selection failed: %v", err)
	}
	if caller.CallerID != "caller_alpha" {
		t.Fatalf("flag selected caller id = %q", caller.CallerID)
	}

	caller, err = SelectCaller("", Env{EnvCaller: "beta"}, cfg)
	if err != nil {
		t.Fatalf("env selection failed: %v", err)
	}
	if caller.CallerID != "caller_beta" {
		t.Fatalf("env selected caller id = %q", caller.CallerID)
	}

	caller, err = SelectCaller("", nil, Config{Callers: []CallerConfig{{Name: "only", CallerID: "caller_only"}}})
	if err != nil {
		t.Fatalf("single caller selection failed: %v", err)
	}
	if caller.Name != "only" {
		t.Fatalf("single caller name = %q", caller.Name)
	}
}

func TestSelectCallerFailsOnConflictAmbiguousAndUnknown(t *testing.T) {
	cfg := Config{Callers: []CallerConfig{
		{Name: "alpha", CallerID: "caller_alpha"},
		{Name: "beta", CallerID: "caller_beta"},
	}}

	for name, tc := range map[string]struct {
		flag string
		env  Env
		want ErrorCode
	}{
		"conflict even equal": {flag: "alpha", env: Env{EnvCaller: "alpha"}, want: CodeCallerSelectionConflict},
		"ambiguous":           {env: Env{}, want: CodeAmbiguousCaller},
		"unknown":             {flag: "missing", env: Env{}, want: CodeUnknownCaller},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := SelectCaller(tc.flag, tc.env, cfg)
			appErr, ok := err.(*AppError)
			if !ok {
				t.Fatalf("error type = %T, want *AppError", err)
			}
			if appErr.Code != tc.want {
				t.Fatalf("error code = %q, want %q", appErr.Code, tc.want)
			}
		})
	}
}
