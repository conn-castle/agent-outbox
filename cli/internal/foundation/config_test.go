package foundation

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultPathsUsePlatformStandardLocations(t *testing.T) {
	home := filepath.Join("home", "operator")

	mac := DefaultPaths(home, nil, "darwin")
	if want := filepath.Join(home, "Library", "Application Support", "Agent Outbox", "config.json"); mac.ConfigPath != want {
		t.Fatalf("darwin config path = %q, want %q", mac.ConfigPath, want)
	}
	if want := filepath.Join(home, "Library", "Application Support", "Agent Outbox", "credentials.json"); mac.CredentialsPath != want {
		t.Fatalf("darwin credentials path = %q, want %q", mac.CredentialsPath, want)
	}

	linux := DefaultPaths(home, Env{"XDG_CONFIG_HOME": filepath.Join(home, "xdg")}, "linux")
	if want := filepath.Join(home, "xdg", "agent-outbox", "config.json"); linux.ConfigPath != want {
		t.Fatalf("linux config path = %q, want %q", linux.ConfigPath, want)
	}
	if want := filepath.Join(home, "xdg", "agent-outbox", "credentials.json"); linux.CredentialsPath != want {
		t.Fatalf("linux credentials path = %q, want %q", linux.CredentialsPath, want)
	}

	windows := DefaultPaths(home, Env{"APPDATA": filepath.Join(home, "AppData", "Roaming")}, "windows")
	if want := filepath.Join(home, "AppData", "Roaming", "Agent Outbox", "config.json"); windows.ConfigPath != want {
		t.Fatalf("windows config path = %q, want %q", windows.ConfigPath, want)
	}
}

func TestCredentialsPathLivesBesideSelectedConfig(t *testing.T) {
	configPath := filepath.Join("custom", "agent-outbox.test.json")
	got, err := CredentialsPathForConfig(configPath)
	if err != nil {
		t.Fatalf("CredentialsPathForConfig failed: %v", err)
	}
	if want := filepath.Join("custom", "credentials.json"); got != want {
		t.Fatalf("credentials path = %q, want %q", got, want)
	}
}

func TestSaveConfigCreatesOwnerOnlyConfigWithoutSecrets(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "nested", "agent-outbox", "config.json")

	cfg := Config{
		Callers: []CallerConfig{{
			Name:      "steward-email",
			AccountID: "acct_123",
			CallerID:  "caller_123",
			KeyID:     "key_123",
		}},
	}

	if err := SaveConfig(configPath, cfg); err != nil {
		t.Fatalf("SaveConfig failed: %v", err)
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("reading config: %v", err)
	}
	if strings.Contains(string(data), "caller_api_key") {
		t.Fatalf("config file contains secret-shaped material")
	}

	stat, err := os.Stat(configPath)
	if err != nil {
		t.Fatalf("stat config: %v", err)
	}
	if got := stat.Mode().Perm(); got != 0o600 {
		t.Fatalf("config mode = %#o, want 0600", got)
	}

	dirStat, err := os.Stat(filepath.Dir(configPath))
	if err != nil {
		t.Fatalf("stat config dir: %v", err)
	}
	if got := dirStat.Mode().Perm(); got != 0o700 {
		t.Fatalf("config dir mode = %#o, want 0700", got)
	}

	loaded, err := LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if len(loaded.Callers) != 1 || loaded.Callers[0].Name != "steward-email" {
		t.Fatalf("loaded config did not preserve caller metadata")
	}
}

func TestSaveConfigDoesNotChmodExistingExplicitParent(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "explicit-parent")
	if err := os.Mkdir(parent, 0o755); err != nil {
		t.Fatalf("mkdir explicit parent: %v", err)
	}
	if err := os.Chmod(parent, 0o755); err != nil {
		t.Fatalf("chmod explicit parent: %v", err)
	}

	if err := SaveConfig(filepath.Join(parent, "config.json"), Config{}); err != nil {
		t.Fatalf("SaveConfig failed: %v", err)
	}

	stat, err := os.Stat(parent)
	if err != nil {
		t.Fatalf("stat explicit parent: %v", err)
	}
	if got := stat.Mode().Perm(); got != 0o755 {
		t.Fatalf("explicit parent mode = %#o, want unchanged 0755", got)
	}
}

func TestSaveConfigInOwnerOnlyDirChmodsExistingOwnedParent(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "agent-outbox")
	if err := os.Mkdir(parent, 0o755); err != nil {
		t.Fatalf("mkdir owned parent: %v", err)
	}
	if err := os.Chmod(parent, 0o755); err != nil {
		t.Fatalf("chmod owned parent: %v", err)
	}

	if err := SaveConfigInOwnerOnlyDir(filepath.Join(parent, "config.json"), Config{}); err != nil {
		t.Fatalf("SaveConfigInOwnerOnlyDir failed: %v", err)
	}

	stat, err := os.Stat(parent)
	if err != nil {
		t.Fatalf("stat owned parent: %v", err)
	}
	if got := stat.Mode().Perm(); got != 0o700 {
		t.Fatalf("owned parent mode = %#o, want 0700", got)
	}
}

func TestResolveBaseURLUsesFlagEnvConfigDefaultOrder(t *testing.T) {
	cfg := Config{BaseURL: "https://config.example"}
	env := Env{EnvBaseURL: "https://env.example/"}

	got, err := ResolveBaseURL("http://127.0.0.1:38000", env, cfg)
	if err != nil {
		t.Fatalf("ResolveBaseURL flag failed: %v", err)
	}
	if got != "http://127.0.0.1:38000" {
		t.Fatalf("flag base URL = %q", got)
	}

	got, err = ResolveBaseURL("", env, cfg)
	if err != nil {
		t.Fatalf("ResolveBaseURL env failed: %v", err)
	}
	if got != "https://env.example" {
		t.Fatalf("env base URL = %q", got)
	}

	got, err = ResolveBaseURL("", nil, cfg)
	if err != nil {
		t.Fatalf("ResolveBaseURL config failed: %v", err)
	}
	if got != "https://config.example" {
		t.Fatalf("config base URL = %q", got)
	}

	got, err = ResolveBaseURL("", nil, Config{})
	if err != nil {
		t.Fatalf("ResolveBaseURL default failed: %v", err)
	}
	if got != DefaultBaseURL {
		t.Fatalf("default base URL = %q", got)
	}
}

func TestResolveBaseURLRejectsNonOriginValues(t *testing.T) {
	for _, raw := range []string{"ftp://example.com", "https://example.com/api", "https://example.com?x=1"} {
		if _, err := ResolveBaseURL(raw, nil, Config{}); err == nil {
			t.Fatalf("ResolveBaseURL accepted invalid origin %q", raw)
		}
	}
}

func TestResolveBaseURLRestrictsHTTPToLoopbackHosts(t *testing.T) {
	for _, raw := range []string{
		"http://localhost:38000",
		"http://127.0.0.1:38000",
		"http://[::1]:38000",
	} {
		if _, err := ResolveBaseURL(raw, nil, Config{}); err != nil {
			t.Fatalf("ResolveBaseURL rejected loopback http origin %q: %v", raw, err)
		}
	}

	for _, raw := range []string{
		"http://example.com",
		"http://192.168.1.10:38000",
		"http://app.agent-outbox.dev",
	} {
		if _, err := ResolveBaseURL(raw, nil, Config{}); err == nil {
			t.Fatalf("ResolveBaseURL accepted cleartext non-loopback origin %q", raw)
		}
	}

	if _, err := ResolveBaseURL("https://example.com", nil, Config{}); err != nil {
		t.Fatalf("ResolveBaseURL rejected https origin: %v", err)
	}
}

func TestResolveConfigPathUsesFlagEnvDefaultOrder(t *testing.T) {
	got, err := ResolveConfigPath(" flag-config.json ", Env{EnvConfigPath: "env-config.json"}, "default-config.json")
	if err != nil {
		t.Fatalf("ResolveConfigPath flag failed: %v", err)
	}
	if got != "flag-config.json" {
		t.Fatalf("flag config path = %q", got)
	}

	got, err = ResolveConfigPath("", Env{EnvConfigPath: " env-config.json "}, "default-config.json")
	if err != nil {
		t.Fatalf("ResolveConfigPath env failed: %v", err)
	}
	if got != "env-config.json" {
		t.Fatalf("env config path = %q", got)
	}

	got, err = ResolveConfigPath("", nil, "default-config.json")
	if err != nil {
		t.Fatalf("ResolveConfigPath default failed: %v", err)
	}
	if got != "default-config.json" {
		t.Fatalf("default config path = %q", got)
	}
}

func TestResolveConfigPathFailsWithoutAnySource(t *testing.T) {
	errPath, err := ResolveConfigPath("", nil, "")
	if err == nil {
		t.Fatalf("ResolveConfigPath returned %q without a source", errPath)
	}
	appErr, ok := err.(*AppError)
	if !ok {
		t.Fatalf("error type = %T, want *AppError", err)
	}
	if appErr.Code != CodeConfig {
		t.Fatalf("error code = %q, want %q", appErr.Code, CodeConfig)
	}
}
