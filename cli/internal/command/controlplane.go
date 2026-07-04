package command

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"agent-outbox/internal/foundation"

	"github.com/spf13/cobra"
)

const (
	defaultDevicePollIntervalSeconds = 5
	browserApprovalExpiryGrace       = 5 * time.Second
)

type browserStartData struct {
	ApprovalURL    string `json:"approval_url"`
	SetupRequestID string `json:"setup_request_id"`
	ExpiresAt      string `json:"expires_at"`
}

type deviceStartData struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresAt               string `json:"expires_at"`
	PollIntervalSeconds     int    `json:"poll_interval_seconds"`
}

type deviceSetupCodeData struct {
	SetupRequestID string `json:"setup_request_id"`
	SetupCode      string `json:"setup_code"`
}

type callerData struct {
	CallerID    string `json:"caller_id"`
	CallerSlug  string `json:"caller_slug,omitempty"`
	DisplayName string `json:"display_name,omitempty"`
}

type accountData struct {
	AccountID     string `json:"account_id"`
	Label         string `json:"label,omitempty"`
	EffectiveTier string `json:"effective_tier,omitempty"`
}

type credentialData struct {
	APIKey    string `json:"api_key,omitempty"`
	KeyID     string `json:"key_id"`
	Prefix    string `json:"prefix,omitempty"`
	LastChars string `json:"last_chars,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
	ExpiresAt string `json:"expires_at,omitempty"`
}

type connectExchangeData struct {
	SetupRequestID string         `json:"setup_request_id"`
	Caller         callerData     `json:"caller"`
	Account        accountData    `json:"account"`
	Credential     credentialData `json:"credential"`
}

type connectActivateData struct {
	CallerID       string `json:"caller_id"`
	ActivatedKeyID string `json:"activated_key_id"`
	ActivatedAt    string `json:"activated_at"`
}

type rotateExchangeData struct {
	Caller                callerData     `json:"caller"`
	Account               accountData    `json:"account"`
	ReplacementCredential credentialData `json:"replacement_credential"`
	ReplacesCredential    credentialData `json:"replaces_credential"`
}

type rotateActivateData struct {
	CallerID       string `json:"caller_id"`
	ActivatedKeyID string `json:"activated_key_id"`
	RevokedKeyID   string `json:"revoked_key_id"`
	ActivatedAt    string `json:"activated_at"`
}

type revokeConfirmData struct {
	CallerID      string   `json:"caller_id"`
	RevokedKeyIDs []string `json:"revoked_key_ids"`
	RevokedAt     string   `json:"revoked_at"`
}

type controlPlaneRuntime struct {
	ConfigPath      string
	ConfigPathOwned bool
	Config          foundation.Config
	Client          foundation.APIClient
	Secrets         foundation.CallerSecretStore
}

type browserCallbackResult struct {
	SetupCode      string
	SetupRequestID string
	Err            error
}

func addControlPlaneCommands(caller *cobra.Command, opts Options, flags *rootFlags) {
	caller.AddCommand(callerConnectCommand(opts, flags))
	caller.AddCommand(callerListCommand(opts, flags))
	caller.AddCommand(callerRotateCommand(opts, flags))
	caller.AddCommand(callerRevokeCommand(opts, flags))
	caller.AddCommand(callerDisconnectCommand(opts, flags))
}

func callerConnectCommand(opts Options, flags *rootFlags) *cobra.Command {
	deviceCode := false
	cmd := &cobra.Command{
		Use:           "connect <caller>",
		Short:         "Connect a local caller through human approval",
		Args:          exactArgs(1),
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(cmd *cobra.Command, args []string) error {
			localName, err := normalizeLocalCallerName(args[0])
			if err != nil {
				return err
			}
			runtime, err := writableControlRuntimeForCommand(opts, flags)
			if err != nil {
				return err
			}
			if err := ensureLocalCallerNameAvailable(runtime.Config, localName); err != nil {
				return err
			}
			if err := preflightConnectLocalPersistence(runtime); err != nil {
				return err
			}
			var result connectExchangeData
			if deviceCode {
				result, err = runDeviceConnect(cmd.Context(), opts, runtime, localName)
			} else {
				result, err = runBrowserConnect(cmd.Context(), opts, runtime, localName)
			}
			if err != nil {
				return err
			}
			activated, err := storeAndActivateConnect(cmd.Context(), runtime, localName, result)
			if err != nil {
				return err
			}
			return renderStructuredSuccess(opts.Stdout, flags.json, nil, sanitizedConnectResult(localName, result, activated))
		},
	}
	cmd.Flags().BoolVar(&deviceCode, "device-code", false, "use the device-code approval flow")
	documentCommand(cmd, commandHelpSpec{
		Purpose:     "Create a local caller connection through human approval, store the display-once caller credential locally, then activate it with the hosted app.",
		Arguments:   "<caller> is the local caller name to store in Agent Outbox config.",
		Flags:       "--device-code uses the terminal device-code approval flow instead of opening a browser. Global --config, --base-url, --json, and --no-color are available.",
		Environment: globalEnvironmentHelp(),
		Examples:    "agent-outbox caller connect steward-email\nagent-outbox --base-url http://localhost:38000 caller connect steward-email --device-code --json",
		ExitCodes:   "0 success. 64 usage. 73 local or hosted caller name already exists. 74 secret-store failure. 75 temporary approval/API failure. 77 permission. 78 config.",
		RelatedDocs: "docs/spec/http-api.md#caller-connect-control-plane, docs/spec/errors.md, and agent-outbox docs caller.",
	})
	return cmd
}

func callerListCommand(opts Options, flags *rootFlags) *cobra.Command {
	cmd := &cobra.Command{
		Use:           "list",
		Short:         "List locally configured callers",
		Args:          noArgs,
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(_ *cobra.Command, _ []string) error {
			cfg, err := loadConfig(flags, opts.Env)
			if err != nil {
				return err
			}
			if len(cfg.Callers) == 0 {
				return foundation.NewAppError(foundation.CodeConfig, "No local Agent Outbox callers are configured; run agent-outbox caller connect <caller>.")
			}
			if err := validateLocalCallerRecords(cfg.Callers); err != nil {
				return err
			}
			if flags.json {
				return renderStructuredSuccess(opts.Stdout, true, nil, map[string]any{"callers": cfg.Callers})
			}
			for _, caller := range cfg.Callers {
				_, _ = fmt.Fprintln(opts.Stdout, formatLocalCaller(caller))
			}
			return nil
		},
	}
	documentCommand(cmd, commandHelpSpec{
		Purpose:     "List caller records from the local Agent Outbox config only. This command does not query remote account callers.",
		Arguments:   "None.",
		Flags:       "--json prints callers[]. Global --config, --base-url, --caller, and --no-color are accepted; --caller is not needed for local listing.",
		Environment: globalEnvironmentHelp(),
		Examples:    "agent-outbox caller list\nagent-outbox caller list --json",
		ExitCodes:   "0 success. 64 usage. 78 missing, invalid, or incomplete local caller config.",
		RelatedDocs: "docs/spec/README.md#cli-foundation-contract and agent-outbox docs caller.",
	})
	return bypassRootPreflight(cmd)
}

func callerRotateCommand(opts Options, flags *rootFlags) *cobra.Command {
	deviceCode := false
	cmd := &cobra.Command{
		Use:           "rotate",
		Short:         "Rotate a local caller credential through human approval",
		Args:          noArgs,
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			runtime, selected, err := selectedWritableControlRuntime(opts, flags)
			if err != nil {
				return err
			}
			var setup deviceSetupCodeData
			if deviceCode {
				setup, err = runDeviceSetupCodeFlow(cmd.Context(), opts, runtime, selected, "rotate", "/api/caller/rotate/device/start", "/api/caller/rotate/device/poll")
			} else {
				setup, err = runBrowserSetupCodeFlow(cmd.Context(), opts, runtime, selected, "rotate", "/api/caller/rotate/browser/start")
			}
			if err != nil {
				return err
			}
			exchanged, activated, err := exchangeStoreAndActivateRotate(cmd.Context(), runtime, selected, setup)
			if err != nil {
				return err
			}
			return renderStructuredSuccess(opts.Stdout, flags.json, nil, sanitizedRotateResult(selected.Name, exchanged, activated))
		},
	}
	cmd.Flags().BoolVar(&deviceCode, "device-code", false, "use the device-code approval flow")
	documentCommand(cmd, commandHelpSpec{
		Purpose:     "Rotate the selected local caller credential through human approval and activate the replacement only after local storage succeeds.",
		Arguments:   "None. Select the local caller with --caller, AGENT_OUTBOX_CALLER, or the single configured caller.",
		Flags:       "--device-code uses terminal approval. Global --caller, --config, --base-url, --json, and --no-color are available.",
		Environment: globalEnvironmentHelp(),
		Examples:    "agent-outbox caller rotate --caller steward-email\nagent-outbox caller rotate --device-code --json",
		ExitCodes:   "0 success. 64 usage. 74 secret-store failure. 75 temporary approval/API failure. 77 permission. 78 config or caller selection.",
		RelatedDocs: "docs/spec/http-api.md#caller-rotate-control-plane, docs/spec/errors.md, and agent-outbox docs caller.",
	})
	return cmd
}

func callerRevokeCommand(opts Options, flags *rootFlags) *cobra.Command {
	deviceCode := false
	cmd := &cobra.Command{
		Use:           "revoke <caller>",
		Short:         "Revoke a caller credential through human approval",
		Args:          exactArgs(1),
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(cmd *cobra.Command, args []string) error {
			runtime, selected, err := namedControlRuntime(opts, flags, args[0])
			if err != nil {
				return err
			}
			confirmed, err := runRevokeFlow(cmd.Context(), opts, runtime, selected, deviceCode)
			if err != nil {
				return err
			}
			return renderStructuredSuccess(opts.Stdout, flags.json, nil, sanitizedRevokeResult(selected.Name, confirmed))
		},
	}
	cmd.Flags().BoolVar(&deviceCode, "device-code", false, "use the device-code approval flow")
	documentCommand(cmd, commandHelpSpec{
		Purpose:     "Revoke hosted credentials for a named local caller through human approval while preserving local config unless disconnect is used.",
		Arguments:   "<caller> is the local caller name to revoke.",
		Flags:       "--device-code uses terminal approval. Global --config, --base-url, --json, and --no-color are available.",
		Environment: globalEnvironmentHelp(),
		Examples:    "agent-outbox caller revoke steward-email\nagent-outbox caller revoke steward-email --device-code --json",
		ExitCodes:   "0 success. 64 usage. 75 temporary approval/API failure. 77 permission. 78 config or unknown caller.",
		RelatedDocs: "docs/spec/http-api.md#caller-revoke-control-plane, docs/spec/errors.md, and agent-outbox docs caller.",
	})
	return cmd
}

func callerDisconnectCommand(opts Options, flags *rootFlags) *cobra.Command {
	revoke := false
	deviceCode := false
	cmd := &cobra.Command{
		Use:           "disconnect",
		Short:         "Remove local caller state",
		Args:          noArgs,
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if deviceCode && !revoke {
				return foundation.NewUsageError("caller disconnect --device-code requires --revoke.")
			}
			runtime, selected, err := selectedLocalControlRuntime(opts, flags)
			if err != nil {
				return err
			}
			var confirmed revokeConfirmData
			if revoke {
				runtime, selected, err = selectedControlRuntime(opts, flags)
				if err != nil {
					return err
				}
				confirmed, err = runRevokeFlow(cmd.Context(), opts, runtime, selected, deviceCode)
				if err != nil {
					return err
				}
			}
			if err := attachWritableSecretStore(runtime, opts); err != nil {
				return err
			}
			if err := removeLocalCaller(runtime, selected); err != nil {
				return err
			}
			data := map[string]any{
				"local_caller_name": selected.Name,
				"caller_id":         selected.CallerID,
				"disconnected":      true,
				"revoked":           revoke,
			}
			if revoke {
				data["revoked_key_ids"] = confirmed.RevokedKeyIDs
				data["revoked_at"] = confirmed.RevokedAt
			}
			return renderStructuredSuccess(opts.Stdout, flags.json, nil, data)
		},
	}
	cmd.Flags().BoolVar(&revoke, "revoke", false, "revoke hosted credentials before removing local state")
	cmd.Flags().BoolVar(&deviceCode, "device-code", false, "use the device-code approval flow when --revoke is set")
	documentCommand(cmd, commandHelpSpec{
		Purpose:     "Remove the selected local caller config and secret-store entry, optionally revoking hosted credentials first.",
		Arguments:   "None. Select the local caller with --caller, AGENT_OUTBOX_CALLER, or the single configured caller.",
		Flags:       "--revoke performs human-approved hosted revocation before local removal. --device-code is valid only with --revoke. Global flags are available.",
		Environment: globalEnvironmentHelp(),
		Examples:    "agent-outbox caller disconnect --caller steward-email\nagent-outbox caller disconnect --revoke --device-code --json",
		ExitCodes:   "0 success. 64 usage. 74 secret-store failure. 75 temporary approval/API failure. 77 permission. 78 config or caller selection.",
		RelatedDocs: "docs/spec/README.md#cli-foundation-contract, docs/spec/errors.md, and agent-outbox docs caller.",
	})
	return bypassRootPreflight(cmd)
}

func localControlRuntimeForCommand(opts Options, flags *rootFlags) (*controlPlaneRuntime, error) {
	configPath, cfg, configPathOwned, err := loadConfigDetails(flags, opts.Env)
	if err != nil {
		return nil, err
	}
	return &controlPlaneRuntime{
		ConfigPath:      configPath,
		ConfigPathOwned: configPathOwned,
		Config:          cfg,
	}, nil
}

func controlRuntimeForCommand(opts Options, flags *rootFlags) (*controlPlaneRuntime, error) {
	configPath, cfg, configPathOwned, err := loadConfigDetails(flags, opts.Env)
	if err != nil {
		return nil, err
	}
	baseURL, err := foundation.ResolveBaseURL(flags.baseURL, opts.Env, cfg)
	if err != nil {
		return nil, err
	}
	return &controlPlaneRuntime{
		ConfigPath:      configPath,
		ConfigPathOwned: configPathOwned,
		Config:          cfg,
		Client: foundation.APIClient{
			BaseURL:      baseURL,
			HTTPClient:   opts.HTTPClient,
			NewRequestID: opts.NewRequestID,
		},
	}, nil
}

func writableControlRuntimeForCommand(opts Options, flags *rootFlags) (*controlPlaneRuntime, error) {
	runtime, err := controlRuntimeForCommand(opts, flags)
	if err != nil {
		return nil, err
	}
	if err := attachWritableSecretStore(runtime, opts); err != nil {
		return nil, err
	}
	return runtime, nil
}

func attachWritableSecretStore(runtime *controlPlaneRuntime, opts Options) error {
	store, err := writableSecretStoreForCommand(opts)
	if err != nil {
		return err
	}
	runtime.Secrets = store
	return nil
}

func selectedControlRuntime(opts Options, flags *rootFlags) (*controlPlaneRuntime, foundation.CallerConfig, error) {
	runtime, err := controlRuntimeForCommand(opts, flags)
	if err != nil {
		return nil, foundation.CallerConfig{}, err
	}
	selected, err := foundation.SelectCaller(flags.caller, opts.Env, runtime.Config)
	if err != nil {
		return nil, foundation.CallerConfig{}, err
	}
	if strings.TrimSpace(selected.CallerID) == "" {
		return nil, foundation.CallerConfig{}, foundation.NewAppError(foundation.CodeConfig, "Selected caller is missing caller_id in local config.")
	}
	return runtime, selected, nil
}

func selectedLocalControlRuntime(opts Options, flags *rootFlags) (*controlPlaneRuntime, foundation.CallerConfig, error) {
	runtime, err := localControlRuntimeForCommand(opts, flags)
	if err != nil {
		return nil, foundation.CallerConfig{}, err
	}
	selected, err := foundation.SelectCaller(flags.caller, opts.Env, runtime.Config)
	if err != nil {
		return nil, foundation.CallerConfig{}, err
	}
	if strings.TrimSpace(selected.CallerID) == "" {
		return nil, foundation.CallerConfig{}, foundation.NewAppError(foundation.CodeConfig, "Selected caller is missing caller_id in local config.")
	}
	return runtime, selected, nil
}

func selectedWritableControlRuntime(opts Options, flags *rootFlags) (*controlPlaneRuntime, foundation.CallerConfig, error) {
	runtime, selected, err := selectedControlRuntime(opts, flags)
	if err != nil {
		return nil, foundation.CallerConfig{}, err
	}
	if err := attachWritableSecretStore(runtime, opts); err != nil {
		return nil, foundation.CallerConfig{}, err
	}
	return runtime, selected, nil
}

func namedControlRuntime(opts Options, flags *rootFlags, name string) (*controlPlaneRuntime, foundation.CallerConfig, error) {
	name, err := normalizeLocalCallerName(name)
	if err != nil {
		return nil, foundation.CallerConfig{}, err
	}
	runtime, err := controlRuntimeForCommand(opts, flags)
	if err != nil {
		return nil, foundation.CallerConfig{}, err
	}
	for _, caller := range runtime.Config.Callers {
		if caller.Name == name {
			if strings.TrimSpace(caller.CallerID) == "" {
				return nil, foundation.CallerConfig{}, foundation.NewAppError(foundation.CodeConfig, "Selected caller is missing caller_id in local config.")
			}
			return runtime, caller, nil
		}
	}
	return nil, foundation.CallerConfig{}, foundation.NewAppError(foundation.CodeUnknownCaller, "Selected caller is not present in local config; run agent-outbox caller list or agent-outbox caller connect <caller>.")
}

func writableSecretStoreForCommand(opts Options) (foundation.CallerSecretStore, error) {
	if opts.SecretStore != nil {
		store, ok := opts.SecretStore.(foundation.CallerSecretStore)
		if !ok {
			return nil, foundation.NewSecretStoreError("Configured local secret store cannot write caller credentials.")
		}
		return store, nil
	}
	paths, err := foundation.DefaultPathsFromOS()
	if err != nil {
		return nil, foundation.WrapConfigError("Could not determine local Agent Outbox secret-store path.", err)
	}
	if err := foundation.EnsureOwnerOnlyAppDir(filepath.Dir(paths.SecretsPath)); err != nil {
		return nil, foundation.WrapSecretStoreError("Could not prepare local Agent Outbox secret-store directory.", err)
	}
	masterKey, err := foundation.LoadOrCreateMasterKey(foundation.GoKeyring{}, nil)
	if err != nil {
		return nil, err
	}
	return foundation.NewEncryptedCallerSecretStore(paths.SecretsPath, masterKey)
}

func runBrowserConnect(ctx context.Context, opts Options, runtime *controlPlaneRuntime, localName string) (connectExchangeData, error) {
	setup, err := runBrowserFlow(ctx, opts, "connect", func(callbackURL string) (browserStartData, error) {
		var started browserStartData
		_, err := runtime.Client.Do(ctx, http.MethodPost, "/api/caller/connect/browser/start", "", map[string]string{
			"local_caller_name": localName,
			"display_name":      localName,
			"callback_url":      callbackURL,
		}, &started)
		return started, err
	})
	if err != nil {
		return connectExchangeData{}, err
	}
	var result connectExchangeData
	_, err = runtime.Client.Do(ctx, http.MethodPost, "/api/caller/connect/exchange", "", map[string]string{"setup_code": setup.SetupCode}, &result)
	return result, err
}

func runDeviceConnect(ctx context.Context, opts Options, runtime *controlPlaneRuntime, localName string) (connectExchangeData, error) {
	var started deviceStartData
	if _, err := runtime.Client.Do(ctx, http.MethodPost, "/api/caller/connect/device/start", "", map[string]string{
		"local_caller_name": localName,
		"display_name":      localName,
	}, &started); err != nil {
		return connectExchangeData{}, err
	}
	printDeviceInstructions(opts.Stderr, "connect", started)
	interval := started.PollIntervalSeconds
	if interval <= 0 {
		interval = defaultDevicePollIntervalSeconds
	}
	deadline, err := deviceApprovalDeadline(started.ExpiresAt, nowForCommand(opts))
	if err != nil {
		return connectExchangeData{}, err
	}
	for {
		pollCtx, cancelPoll, err := deviceApprovalPollContext(ctx, deadline, nowForCommand(opts))
		if err != nil {
			return connectExchangeData{}, err
		}
		var result connectExchangeData
		_, err = runtime.Client.Do(pollCtx, http.MethodPost, "/api/caller/connect/device/poll", "", map[string]string{"device_code": started.DeviceCode}, &result)
		err = deviceApprovalPollError(ctx, pollCtx, err)
		cancelPoll()
		if err == nil {
			return result, nil
		}
		delay, pending := authorizationPendingDelay(err, interval)
		if !pending {
			return connectExchangeData{}, err
		}
		sleepDuration, err := deviceApprovalSleepDuration(deadline, nowForCommand(opts), time.Duration(delay)*time.Second)
		if err != nil {
			return connectExchangeData{}, err
		}
		if err := sleepForCommand(ctx, opts, sleepDuration); err != nil {
			return connectExchangeData{}, err
		}
	}
}

func runBrowserSetupCodeFlow(ctx context.Context, opts Options, runtime *controlPlaneRuntime, selected foundation.CallerConfig, operation string, startPath string) (deviceSetupCodeData, error) {
	callback, err := runBrowserFlow(ctx, opts, operation, func(callbackURL string) (browserStartData, error) {
		var started browserStartData
		_, err := runtime.Client.Do(ctx, http.MethodPost, startPath, "", map[string]string{
			"caller_id":         selected.CallerID,
			"local_caller_name": selected.Name,
			"callback_url":      callbackURL,
		}, &started)
		return started, err
	})
	if err != nil {
		return deviceSetupCodeData{}, err
	}
	return deviceSetupCodeData{
		SetupRequestID: callback.SetupRequestID,
		SetupCode:      callback.SetupCode,
	}, nil
}

func runDeviceSetupCodeFlow(ctx context.Context, opts Options, runtime *controlPlaneRuntime, selected foundation.CallerConfig, operation string, startPath string, pollPath string) (deviceSetupCodeData, error) {
	var started deviceStartData
	if _, err := runtime.Client.Do(ctx, http.MethodPost, startPath, "", map[string]string{
		"caller_id":         selected.CallerID,
		"local_caller_name": selected.Name,
	}, &started); err != nil {
		return deviceSetupCodeData{}, err
	}
	printDeviceInstructions(opts.Stderr, operation, started)
	interval := started.PollIntervalSeconds
	if interval <= 0 {
		interval = defaultDevicePollIntervalSeconds
	}
	deadline, err := deviceApprovalDeadline(started.ExpiresAt, nowForCommand(opts))
	if err != nil {
		return deviceSetupCodeData{}, err
	}
	for {
		pollCtx, cancelPoll, err := deviceApprovalPollContext(ctx, deadline, nowForCommand(opts))
		if err != nil {
			return deviceSetupCodeData{}, err
		}
		var result deviceSetupCodeData
		_, err = runtime.Client.Do(pollCtx, http.MethodPost, pollPath, "", map[string]string{"device_code": started.DeviceCode}, &result)
		err = deviceApprovalPollError(ctx, pollCtx, err)
		cancelPoll()
		if err == nil {
			return result, nil
		}
		delay, pending := authorizationPendingDelay(err, interval)
		if !pending {
			return deviceSetupCodeData{}, err
		}
		sleepDuration, err := deviceApprovalSleepDuration(deadline, nowForCommand(opts), time.Duration(delay)*time.Second)
		if err != nil {
			return deviceSetupCodeData{}, err
		}
		if err := sleepForCommand(ctx, opts, sleepDuration); err != nil {
			return deviceSetupCodeData{}, err
		}
	}
}

func exchangeStoreAndActivateRotate(ctx context.Context, runtime *controlPlaneRuntime, selected foundation.CallerConfig, setup deviceSetupCodeData) (rotateExchangeData, rotateActivateData, error) {
	var exchanged rotateExchangeData
	if _, err := runtime.Client.Do(ctx, http.MethodPost, "/api/caller/rotate/exchange", "", map[string]string{"setup_code": setup.SetupCode}, &exchanged); err != nil {
		return rotateExchangeData{}, rotateActivateData{}, err
	}
	replacementKey := exchanged.ReplacementCredential.APIKey
	if strings.TrimSpace(replacementKey) == "" {
		return rotateExchangeData{}, rotateActivateData{}, foundation.NewAppError(foundation.CodeValidationFailed, "Agent Outbox API did not return a replacement credential.")
	}

	oldKey, oldKeyErr := runtime.Secrets.LoadCallerKey(selected.CallerID)
	if err := runtime.Secrets.StoreCallerKey(selected.CallerID, replacementKey); err != nil {
		_, _ = runtime.Client.Do(ctx, http.MethodPost, "/api/caller/rotate/abort", replacementKey, map[string]string{"setup_request_id": setup.SetupRequestID}, nil)
		return rotateExchangeData{}, rotateActivateData{}, err
	}

	updatedConfig := cloneConfig(runtime.Config)
	upsertCallerConfig(&updatedConfig, selected.Name, exchanged.Caller, exchanged.Account, exchanged.ReplacementCredential)
	if err := saveRuntimeConfig(runtime, updatedConfig); err != nil {
		restoreCallerSecret(runtime.Secrets, selected.CallerID, oldKey, oldKeyErr)
		_, _ = runtime.Client.Do(ctx, http.MethodPost, "/api/caller/rotate/abort", replacementKey, map[string]string{"setup_request_id": setup.SetupRequestID}, nil)
		return rotateExchangeData{}, rotateActivateData{}, err
	}

	var activated rotateActivateData
	if _, err := runtime.Client.Do(ctx, http.MethodPost, "/api/caller/rotate/activate", replacementKey, map[string]string{"setup_request_id": setup.SetupRequestID}, &activated); err != nil {
		if activateDefinitivelyDidNotCommit(err) {
			restoreCallerSecret(runtime.Secrets, selected.CallerID, oldKey, oldKeyErr)
			if saveErr := saveRuntimeConfig(runtime, runtime.Config); saveErr != nil {
				return rotateExchangeData{}, rotateActivateData{}, rollbackSaveFailureError(err, saveErr)
			}
			return rotateExchangeData{}, rotateActivateData{}, err
		}
		runtime.Config = updatedConfig
		return rotateExchangeData{}, rotateActivateData{}, activateMayBeActiveError(err, "The hosted rotate activation may already have committed; the new local key was kept so the rotation can be verified or reconciled.")
	}
	runtime.Config = updatedConfig
	return exchanged, activated, nil
}

func restoreCallerSecret(store foundation.CallerSecretStore, callerID string, oldKey string, oldKeyErr error) {
	if oldKeyErr == nil && oldKey != "" {
		_ = store.StoreCallerKey(callerID, oldKey)
		return
	}
	_ = store.DeleteCallerKey(callerID)
}

func activateDefinitivelyDidNotCommit(err error) bool {
	var appErr *foundation.AppError
	if !errors.As(err, &appErr) {
		return false
	}
	switch appErr.Code {
	case foundation.CodeInvalidRequest,
		foundation.CodeValidationFailed,
		foundation.CodeAuthenticationRequired,
		foundation.CodeInvalidCallerCredentials,
		foundation.CodeAuthorizationFailed,
		foundation.CodeNotFound:
		return true
	default:
		return false
	}
}

func runRevokeFlow(ctx context.Context, opts Options, runtime *controlPlaneRuntime, selected foundation.CallerConfig, deviceCode bool) (revokeConfirmData, error) {
	var setup deviceSetupCodeData
	var err error
	if deviceCode {
		setup, err = runDeviceSetupCodeFlow(ctx, opts, runtime, selected, "revoke", "/api/caller/revoke/device/start", "/api/caller/revoke/device/poll")
	} else {
		setup, err = runBrowserSetupCodeFlow(ctx, opts, runtime, selected, "revoke", "/api/caller/revoke/browser/start")
	}
	if err != nil {
		return revokeConfirmData{}, err
	}
	var confirmed revokeConfirmData
	_, err = runtime.Client.Do(ctx, http.MethodPost, "/api/caller/revoke/confirm", "", map[string]string{"setup_code": setup.SetupCode}, &confirmed)
	return confirmed, err
}

func runBrowserFlow(ctx context.Context, opts Options, operation string, start func(callbackURL string) (browserStartData, error)) (browserCallbackResult, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return browserCallbackResult{}, foundation.NewAppError(foundation.CodeTemporaryUnavailable, "Could not bind a local callback listener on 127.0.0.1.")
	}
	defer listener.Close()

	callbacks := make(chan browserCallbackResult, 1)
	var expectedSetupRequestID atomic.Value
	expectedSetupRequestID.Store("")
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		expected, _ := expectedSetupRequestID.Load().(string)
		result := callbackResultFromRequest(r, expected)
		if result.Err != nil {
			http.Error(w, "Agent Outbox approval failed. Return to the terminal.", http.StatusBadRequest)
			return
		} else {
			_, _ = io.WriteString(w, "Agent Outbox approval received. Return to the terminal.\n")
		}
		select {
		case callbacks <- result:
		default:
		}
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			select {
			case callbacks <- browserCallbackResult{Err: foundation.NewAppError(foundation.CodeTemporaryUnavailable, "Local callback listener failed.")}:
			default:
			}
		}
	}()
	defer server.Close()

	started, err := start("http://" + listener.Addr().String() + "/callback")
	if err != nil {
		return browserCallbackResult{}, err
	}
	if strings.TrimSpace(started.ApprovalURL) == "" {
		return browserCallbackResult{}, foundation.NewAppError(foundation.CodeValidationFailed, "Agent Outbox API did not return an approval URL.")
	}
	if strings.TrimSpace(started.SetupRequestID) == "" {
		return browserCallbackResult{}, foundation.NewAppError(foundation.CodeValidationFailed, "Agent Outbox API did not return a setup request id.")
	}
	deadline, err := browserApprovalDeadline(started.ExpiresAt, nowForCommand(opts))
	if err != nil {
		return browserCallbackResult{}, err
	}
	expectedSetupRequestID.Store(started.SetupRequestID)
	fmt.Fprintf(opts.Stderr, "%s approval: %s\n", operation, started.ApprovalURL)
	openBrowser := opts.OpenBrowser
	if openBrowser == nil {
		openBrowser = openBrowserURL
	}
	if err := openBrowser(started.ApprovalURL); err != nil {
		fmt.Fprintf(opts.Stderr, "could not open browser automatically; open the approval URL manually: %v\n", err)
	}

	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	select {
	case result := <-callbacks:
		_ = server.Shutdown(context.Background())
		return result, nil
	case <-ctx.Done():
		_ = server.Shutdown(context.Background())
		return browserCallbackResult{}, foundation.NewAppError(foundation.CodeTemporaryUnavailable, "Timed out waiting for browser approval callback.")
	case <-timer.C:
		_ = server.Shutdown(context.Background())
		return browserCallbackResult{}, foundation.NewAppError(foundation.CodeTemporaryUnavailable, "Timed out waiting for browser approval callback before the setup request expired.")
	}
}

func callbackResultFromRequest(r *http.Request, expectedSetupRequestID string) browserCallbackResult {
	query := r.URL.Query()
	status := strings.TrimSpace(query.Get("status"))
	if status != "approved" {
		return browserCallbackResult{Err: foundation.NewAppError(foundation.CodeAuthorizationFailed, "Agent Outbox approval was not completed.")}
	}
	setupRequestID := strings.TrimSpace(query.Get("setup_request_id"))
	if setupRequestID == "" {
		return browserCallbackResult{Err: foundation.NewAppError(foundation.CodeValidationFailed, "Approval callback did not include a setup request id.")}
	}
	if strings.TrimSpace(expectedSetupRequestID) == "" {
		return browserCallbackResult{Err: foundation.NewAppError(foundation.CodeValidationFailed, "Started approval flow did not include a setup request id.")}
	}
	if setupRequestID != expectedSetupRequestID {
		return browserCallbackResult{Err: foundation.NewAppError(foundation.CodeInvalidRequest, "Callback setup request did not match the started approval flow.")}
	}
	setupCode := strings.TrimSpace(query.Get("setup_code"))
	if setupCode == "" {
		return browserCallbackResult{Err: foundation.NewAppError(foundation.CodeValidationFailed, "Approval callback did not include a setup code.")}
	}
	return browserCallbackResult{
		SetupCode:      setupCode,
		SetupRequestID: setupRequestID,
	}
}

func browserApprovalDeadline(expiresAt string, now time.Time) (time.Time, error) {
	expiresAt = strings.TrimSpace(expiresAt)
	if expiresAt == "" {
		return time.Time{}, foundation.NewAppError(foundation.CodeValidationFailed, "Agent Outbox API did not return an approval expiry.")
	}
	expires, err := time.Parse(time.RFC3339, expiresAt)
	if err != nil {
		return time.Time{}, foundation.NewAppError(foundation.CodeValidationFailed, "Agent Outbox API returned an invalid approval expiry.")
	}
	deadline := expires.Add(browserApprovalExpiryGrace)
	if !deadline.After(now) {
		return now, nil
	}
	return deadline, nil
}

func deviceApprovalDeadline(expiresAt string, now time.Time) (time.Time, error) {
	expiresAt = strings.TrimSpace(expiresAt)
	if expiresAt == "" {
		return time.Time{}, foundation.NewAppError(foundation.CodeValidationFailed, "Agent Outbox API did not return a device approval expiry.")
	}
	expires, err := time.Parse(time.RFC3339, expiresAt)
	if err != nil {
		return time.Time{}, foundation.NewAppError(foundation.CodeValidationFailed, "Agent Outbox API returned an invalid device approval expiry.")
	}
	if !expires.After(now) {
		return now, nil
	}
	return expires, nil
}

func deviceApprovalStillOpen(deadline time.Time, now time.Time) error {
	if deadline.After(now) {
		return nil
	}
	return deviceApprovalTimeoutError()
}

func deviceApprovalSleepDuration(deadline time.Time, now time.Time, requested time.Duration) (time.Duration, error) {
	if err := deviceApprovalStillOpen(deadline, now); err != nil {
		return 0, err
	}
	remaining := deadline.Sub(now)
	if requested <= 0 || requested > remaining {
		return remaining, nil
	}
	return requested, nil
}

func deviceApprovalPollContext(ctx context.Context, deadline time.Time, now time.Time) (context.Context, context.CancelFunc, error) {
	if err := deviceApprovalStillOpen(deadline, now); err != nil {
		return nil, nil, err
	}
	pollCtx, cancel := context.WithTimeout(ctx, deadline.Sub(now))
	return pollCtx, cancel, nil
}

func deviceApprovalPollError(parent context.Context, poll context.Context, err error) error {
	if err != nil && poll.Err() != nil && parent.Err() == nil {
		return deviceApprovalTimeoutError()
	}
	return err
}

func deviceApprovalTimeoutError() error {
	return foundation.NewAppError(foundation.CodeTemporaryUnavailable, "Timed out waiting for device approval.")
}

func nowForCommand(opts Options) time.Time {
	if opts.Now != nil {
		return opts.Now()
	}
	return time.Now()
}

func openBrowserURL(rawURL string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", rawURL).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", rawURL).Start()
	default:
		return exec.Command("xdg-open", rawURL).Start()
	}
}

func printDeviceInstructions(w io.Writer, operation string, started deviceStartData) {
	uri := started.VerificationURIComplete
	if strings.TrimSpace(uri) == "" {
		uri = started.VerificationURI
	}
	fmt.Fprintf(w, "%s approval: %s\n", operation, uri)
	if strings.TrimSpace(started.UserCode) != "" {
		fmt.Fprintf(w, "user_code=%s\n", started.UserCode)
	}
}

func authorizationPendingDelay(err error, fallbackSeconds int) (int, bool) {
	var appErr *foundation.AppError
	if !errors.As(err, &appErr) || appErr.Code != foundation.CodeAuthorizationPending {
		return 0, false
	}
	delay := fallbackSeconds
	if appErr.RetryAfterSeconds != nil {
		delay = *appErr.RetryAfterSeconds
	}
	if delay < 1 {
		delay = 1
	}
	return delay, true
}

func sleepForCommand(ctx context.Context, opts Options, duration time.Duration) error {
	if opts.Sleep != nil {
		return opts.Sleep(ctx, duration)
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return foundation.NewAppError(foundation.CodeTemporaryUnavailable, "Stopped while waiting for human approval.")
	}
}

// storeAndActivateConnect mirrors the two-phase rotate flow (exchangeStoreAndActivateRotate)
// for connect: the exchange already returned a PENDING credential, so persist it locally and
// only then confirm activation. There is no old key to preserve, so failure handling is simpler
// than rotate.
func storeAndActivateConnect(ctx context.Context, runtime *controlPlaneRuntime, localName string, result connectExchangeData) (connectActivateData, error) {
	pendingKey := result.Credential.APIKey
	if strings.TrimSpace(pendingKey) == "" {
		return connectActivateData{}, foundation.NewAppError(foundation.CodeValidationFailed, "Agent Outbox API did not return a caller credential.")
	}
	if strings.TrimSpace(result.SetupRequestID) == "" {
		return connectActivateData{}, foundation.NewAppError(foundation.CodeValidationFailed, "Agent Outbox API did not return a setup request id.")
	}

	if err := runtime.Secrets.StoreCallerKey(result.Caller.CallerID, pendingKey); err != nil {
		abortConnectPendingCredential(ctx, runtime, pendingKey, result)
		return connectActivateData{}, err
	}

	updatedConfig := cloneConfig(runtime.Config)
	updatedConfig.BaseURL = runtime.Client.BaseURL
	upsertCallerConfig(&updatedConfig, localName, result.Caller, result.Account, result.Credential)
	if err := saveRuntimeConfig(runtime, updatedConfig); err != nil {
		abortConnectPendingCredential(ctx, runtime, pendingKey, result)
		return connectActivateData{}, err
	}

	var activated connectActivateData
	if _, err := runtime.Client.Do(ctx, http.MethodPost, "/api/caller/connect/activate", pendingKey, map[string]string{"setup_request_id": result.SetupRequestID}, &activated); err != nil {
		if activateDefinitivelyDidNotCommit(err) {
			_ = runtime.Secrets.DeleteCallerKey(result.Caller.CallerID)
			if saveErr := saveRuntimeConfig(runtime, runtime.Config); saveErr != nil {
				return connectActivateData{}, rollbackSaveFailureError(err, saveErr)
			}
			return connectActivateData{}, err
		}
		runtime.Config = updatedConfig
		return connectActivateData{}, activateMayBeActiveError(err, "The hosted connect credential may already be active; the local caller was kept so the connection can be verified or reconciled.")
	}
	runtime.Config = updatedConfig
	return activated, nil
}

// abortConnectPendingCredential is the best-effort cleanup for a local-persistence failure that
// occurs before activation: expire the hosted pending key, then remove any partially stored secret.
// No active hosted key must remain after this returns.
func abortConnectPendingCredential(ctx context.Context, runtime *controlPlaneRuntime, pendingKey string, result connectExchangeData) {
	_, _ = runtime.Client.Do(ctx, http.MethodPost, "/api/caller/connect/abort", pendingKey, map[string]string{"setup_request_id": result.SetupRequestID}, nil)
	_ = runtime.Secrets.DeleteCallerKey(result.Caller.CallerID)
}

// activateMayBeActiveError annotates an ambiguous activate failure (transport/read/decode
// or otherwise not provably-uncommitted) with operator guidance so the caller knows the
// local credential/config was intentionally kept because the hosted credential may already
// be active. The original error code and exit code are preserved so downstream handling is
// unchanged. Both connect and rotate share this so their ambiguous-failure guidance stays
// symmetric.
func activateMayBeActiveError(err error, guidance string) error {
	var appErr *foundation.AppError
	if !errors.As(err, &appErr) {
		return err
	}
	wrapped := *appErr
	wrapped.Message = appErr.Message + " " + guidance
	wrapped.ExitCode = foundation.ExitCodeFor(err)
	return &wrapped
}

// rollbackSaveFailureError annotates a definitively-uncommitted activation error when the
// follow-up local config rollback save also failed, so the operator is warned that local
// caller state may be inconsistent instead of seeing only the activation error. The original
// error code and exit code are preserved.
func rollbackSaveFailureError(activateErr error, saveErr error) error {
	var appErr *foundation.AppError
	if !errors.As(activateErr, &appErr) {
		return activateErr
	}
	wrapped := *appErr
	wrapped.Message = fmt.Sprintf(
		"%s Local config rollback also failed (%v); the local caller may be inconsistent and should be checked.",
		appErr.Message,
		saveErr,
	)
	wrapped.ExitCode = foundation.ExitCodeFor(activateErr)
	return &wrapped
}

func ensureLocalCallerNameAvailable(cfg foundation.Config, localName string) error {
	for _, caller := range cfg.Callers {
		if caller.Name == localName {
			return foundation.NewAppError(foundation.CodeCallerAlreadyExists, "Local caller name is already configured; use agent-outbox caller rotate, agent-outbox caller disconnect, or choose a different caller name.")
		}
	}
	return nil
}

type writablePreflightSecretStore interface {
	PreflightWritable() error
}

func preflightConnectLocalPersistence(runtime *controlPlaneRuntime) error {
	if err := foundation.PreflightConfigWrite(runtime.ConfigPath, runtime.ConfigPathOwned); err != nil {
		return err
	}
	if checker, ok := runtime.Secrets.(writablePreflightSecretStore); ok {
		return checker.PreflightWritable()
	}
	return nil
}

func cloneConfig(cfg foundation.Config) foundation.Config {
	cloned := cfg
	cloned.Callers = append([]foundation.CallerConfig(nil), cfg.Callers...)
	return cloned
}

func upsertCallerConfig(cfg *foundation.Config, localName string, caller callerData, account accountData, credential credentialData) {
	record := foundation.CallerConfig{
		Name:       localName,
		AccountID:  account.AccountID,
		CallerID:   caller.CallerID,
		CallerSlug: caller.CallerSlug,
		KeyID:      credential.KeyID,
		KeyPrefix:  credential.Prefix,
		KeySuffix:  credential.LastChars,
		CreatedAt:  credential.CreatedAt,
		UpdatedAt:  credential.CreatedAt,
	}
	for i, existing := range cfg.Callers {
		if existing.Name == localName {
			if record.CreatedAt == "" {
				record.CreatedAt = existing.CreatedAt
			}
			cfg.Callers[i] = record
			return
		}
	}
	cfg.Callers = append(cfg.Callers, record)
}

func validateLocalCallerRecords(callers []foundation.CallerConfig) error {
	for _, caller := range callers {
		var missing []string
		if strings.TrimSpace(caller.Name) == "" {
			missing = append(missing, "name")
		}
		if strings.TrimSpace(caller.AccountID) == "" {
			missing = append(missing, "account_id")
		}
		if strings.TrimSpace(caller.CallerID) == "" {
			missing = append(missing, "caller_id")
		}
		if strings.TrimSpace(caller.KeyID) == "" {
			missing = append(missing, "key_id")
		}
		if strings.TrimSpace(caller.KeyPrefix) == "" {
			missing = append(missing, "key_prefix")
		}
		if strings.TrimSpace(caller.KeySuffix) == "" {
			missing = append(missing, "key_suffix")
		}
		if len(missing) == 0 {
			continue
		}

		name := strings.TrimSpace(caller.Name)
		if name == "" {
			name = "<unnamed>"
		}
		return foundation.NewAppError(
			foundation.CodeConfig,
			fmt.Sprintf("Local caller config for %s is incomplete (missing %s); run agent-outbox caller connect <caller> to recreate local setup before using agent-outbox caller list.", name, strings.Join(missing, ", ")),
		)
	}
	return nil
}

func removeLocalCaller(runtime *controlPlaneRuntime, selected foundation.CallerConfig) error {
	updated := cloneConfig(runtime.Config)
	next := make([]foundation.CallerConfig, 0, len(updated.Callers))
	for _, caller := range updated.Callers {
		if caller.Name == selected.Name {
			continue
		}
		next = append(next, caller)
	}
	updated.Callers = next
	if err := runtime.Secrets.DeleteCallerKey(selected.CallerID); err != nil && !errors.Is(err, foundation.ErrSecretNotFound) {
		return err
	}
	if err := saveRuntimeConfig(runtime, updated); err != nil {
		return err
	}
	runtime.Config = updated
	return nil
}

func saveRuntimeConfig(runtime *controlPlaneRuntime, cfg foundation.Config) error {
	if runtime.ConfigPathOwned {
		return foundation.SaveConfigInOwnerOnlyDir(runtime.ConfigPath, cfg)
	}
	return foundation.SaveConfig(runtime.ConfigPath, cfg)
}

func sanitizedConnectResult(localName string, result connectExchangeData, activated connectActivateData) map[string]any {
	return map[string]any{
		"local_caller_name": localName,
		"caller":            result.Caller,
		"account":           result.Account,
		"credential":        sanitizedCredential(result.Credential),
		"activation":        activated,
		"connected":         true,
	}
}

func sanitizedRotateResult(localName string, exchanged rotateExchangeData, activated rotateActivateData) map[string]any {
	return map[string]any{
		"local_caller_name":      localName,
		"caller":                 exchanged.Caller,
		"account":                exchanged.Account,
		"replacement_credential": sanitizedCredential(exchanged.ReplacementCredential),
		"replaces_credential":    sanitizedCredential(exchanged.ReplacesCredential),
		"activation":             activated,
		"rotated":                true,
	}
}

func sanitizedRevokeResult(localName string, confirmed revokeConfirmData) map[string]any {
	return map[string]any{
		"local_caller_name": localName,
		"caller_id":         confirmed.CallerID,
		"revoked_key_ids":   confirmed.RevokedKeyIDs,
		"revoked_at":        confirmed.RevokedAt,
		"revoked":           true,
	}
}

func sanitizedCredential(credential credentialData) map[string]any {
	data := map[string]any{
		"key_id":     credential.KeyID,
		"prefix":     credential.Prefix,
		"last_chars": credential.LastChars,
		"created_at": credential.CreatedAt,
	}
	if credential.ExpiresAt != "" {
		data["expires_at"] = credential.ExpiresAt
	}
	return data
}

func formatLocalCaller(caller foundation.CallerConfig) string {
	parts := []string{"name=" + caller.Name}
	if caller.CallerID != "" {
		parts = append(parts, "caller_id="+caller.CallerID)
	}
	if caller.CallerSlug != "" {
		parts = append(parts, "caller_slug="+caller.CallerSlug)
	}
	if caller.AccountID != "" {
		parts = append(parts, "account_id="+caller.AccountID)
	}
	if caller.KeyID != "" {
		parts = append(parts, "key_id="+caller.KeyID)
	}
	if caller.KeySuffix != "" {
		parts = append(parts, "key_suffix="+caller.KeySuffix)
	}
	return strings.Join(parts, " ")
}

func normalizeLocalCallerName(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", foundation.NewUsageError("caller name is required.")
	}
	if strings.ContainsAny(value, "\r\n\t") {
		return "", foundation.NewUsageError("caller name must be a single token.")
	}
	return value, nil
}
