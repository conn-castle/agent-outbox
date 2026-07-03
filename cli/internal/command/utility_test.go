package command

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"agent-outbox/internal/foundation"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

func TestEveryRegisteredCommandHasHelpContractSections(t *testing.T) {
	root := NewRootCommand(Options{Stdout: io.Discard, Stderr: io.Discard, Env: foundation.Env{}}, &rootFlags{})
	var missing []string
	walkCommands(root, func(cmd *cobra.Command) {
		for _, section := range []string{"Purpose:", "Arguments:", "Flags:", "Environment:", "Examples:", "Exit codes:", "Related docs:"} {
			if !strings.Contains(cmd.Long, section) {
				missing = append(missing, cmd.CommandPath()+" missing "+section)
			}
		}
	})
	if len(missing) != 0 {
		t.Fatalf("commands missing help sections:\n%s", strings.Join(missing, "\n"))
	}
}

func TestCommandHelpCrossChecksFlagsEnvironmentAndDocsTopics(t *testing.T) {
	root := NewRootCommand(Options{Stdout: io.Discard, Stderr: io.Discard, Env: foundation.Env{}}, &rootFlags{})
	var missing []string

	for _, flagName := range []string{"json", "config", "caller", "base-url", "no-color"} {
		if !strings.Contains(root.Long, "--"+flagName) {
			missing = append(missing, root.CommandPath()+" help missing global flag --"+flagName)
		}
	}

	walkCommands(root, func(cmd *cobra.Command) {
		cmd.NonInheritedFlags().VisitAll(func(flag *pflag.Flag) {
			if flag.Name == "help" {
				return
			}
			if !strings.Contains(cmd.Long, "--"+flag.Name) {
				missing = append(missing, cmd.CommandPath()+" help missing registered flag --"+flag.Name)
			}
		})

		if strings.Contains(cmd.Long, "No Agent Outbox environment variables are required") {
			return
		}
		for _, envName := range []string{foundation.EnvBaseURL, foundation.EnvConfigPath, foundation.EnvCaller} {
			if !strings.Contains(cmd.Long, envName) {
				missing = append(missing, cmd.CommandPath()+" help missing environment variable "+envName)
			}
		}
	})

	if len(missing) != 0 {
		t.Fatalf("help accuracy gaps:\n%s", strings.Join(missing, "\n"))
	}

	var topics []string
	for _, topic := range terminalDocs {
		topics = append(topics, topic.Name)
	}
	wantTopics := []string{"cli", "caller", "input", "output", "status", "errors", "upgrade"}
	if strings.Join(topics, ",") != strings.Join(wantTopics, ",") {
		t.Fatalf("docs topics = %v, want %v", topics, wantTopics)
	}
}

func TestVersionBypassesConfigPreflightAndPrintsStableJSON(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Execute(context.Background(), Options{
		Args:   []string{"--config", t.TempDir(), "--json", "version"},
		Stdout: &stdout,
		Stderr: &stderr,
		Env:    foundation.Env{},
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr.String())
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr should be empty: %s", stderr.String())
	}
	payload := decodeCommandJSON(t, stdout.String())
	for _, key := range []string{"version", "commit", "date", "go_version"} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("version JSON missing %q: %#v", key, payload)
		}
	}
	if _, wrapped := payload["data"]; wrapped {
		t.Fatalf("version JSON should not use the data envelope: %s", stdout.String())
	}
}

func TestVersionFlagBypassesConfigPreflight(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Execute(context.Background(), Options{
		Args:   []string{"--config", t.TempDir(), "--version"},
		Stdout: &stdout,
		Stderr: &stderr,
		Env:    foundation.Env{},
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "agent-outbox") {
		t.Fatalf("--version output missing product/version line: %s", stdout.String())
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr should be empty for --version: %s", stderr.String())
	}
}

func TestDocsTopicIndexTopicAndUnknownTopic(t *testing.T) {
	for name, tc := range map[string]struct {
		args       []string
		wantCode   int
		wantStdout []string
		wantStderr []string
	}{
		"index json": {
			args:       []string{"--json", "docs"},
			wantCode:   foundation.ExitSuccess,
			wantStdout: []string{`"topics"`, `"cli"`, `"upgrade"`},
		},
		"cli topic human": {
			args:       []string{"docs", "cli"},
			wantCode:   foundation.ExitSuccess,
			wantStdout: []string{"CLI Model", "docs/spec/README.md"},
		},
		"unknown topic": {
			args:       []string{"--json", "docs", "missing"},
			wantCode:   foundation.ExitUsage,
			wantStderr: []string{`"code":"usage_error"`, "Unknown docs topic"},
		},
	} {
		t.Run(name, func(t *testing.T) {
			var stdout bytes.Buffer
			var stderr bytes.Buffer
			code := Execute(context.Background(), Options{
				Args:   tc.args,
				Stdout: &stdout,
				Stderr: &stderr,
				Env:    foundation.Env{},
			})
			if code != tc.wantCode {
				t.Fatalf("exit code = %d, want %d; stderr: %s", code, tc.wantCode, stderr.String())
			}
			for _, want := range tc.wantStdout {
				if !strings.Contains(stdout.String(), want) {
					t.Fatalf("stdout missing %q: %s", want, stdout.String())
				}
			}
			for _, want := range tc.wantStderr {
				if !strings.Contains(stderr.String(), want) {
					t.Fatalf("stderr missing %q: %s", want, stderr.String())
				}
			}
		})
	}
}

func TestUpgradeResolvesURLAndDoesNotOpenBrowserInJSONMode(t *testing.T) {
	var opened []string
	stdout, stderr, code := executeUtilityCommand(t, []string{"--base-url", "https://app.example", "--json", "upgrade"}, utilityCommandOptions{
		openBrowser: func(rawURL string) error {
			opened = append(opened, rawURL)
			return nil
		},
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if stderr != "" {
		t.Fatalf("stderr should be empty: %s", stderr)
	}
	if len(opened) != 0 {
		t.Fatalf("JSON upgrade opened browser: %#v", opened)
	}
	payload := decodeCommandJSON(t, stdout)
	if payload["url"] != "https://app.example/upgrade" || payload["open_attempted"] != false || payload["opened"] != false {
		t.Fatalf("upgrade JSON = %#v", payload)
	}
}

func TestUpgradeWarnsButSucceedsWhenBrowserOpenFails(t *testing.T) {
	stdout, stderr, code := executeUtilityCommand(t, []string{"--base-url", "https://app.example", "upgrade"}, utilityCommandOptions{
		openBrowser: func(string) error { return errors.New("no browser") },
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if strings.TrimSpace(stdout) != "https://app.example/upgrade" {
		t.Fatalf("stdout = %q", stdout)
	}
	if !strings.Contains(stderr, "could not open browser automatically") {
		t.Fatalf("stderr missing browser warning: %s", stderr)
	}
}

func TestUpgradeFailsForMissingExplicitConfig(t *testing.T) {
	stdout, stderr, code := executeUtilityCommand(t, []string{"--config", filepath.Join(t.TempDir(), "missing.json"), "--json", "upgrade"}, utilityCommandOptions{})
	if code != foundation.ExitConfig {
		t.Fatalf("exit code = %d, want config; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should stay empty for config failure: %s", stdout)
	}
	if !strings.Contains(stderr, `"code":"config_error"`) {
		t.Fatalf("stderr missing config error: %s", stderr)
	}
}

func TestDoctorWarnsWithoutSelectedCallerAndExitsZero(t *testing.T) {
	configPath := writeUtilityConfig(t, `{
  "version": 1,
  "base_url": "https://app.example",
  "callers": []
}`)
	stdout, stderr, code := executeUtilityCommand(t, []string{"--config", configPath, "--json", "doctor"}, utilityCommandOptions{})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if stderr != "" {
		t.Fatalf("stderr should be empty for warning-only doctor: %s", stderr)
	}
	payload := decodeCommandJSON(t, stdout)
	if payload["ok"] != true {
		t.Fatalf("doctor should be ok with warnings only: %s", stdout)
	}
	checks := doctorChecksByName(t, payload)
	if checks["caller_selection"]["status"] != "warn" || checks["secret_store"]["status"] != "warn" {
		t.Fatalf("doctor did not warn for missing caller selection: %#v", checks)
	}
	assertDoctorCheckOrder(t, payload)
}

func TestDoctorCallsStatusEndpointsWithLoadedSecret(t *testing.T) {
	const secret = "caller-super-secret"
	configPath := writeUtilityConfig(t, `{
  "version": 1,
  "base_url": "http://placeholder.invalid",
  "callers": [
    {"name":"steward-email","account_id":"acct_123","caller_id":"caller_123","caller_slug":"steward-email","key_id":"key_123","key_prefix":"aob_live","key_suffix":"cret"}
  ]
}`)
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if got := r.Header.Get("Authorization"); got != "Bearer "+secret {
			t.Fatalf("authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/caller/status":
			_, _ = fmt.Fprint(w, `{"ok":true,"request_id":"req_caller","correlation_id":"corr_caller","data":{"caller_id":"caller_123","caller_slug":"steward-email","status":"active","account":{"account_id":"acct_123","effective_tier":"free","billing_status":"not_applicable"}}}`)
		case "/api/account/status":
			_, _ = fmt.Fprint(w, `{"ok":true,"request_id":"req_account","correlation_id":"corr_account","data":{"account_id":"acct_123","label":"Test","effective_tier":"free","billing_status":"not_applicable","file_upload_enabled":false,"active_limit_blocks":[]}}`)
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	stdout, stderr, code := executeUtilityCommand(t, []string{"--config", configPath, "--base-url", server.URL, "--json", "doctor"}, utilityCommandOptions{
		secretStore: &dataPlaneSecretStore{keys: map[string]string{"caller_123": secret}},
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if len(paths) != 2 || paths[0] != "/api/caller/status" || paths[1] != "/api/account/status" {
		t.Fatalf("doctor status endpoint calls = %#v", paths)
	}
	if strings.Contains(stdout, secret) || strings.Contains(stderr, secret) {
		t.Fatalf("doctor leaked caller secret; stdout=%s stderr=%s", stdout, stderr)
	}
	payload := decodeCommandJSON(t, stdout)
	if payload["ok"] != true {
		t.Fatalf("doctor should pass: %s", stdout)
	}
	checks := doctorChecksByName(t, payload)
	if checks["caller_status"]["status"] != "pass" || checks["account_status"]["status"] != "pass" {
		t.Fatalf("remote status checks did not pass: %#v", checks)
	}
	if !strings.Contains(checks["account_status"]["message"].(string), "tier=free") {
		t.Fatalf("account status message missing tier: %#v", checks["account_status"])
	}
}

func TestDoctorReturnsSecretStoreExitForSelectedCallerSecretFailure(t *testing.T) {
	configPath := writeUtilityConfig(t, `{
  "version": 1,
  "base_url": "https://app.example",
  "callers": [
    {"name":"steward-email","account_id":"acct_123","caller_id":"caller_123","caller_slug":"steward-email","key_id":"key_123","key_prefix":"aob_live","key_suffix":"cret"}
  ]
}`)
	stdout, stderr, code := executeUtilityCommand(t, []string{"--config", configPath, "--json", "doctor"}, utilityCommandOptions{
		secretStore: &dataPlaneSecretStore{err: foundation.NewSecretStoreError("fake secure storage failure")},
	})
	if code != foundation.ExitSecretStore {
		t.Fatalf("exit code = %d, want secret-store; stderr: %s", code, stderr)
	}
	payload := decodeCommandJSON(t, stdout)
	if payload["ok"] != false {
		t.Fatalf("doctor should report ok=false when a check fails: %s", stdout)
	}
	checks := doctorChecksByName(t, payload)
	if checks["secret_store"]["status"] != "fail" {
		t.Fatalf("secret_store check did not fail: %#v", checks["secret_store"])
	}
	if !strings.Contains(stderr, `"code":"secret_store_error"`) {
		t.Fatalf("stderr missing secret-store error: %s", stderr)
	}
}

func TestDoctorFailsForMissingExplicitConfigButStillReportsChecks(t *testing.T) {
	missingPath := filepath.Join(t.TempDir(), "missing.json")
	stdout, stderr, code := executeUtilityCommand(t, []string{"--config", missingPath, "--json", "doctor"}, utilityCommandOptions{})
	if code != foundation.ExitConfig {
		t.Fatalf("exit code = %d, want config; stderr: %s", code, stderr)
	}
	payload := decodeCommandJSON(t, stdout)
	if payload["ok"] != false {
		t.Fatalf("doctor should report ok=false for missing explicit config: %s", stdout)
	}
	checks := doctorChecksByName(t, payload)
	if checks["config_file"]["status"] != "fail" {
		t.Fatalf("config_file should fail: %#v", checks["config_file"])
	}
	if !strings.Contains(stderr, `"code":"config_error"`) {
		t.Fatalf("stderr missing config error: %s", stderr)
	}
	assertDoctorCheckOrder(t, payload)
}

type utilityCommandOptions struct {
	secretStore foundation.CallerSecretLoader
	openBrowser func(string) error
}

func executeUtilityCommand(t *testing.T, args []string, opts utilityCommandOptions) (string, string, int) {
	t.Helper()

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Execute(context.Background(), Options{
		Args:        args,
		Stdout:      &stdout,
		Stderr:      &stderr,
		Env:         foundation.Env{},
		SecretStore: opts.secretStore,
		OpenBrowser: opts.openBrowser,
	})
	return stdout.String(), stderr.String(), code
}

func writeUtilityConfig(t *testing.T, content string) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write utility config: %v", err)
	}
	return path
}

func walkCommands(cmd *cobra.Command, visit func(*cobra.Command)) {
	visit(cmd)
	for _, child := range cmd.Commands() {
		if child.Hidden {
			continue
		}
		walkCommands(child, visit)
	}
}

func doctorChecksByName(t *testing.T, payload map[string]any) map[string]map[string]any {
	t.Helper()

	rawChecks, ok := payload["checks"].([]any)
	if !ok {
		t.Fatalf("doctor payload missing checks: %#v", payload)
	}
	checks := map[string]map[string]any{}
	for _, raw := range rawChecks {
		check, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("doctor check is not an object: %#v", raw)
		}
		name, ok := check["name"].(string)
		if !ok {
			t.Fatalf("doctor check missing name: %#v", check)
		}
		checks[name] = check
	}
	return checks
}

func assertDoctorCheckOrder(t *testing.T, payload map[string]any) {
	t.Helper()

	rawChecks := payload["checks"].([]any)
	var names []string
	for _, raw := range rawChecks {
		names = append(names, raw.(map[string]any)["name"].(string))
	}
	want := []string{"config_path", "config_file", "base_url", "caller_selection", "secret_store", "caller_status", "account_status"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		encoded, _ := json.Marshal(names)
		t.Fatalf("doctor check order = %s, want %v", encoded, want)
	}
}
