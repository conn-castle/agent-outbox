package command

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"

	"agent-outbox/internal/foundation"

	"github.com/spf13/cobra"
)

type doctorCheckStatus string

const (
	doctorPass doctorCheckStatus = "pass"
	doctorWarn doctorCheckStatus = "warn"
	doctorFail doctorCheckStatus = "fail"
)

type doctorCheck struct {
	Name    string            `json:"name"`
	Status  doctorCheckStatus `json:"status"`
	Message string            `json:"message"`
	Details map[string]any    `json:"details,omitempty"`

	exitCode int
	code     foundation.ErrorCode
}

type doctorPayload struct {
	OK     bool          `json:"ok"`
	Checks []doctorCheck `json:"checks"`
}

func doctorCommand(opts Options, flags *rootFlags) *cobra.Command {
	cmd := &cobra.Command{
		Use:           "doctor",
		Short:         "Run local Agent Outbox CLI diagnostics",
		Args:          noArgs,
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			checks := runDoctor(cmd.Context(), opts, flags)
			payload := doctorPayload{OK: doctorChecksOK(checks), Checks: checks}
			if flags.json {
				if err := renderJSON(opts.Stdout, payload); err != nil {
					return err
				}
			} else {
				renderDoctorHuman(opts.Stdout, checks)
			}
			if failed := firstFailedDoctorCheck(checks); failed != nil {
				return &foundation.AppError{
					Code:     failed.code,
					Message:  "Agent Outbox doctor found a failing check: " + failed.Name + ".",
					ExitCode: failed.exitCode,
				}
			}
			return nil
		},
	}
	documentCommand(cmd, commandHelpSpec{
		Purpose:     "Diagnose local CLI readiness by checking config path, config file, base URL, caller selection, local secret loading, caller status, and account status in deterministic order.",
		Arguments:   "None. Use the global --caller flag to force a specific local caller for diagnostic checks.",
		Flags:       "--json prints ok and checks[]. Global --config, --base-url, --caller, and --no-color are honored by this diagnostic command.",
		Environment: globalEnvironmentHelp(),
		Examples:    "agent-outbox doctor\nagent-outbox doctor --caller steward-email\nagent-outbox doctor --json",
		ExitCodes:   "0 when no checks fail, even with warnings. First failing check determines nonzero exit: 74 secret store, 75 temporary/API failure, 77 permission, 78 config, or the mapped API exit code.",
		RelatedDocs: "docs/spec/errors.md, docs/spec/http-api.md#caller-status, docs/spec/http-api.md#account-status, and agent-outbox docs status.",
	})
	return bypassRootPreflight(cmd)
}

func runDoctor(ctx context.Context, opts Options, flags *rootFlags) []doctorCheck {
	checks := []doctorCheck{}
	path, explicit, check := doctorConfigPathCheck(flags, opts.Env)
	checks = append(checks, check)

	cfg, configOK, configCheck := doctorConfigFileCheck(path, explicit, check.Status == doctorPass)
	checks = append(checks, configCheck)

	baseURL, baseURLOK, baseCheck := doctorBaseURLCheck(flags, opts.Env, cfg, configOK)
	checks = append(checks, baseCheck)

	caller, callerOK, callerCheck := doctorCallerSelectionCheck(flags, opts.Env, cfg, configOK)
	checks = append(checks, callerCheck)

	bearer, bearerOK, secretCheck := doctorSecretStoreCheck(opts, caller, callerOK)
	checks = append(checks, secretCheck)

	client := foundation.APIClient{
		BaseURL:      baseURL,
		HTTPClient:   opts.HTTPClient,
		NewRequestID: opts.NewRequestID,
	}
	checks = append(checks, doctorRemoteStatusCheck(ctx, "caller_status", "/api/caller/status", client, bearer, baseURLOK, bearerOK))
	checks = append(checks, doctorRemoteStatusCheck(ctx, "account_status", "/api/account/status", client, bearer, baseURLOK, bearerOK))
	return checks
}

func doctorConfigPathCheck(flags *rootFlags, env foundation.Env) (string, bool, doctorCheck) {
	path, explicit, err := resolvedOptionalConfigPath(flags, env)
	if err != nil {
		return "", explicit, failCheck("config_path", "Could not resolve local Agent Outbox config path.", foundation.CodeConfig, foundation.ExitConfig, nil)
	}
	return path, explicit, passCheck("config_path", "Config path resolved.", map[string]any{"path": path, "explicit": explicit})
}

func doctorConfigFileCheck(path string, explicit bool, pathOK bool) (foundation.Config, bool, doctorCheck) {
	if !pathOK {
		return foundation.Config{Version: foundation.ConfigVersion}, false, warnCheck("config_file", "Skipped because config path resolution failed.", nil)
	}
	stat, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) && !explicit {
			return foundation.Config{Version: foundation.ConfigVersion}, true, warnCheck("config_file", "Default config file does not exist yet; run agent-outbox caller connect <caller> to create it.", map[string]any{"path": path})
		}
		if errors.Is(err, os.ErrNotExist) {
			return foundation.Config{}, false, failCheck("config_file", "Selected config file does not exist.", foundation.CodeConfig, foundation.ExitConfig, map[string]any{"path": path})
		}
		return foundation.Config{}, false, failCheck("config_file", "Could not inspect local Agent Outbox config.", foundation.CodeConfig, foundation.ExitConfig, map[string]any{"path": path})
	}
	if stat.IsDir() {
		return foundation.Config{}, false, failCheck("config_file", "Selected config path is a directory, not a config file.", foundation.CodeConfig, foundation.ExitConfig, map[string]any{"path": path})
	}
	cfg, loadErr := foundation.LoadConfig(path)
	if loadErr != nil {
		return foundation.Config{}, false, appErrorCheck("config_file", loadErr, map[string]any{"path": path})
	}
	return cfg, true, passCheck("config_file", "Config file is readable.", map[string]any{"path": path, "caller_count": len(cfg.Callers)})
}

func doctorBaseURLCheck(flags *rootFlags, env foundation.Env, cfg foundation.Config, configOK bool) (string, bool, doctorCheck) {
	if !configOK {
		if strings.TrimSpace(flags.baseURL) == "" && strings.TrimSpace(env.Get(foundation.EnvBaseURL)) == "" {
			return "", false, warnCheck("base_url", "Skipped because config file is not usable and no explicit base URL was supplied.", nil)
		}
	}
	baseURL, err := foundation.ResolveBaseURL(flags.baseURL, env, cfg)
	if err != nil {
		return "", false, appErrorCheck("base_url", err, nil)
	}
	return baseURL, true, passCheck("base_url", "Base URL resolved to an app origin.", map[string]any{"base_url": baseURL})
}

func doctorCallerSelectionCheck(flags *rootFlags, env foundation.Env, cfg foundation.Config, configOK bool) (foundation.CallerConfig, bool, doctorCheck) {
	if !configOK {
		return foundation.CallerConfig{}, false, warnCheck("caller_selection", "Skipped because config file is not usable.", nil)
	}

	flagValue := strings.TrimSpace(flags.caller)
	envValue := strings.TrimSpace(env.Get(foundation.EnvCaller))
	if flagValue != "" && envValue != "" {
		return foundation.CallerConfig{}, false, failCheck("caller_selection", "--caller and AGENT_OUTBOX_CALLER cannot both be set.", foundation.CodeCallerSelectionConflict, foundation.ExitConfig, nil)
	}

	selected := flagValue
	if selected == "" {
		selected = envValue
	}
	if selected == "" {
		switch len(cfg.Callers) {
		case 0:
			return foundation.CallerConfig{}, false, warnCheck("caller_selection", "No local callers are configured; run agent-outbox caller connect <caller>.", map[string]any{"caller_count": 0})
		case 1:
			caller := cfg.Callers[0]
			if strings.TrimSpace(caller.CallerID) == "" {
				return foundation.CallerConfig{}, false, failCheck("caller_selection", "The only local caller is missing caller_id in config.", foundation.CodeConfig, foundation.ExitConfig, map[string]any{"caller": caller.Name})
			}
			return caller, true, passCheck("caller_selection", "Selected the only configured local caller.", map[string]any{"caller": caller.Name, "caller_id": caller.CallerID})
		default:
			return foundation.CallerConfig{}, false, warnCheck("caller_selection", "Multiple local callers are configured; pass --caller to run remote checks.", map[string]any{"caller_count": len(cfg.Callers)})
		}
	}

	for _, caller := range cfg.Callers {
		if caller.Name != selected {
			continue
		}
		if strings.TrimSpace(caller.CallerID) == "" {
			return foundation.CallerConfig{}, false, failCheck("caller_selection", "Selected caller is missing caller_id in config.", foundation.CodeConfig, foundation.ExitConfig, map[string]any{"caller": caller.Name})
		}
		return caller, true, passCheck("caller_selection", "Selected local caller.", map[string]any{"caller": caller.Name, "caller_id": caller.CallerID})
	}
	return foundation.CallerConfig{}, false, failCheck("caller_selection", "Selected caller is not present in local config.", foundation.CodeUnknownCaller, foundation.ExitConfig, map[string]any{"caller": selected})
}

func doctorSecretStoreCheck(opts Options, caller foundation.CallerConfig, callerOK bool) (string, bool, doctorCheck) {
	if !callerOK {
		return "", false, warnCheck("secret_store", "Skipped because no single local caller was selected.", nil)
	}
	store, err := secretStoreForCommand(opts)
	if err != nil {
		return "", false, appErrorCheck("secret_store", err, map[string]any{"caller": caller.Name, "caller_id": caller.CallerID})
	}
	bearer, err := store.LoadCallerKey(caller.CallerID)
	if err != nil {
		return "", false, appErrorCheck("secret_store", err, map[string]any{"caller": caller.Name, "caller_id": caller.CallerID})
	}
	if strings.TrimSpace(bearer) == "" {
		return "", false, failCheck("secret_store", "Local caller secret is empty; rotate or reconnect the caller.", foundation.CodeSecretStore, foundation.ExitSecretStore, map[string]any{"caller": caller.Name, "caller_id": caller.CallerID})
	}
	return bearer, true, passCheck("secret_store", "Selected caller secret loaded from local secure storage.", map[string]any{"caller": caller.Name, "caller_id": caller.CallerID})
}

func doctorRemoteStatusCheck(ctx context.Context, name string, apiPath string, client foundation.APIClient, bearer string, baseURLOK bool, bearerOK bool) doctorCheck {
	if !baseURLOK {
		return warnCheck(name, "Skipped because base URL did not resolve.", nil)
	}
	if !bearerOK {
		return warnCheck(name, "Skipped because selected caller secret was not loaded.", nil)
	}
	var data json.RawMessage
	meta, err := client.Do(ctx, http.MethodGet, apiPath, bearer, nil, &data)
	if err != nil {
		details := map[string]any{}
		if meta != nil {
			addResponseMetaDetails(details, meta.RequestID, meta.CorrelationID)
		}
		return appErrorCheck(name, err, details)
	}
	details := safeStatusDetails(data)
	if meta != nil {
		addResponseMetaDetails(details, meta.RequestID, meta.CorrelationID)
	}
	return passCheck(name, remoteStatusMessage(name, details), details)
}

func remoteStatusMessage(name string, details map[string]any) string {
	if name == "caller_status" {
		if status, ok := stringDetail(details, "status"); ok {
			return "Caller status reachable: " + status + "."
		}
		return "Caller status endpoint is reachable."
	}
	tier, hasTier := stringDetail(details, "effective_tier")
	billing, hasBilling := stringDetail(details, "billing_status")
	if hasTier && hasBilling {
		return "Account status reachable: tier=" + tier + " billing=" + billing + "."
	}
	return "Account status endpoint is reachable."
}

func passCheck(name string, message string, details map[string]any) doctorCheck {
	return doctorCheck{Name: name, Status: doctorPass, Message: message, Details: cleanDetails(details)}
}

func warnCheck(name string, message string, details map[string]any) doctorCheck {
	return doctorCheck{Name: name, Status: doctorWarn, Message: message, Details: cleanDetails(details)}
}

func failCheck(name string, message string, code foundation.ErrorCode, exitCode int, details map[string]any) doctorCheck {
	if code == "" {
		code = foundation.CodeInternalError
	}
	if details == nil {
		details = map[string]any{}
	}
	details["code"] = string(code)
	return doctorCheck{Name: name, Status: doctorFail, Message: message, Details: cleanDetails(details), code: code, exitCode: exitCode}
}

func appErrorCheck(name string, err error, details map[string]any) doctorCheck {
	var appErr *foundation.AppError
	if errors.As(err, &appErr) {
		if details == nil {
			details = map[string]any{}
		}
		addResponseMetaDetails(details, appErr.RequestID, appErr.CorrelationID)
		if appErr.RetryAfterSeconds != nil {
			details["retry_after_seconds"] = *appErr.RetryAfterSeconds
		}
		return failCheck(name, appErr.Message, appErr.Code, foundation.ExitCodeFor(appErr), details)
	}
	return failCheck(name, "Unexpected local CLI failure.", foundation.CodeInternalError, foundation.ExitSoftware, details)
}

func addResponseMetaDetails(details map[string]any, requestID string, correlationID string) {
	if strings.TrimSpace(requestID) != "" {
		details["request_id"] = requestID
	}
	if strings.TrimSpace(correlationID) != "" {
		details["correlation_id"] = correlationID
	}
}

func doctorChecksOK(checks []doctorCheck) bool {
	return firstFailedDoctorCheck(checks) == nil
}

func firstFailedDoctorCheck(checks []doctorCheck) *doctorCheck {
	for i := range checks {
		if checks[i].Status == doctorFail {
			return &checks[i]
		}
	}
	return nil
}

func renderDoctorHuman(w io.Writer, checks []doctorCheck) {
	for _, check := range checks {
		_, _ = fmt.Fprintf(w, "%s %s: %s\n", strings.ToUpper(string(check.Status)), check.Name, check.Message)
		if len(check.Details) == 0 {
			continue
		}
		_, _ = fmt.Fprintf(w, "  %s\n", formatDetails(check.Details))
	}
}

func formatDetails(details map[string]any) string {
	keys := make([]string, 0, len(details))
	for key := range details {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, fmt.Sprintf("%s=%v", key, details[key]))
	}
	return strings.Join(parts, " ")
}

func safeStatusDetails(data json.RawMessage) map[string]any {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return map[string]any{"decode_warning": "status data was not a JSON object"}
	}
	sanitized, ok := sanitizeDoctorDetail(value).(map[string]any)
	if !ok {
		return map[string]any{"decode_warning": "status data was not a JSON object"}
	}
	return sanitized
}

func sanitizeDoctorDetail(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := map[string]any{}
		for key, nested := range typed {
			if unsafeDoctorDetailKey(key) {
				continue
			}
			out[key] = sanitizeDoctorDetail(nested)
		}
		return out
	case []any:
		out := make([]any, 0, len(typed))
		for _, nested := range typed {
			out = append(out, sanitizeDoctorDetail(nested))
		}
		return out
	default:
		return typed
	}
}

func unsafeDoctorDetailKey(key string) bool {
	key = strings.ToLower(key)
	for _, token := range []string{"api_key", "secret", "token", "authorization", "bearer", "credential"} {
		if strings.Contains(key, token) {
			return true
		}
	}
	return false
}

func cleanDetails(details map[string]any) map[string]any {
	if len(details) == 0 {
		return nil
	}
	return details
}

func stringDetail(details map[string]any, key string) (string, bool) {
	value, ok := details[key].(string)
	return value, ok && strings.TrimSpace(value) != ""
}
