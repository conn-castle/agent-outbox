package foundation

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	ConfigVersion  = 1
	DefaultBaseURL = "https://app.agent-outbox.dev"
	EnvBaseURL     = "AGENT_OUTBOX_BASE_URL"
	EnvCaller      = "AGENT_OUTBOX_CALLER"
	EnvConfigPath  = "AGENT_OUTBOX_CONFIG_PATH"
)

type Config struct {
	Version int            `json:"version"`
	BaseURL string         `json:"base_url,omitempty"`
	Callers []CallerConfig `json:"callers,omitempty"`
}

type CallerConfig struct {
	Name       string `json:"name"`
	AccountID  string `json:"account_id"`
	CallerID   string `json:"caller_id"`
	CallerSlug string `json:"caller_slug,omitempty"`
	KeyID      string `json:"key_id,omitempty"`
	KeyPrefix  string `json:"key_prefix,omitempty"`
	KeySuffix  string `json:"key_suffix,omitempty"`
	CreatedAt  string `json:"created_at,omitempty"`
	UpdatedAt  string `json:"updated_at,omitempty"`
}

type Paths struct {
	ConfigPath  string
	SecretsPath string
}

func DefaultPathsFromOS() (Paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, fmt.Errorf("resolving home directory: %w", err)
	}
	if home == "" {
		return Paths{}, errors.New("resolving home directory: empty home directory")
	}
	return DefaultPaths(home, EnvFromOS(), runtime.GOOS), nil
}

func DefaultPaths(home string, env Env, goos string) Paths {
	var dir string
	switch goos {
	case "darwin":
		dir = filepath.Join(home, "Library", "Application Support", "Agent Outbox")
	case "windows":
		appData := strings.TrimSpace(env.Get("APPDATA"))
		if appData == "" {
			appData = filepath.Join(home, "AppData", "Roaming")
		}
		dir = filepath.Join(appData, "Agent Outbox")
	default:
		configHome := strings.TrimSpace(env.Get("XDG_CONFIG_HOME"))
		if configHome == "" {
			configHome = filepath.Join(home, ".config")
		}
		dir = filepath.Join(configHome, "agent-outbox")
	}

	return Paths{
		ConfigPath:  filepath.Join(dir, "config.json"),
		SecretsPath: filepath.Join(dir, "secrets.v1.enc"),
	}
}

func LoadConfig(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Config{Version: ConfigVersion}, nil
		}
		return Config{}, WrapConfigError("Could not read local Agent Outbox config.", err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, WrapConfigError("Local Agent Outbox config is not valid JSON.", err)
	}
	if cfg.Version == 0 {
		cfg.Version = ConfigVersion
	}
	if cfg.Version != ConfigVersion {
		return Config{}, NewAppError(CodeConfig, "Local Agent Outbox config version is not supported.")
	}
	return cfg, nil
}

func ResolveConfigPath(flagValue string, env Env, defaultPath string) (string, error) {
	for _, candidate := range []string{flagValue, env.Get(EnvConfigPath), defaultPath} {
		trimmed := strings.TrimSpace(candidate)
		if trimmed == "" {
			continue
		}
		return filepath.Clean(trimmed), nil
	}
	return "", NewAppError(CodeConfig, "Local Agent Outbox config path is required.")
}

func SaveConfig(path string, cfg Config) error {
	return saveConfig(path, cfg, false)
}

func SaveConfigInOwnerOnlyDir(path string, cfg Config) error {
	return saveConfig(path, cfg, true)
}

func saveConfig(path string, cfg Config, chmodExistingParent bool) error {
	if cfg.Version == 0 {
		cfg.Version = ConfigVersion
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return WrapConfigError("Could not serialize local Agent Outbox config.", err)
	}
	data = append(data, '\n')
	if err := writeOwnerOnlyFile(path, data, 0o600, chmodExistingParent); err != nil {
		return WrapConfigError("Could not write local Agent Outbox config.", err)
	}
	return nil
}

func PreflightConfigWrite(path string, chmodExistingParent bool) error {
	if err := preflightOwnerOnlyFile(path, 0o600, chmodExistingParent); err != nil {
		return WrapConfigError("Could not prepare local Agent Outbox config for writing.", err)
	}
	return nil
}

func ResolveBaseURL(flagValue string, env Env, cfg Config) (string, error) {
	for _, candidate := range []string{flagValue, env.Get(EnvBaseURL), cfg.BaseURL} {
		trimmed := strings.TrimSpace(candidate)
		if trimmed == "" {
			continue
		}
		return normalizeBaseURL(trimmed)
	}
	return normalizeBaseURL(DefaultBaseURL)
}

func normalizeBaseURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", NewAppError(CodeConfig, "Agent Outbox base URL is not valid.")
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return "", NewAppError(CodeConfig, "Agent Outbox base URL must use http or https.")
	}
	if parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", NewAppError(CodeConfig, "Agent Outbox base URL must be an app origin.")
	}
	if parsed.Scheme == "http" && !isLoopbackHost(parsed.Hostname()) {
		return "", NewAppError(
			CodeConfig,
			"Agent Outbox base URL must use https for non-loopback hosts; http is allowed only for localhost, 127.0.0.1, or ::1.",
		)
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return "", NewAppError(CodeConfig, "Agent Outbox base URL must not include a path.")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

func isLoopbackHost(hostname string) bool {
	if strings.EqualFold(hostname, "localhost") {
		return true
	}
	ip := net.ParseIP(hostname)
	return ip != nil && ip.IsLoopback()
}

func SelectCaller(flagValue string, env Env, cfg Config) (CallerConfig, error) {
	flagValue = strings.TrimSpace(flagValue)
	envValue := strings.TrimSpace(env.Get(EnvCaller))
	if flagValue != "" && envValue != "" {
		return CallerConfig{}, NewAppError(
			CodeCallerSelectionConflict,
			"--caller and AGENT_OUTBOX_CALLER cannot both be set.",
		)
	}

	selected := flagValue
	if selected == "" {
		selected = envValue
	}
	if selected == "" {
		switch len(cfg.Callers) {
		case 0:
			return CallerConfig{}, NewAppError(CodeConfig, "No local Agent Outbox callers are configured; run agent-outbox caller connect <caller>.")
		case 1:
			return cfg.Callers[0], nil
		default:
			return CallerConfig{}, NewAppError(CodeAmbiguousCaller, "Multiple local callers are configured; pass --caller or run agent-outbox caller list.")
		}
	}

	for _, caller := range cfg.Callers {
		if caller.Name == selected {
			return caller, nil
		}
	}
	return CallerConfig{}, NewAppError(CodeUnknownCaller, "Selected caller is not present in local config; run agent-outbox caller list or agent-outbox caller connect <caller>.")
}

func EnsureOwnerOnlyAppDir(dir string) error {
	return ensureOwnerOnlyDir(dir, true)
}

func ensureOwnerOnlyDir(dir string, chmodExisting bool) error {
	if strings.TrimSpace(dir) == "" {
		return errors.New("directory path is required")
	}

	cleanDir := filepath.Clean(dir)
	var missing []string
	for current := cleanDir; current != "." && current != string(filepath.Separator); current = filepath.Dir(current) {
		if stat, err := os.Stat(current); err == nil {
			if !stat.IsDir() {
				return fmt.Errorf("%s is not a directory", current)
			}
			break
		} else if errors.Is(err, os.ErrNotExist) {
			missing = append(missing, current)
			continue
		} else {
			return err
		}
	}

	for i := len(missing) - 1; i >= 0; i-- {
		if err := os.Mkdir(missing[i], 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		if err := os.Chmod(missing[i], 0o700); err != nil {
			return err
		}
	}

	stat, err := os.Stat(cleanDir)
	if err != nil {
		return err
	}
	if !stat.IsDir() {
		return fmt.Errorf("%s is not a directory", cleanDir)
	}
	if chmodExisting {
		return os.Chmod(cleanDir, 0o700)
	}
	return nil
}

func writeOwnerOnlyFile(path string, data []byte, mode os.FileMode, chmodExistingParent bool) error {
	dir := filepath.Dir(path)
	if err := ensureOwnerOnlyDir(dir, chmodExistingParent); err != nil {
		return fmt.Errorf("creating parent directory %s: %w", dir, err)
	}

	tmp, err := os.CreateTemp(dir, ".agent-outbox-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	closed := false
	keep := false
	defer func() {
		if !closed {
			_ = tmp.Close()
		}
		if !keep {
			_ = os.Remove(tmpName)
		}
	}()

	if err := tmp.Chmod(mode); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	closed = true
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	keep = true
	if err := os.Chmod(path, mode); err != nil {
		return err
	}
	return fsyncDir(dir)
}

// fsyncDir flushes the parent directory entry so the atomic rename above
// survives a crash. Without it, some POSIX filesystems can lose the rename and
// revert to the previous file after power loss, silently rolling back a
// just-stored credential or config. Windows has no durable directory-handle
// sync and its rename is durable without one, so it is skipped there.
func fsyncDir(dir string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	if err := d.Sync(); err != nil {
		_ = d.Close()
		return err
	}
	return d.Close()
}

func preflightOwnerOnlyFile(path string, mode os.FileMode, chmodExistingParent bool) error {
	dir := filepath.Dir(path)
	if err := ensureOwnerOnlyDir(dir, chmodExistingParent); err != nil {
		return fmt.Errorf("creating parent directory %s: %w", dir, err)
	}

	tmp, err := os.CreateTemp(dir, ".agent-outbox-preflight-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	closed := false
	defer func() {
		if !closed {
			_ = tmp.Close()
		}
		_ = os.Remove(tmpName)
	}()

	if err := tmp.Chmod(mode); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	closed = true
	return nil
}
