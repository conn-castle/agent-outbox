package command

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"agent-outbox/internal/foundation"
)

func TestExecuteSplitsHelpToStdoutAndErrorsToStderr(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	code := Execute(context.Background(), Options{
		Stdout: &stdout,
		Stderr: &stderr,
		Env:    foundation.Env{},
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d", code)
	}
	if !strings.Contains(stdout.String(), "caller") {
		t.Fatalf("help output missing command scaffold")
	}
	if strings.Contains(stdout.String(), "completion") {
		t.Fatalf("help output exposed unplanned completion command")
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr should be empty for help")
	}
}

func TestExecuteRendersJSONErrorsOnStderr(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	code := Execute(context.Background(), Options{
		Args:   []string{"--json", "--missing-flag"},
		Stdout: &stdout,
		Stderr: &stderr,
		Env:    foundation.Env{},
	})
	if code != foundation.ExitUsage {
		t.Fatalf("exit code = %d, want usage", code)
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout should stay empty for errors")
	}
	if !strings.Contains(stderr.String(), `"ok":false`) || !strings.Contains(stderr.String(), `"code":"usage_error"`) {
		t.Fatalf("stderr did not contain JSON error payload")
	}
}

func TestExecuteRejectsLaterPhaseSubcommandsOnScaffoldParents(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	code := Execute(context.Background(), Options{
		Args:   []string{"--json", "billing"},
		Stdout: &stdout,
		Stderr: &stderr,
		Env:    foundation.Env{},
	})
	if code != foundation.ExitUsage {
		t.Fatalf("exit code = %d, want usage", code)
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout should stay empty for scaffold argument errors")
	}
	if !strings.Contains(stderr.String(), `"ok":false`) || !strings.Contains(stderr.String(), `"code":"usage_error"`) {
		t.Fatalf("stderr did not contain JSON usage error: %s", stderr.String())
	}
}

func TestExecuteEnforcesCallerSelectionForCallerScopedScaffolds(t *testing.T) {
	configPath := writeCommandConfigFixture(t, `{
  "version": 1,
  "callers": [
    {"name": "alpha", "caller_id": "caller_alpha"},
    {"name": "beta", "caller_id": "caller_beta"}
  ]
}`)

	for name, tc := range map[string]struct {
		args []string
		env  foundation.Env
		code foundation.ErrorCode
	}{
		"input conflict": {
			args: []string{"--json", "--config", filepath.Join(t.TempDir(), "missing.json"), "--caller", "alpha", "input"},
			env:  foundation.Env{foundation.EnvCaller: "alpha"},
			code: foundation.CodeCallerSelectionConflict,
		},
		"output ambiguous": {
			args: []string{"--json", "--config", configPath, "output"},
			env:  foundation.Env{},
			code: foundation.CodeAmbiguousCaller,
		},
		"account unknown": {
			args: []string{"--json", "--config", configPath, "--caller", "missing", "account"},
			env:  foundation.Env{},
			code: foundation.CodeUnknownCaller,
		},
	} {
		t.Run(name, func(t *testing.T) {
			var stdout bytes.Buffer
			var stderr bytes.Buffer

			exitCode := Execute(context.Background(), Options{
				Args:   tc.args,
				Stdout: &stdout,
				Stderr: &stderr,
				Env:    tc.env,
			})
			if exitCode != foundation.ExitConfig {
				t.Fatalf("exit code = %d, want config", exitCode)
			}
			if stdout.Len() != 0 {
				t.Fatalf("stdout should stay empty for caller selection errors")
			}
			if !strings.Contains(stderr.String(), `"code":"`+string(tc.code)+`"`) {
				t.Fatalf("stderr did not contain %q: %s", tc.code, stderr.String())
			}
		})
	}
}

func TestExecuteDoesNotRequireCallerSelectionOnRootOrCallerParent(t *testing.T) {
	for name, args := range map[string][]string{
		"root":   {"--json", "--config", filepath.Join(t.TempDir(), "missing.json"), "--caller", "alpha"},
		"caller": {"--json", "--config", filepath.Join(t.TempDir(), "missing.json"), "--caller", "alpha", "caller"},
	} {
		t.Run(name, func(t *testing.T) {
			var stdout bytes.Buffer
			var stderr bytes.Buffer

			exitCode := Execute(context.Background(), Options{
				Args:   args,
				Stdout: &stdout,
				Stderr: &stderr,
				Env:    foundation.Env{foundation.EnvCaller: "alpha"},
			})
			if exitCode != foundation.ExitSuccess {
				t.Fatalf("exit code = %d, want success; stderr: %s", exitCode, stderr.String())
			}
			if !strings.Contains(stdout.String(), "caller") {
				t.Fatalf("help output missing command scaffold")
			}
			if stderr.Len() != 0 {
				t.Fatalf("stderr should be empty for help")
			}
		})
	}
}

func TestExecuteLoadsSelectedConfigPath(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "config.json")
	if err := os.WriteFile(configPath, []byte(`{"version":1,"base_url":"https://example.com/api"}`), 0o600); err != nil {
		t.Fatalf("write config fixture: %v", err)
	}

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Execute(context.Background(), Options{
		Args:   []string{"--json", "--config", configPath},
		Stdout: &stdout,
		Stderr: &stderr,
		Env:    foundation.Env{},
	})
	if code != foundation.ExitConfig {
		t.Fatalf("exit code = %d, want config", code)
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout should stay empty for config errors")
	}
	if !strings.Contains(stderr.String(), `"code":"config_error"`) {
		t.Fatalf("stderr did not contain config error: %s", stderr.String())
	}
}

func TestExecuteRejectsInvalidSelectedConfigPath(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Execute(context.Background(), Options{
		Args:   []string{"--json", "--config", t.TempDir(), "caller"},
		Stdout: &stdout,
		Stderr: &stderr,
		Env:    foundation.Env{},
	})
	if code != foundation.ExitConfig {
		t.Fatalf("exit code = %d, want config", code)
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout should stay empty for config path errors")
	}
	if !strings.Contains(stderr.String(), `"code":"config_error"`) {
		t.Fatalf("stderr did not contain config error: %s", stderr.String())
	}
}

func TestExecuteDoesNotExposeCompletionCommand(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Execute(context.Background(), Options{
		Args:   []string{"--json", "completion"},
		Stdout: &stdout,
		Stderr: &stderr,
		Env:    foundation.Env{},
	})
	if code != foundation.ExitUsage {
		t.Fatalf("exit code = %d, want usage", code)
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout should stay empty for unknown completion command")
	}
	if !strings.Contains(stderr.String(), `"code":"usage_error"`) {
		t.Fatalf("stderr did not contain usage error: %s", stderr.String())
	}
}

func writeCommandConfigFixture(t *testing.T, content string) string {
	t.Helper()

	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(configPath, []byte(content), 0o600); err != nil {
		t.Fatalf("write config fixture: %v", err)
	}
	return configPath
}
