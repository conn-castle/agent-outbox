package command

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"agent-outbox/internal/foundation"

	"github.com/spf13/cobra"
)

type Options struct {
	Args   []string
	Stdout io.Writer
	Stderr io.Writer
	Env    foundation.Env

	HTTPClient   *http.Client
	SecretStore  foundation.CallerSecretLoader
	NewRequestID func() string
	OpenBrowser  func(string) error
	Sleep        func(context.Context, time.Duration) error
	Now          func() time.Time
}

type rootFlags struct {
	json    bool
	caller  string
	baseURL string
	config  string
	noColor bool
}

const requiresCallerAnnotation = "agent-outbox.requires-caller"
const bypassRootPreflightAnnotation = "agent-outbox.bypass-root-preflight"

func Execute(ctx context.Context, opts Options) int {
	flags := &rootFlags{}
	cmd := NewRootCommand(opts, flags)
	flags.json = jsonRequested(opts.Args)
	cmd.SetArgs(opts.Args)
	cmd.SetContext(ctx)

	if err := cmd.Execute(); err != nil {
		err = normalizeCommandError(err)
		foundation.RenderError(opts.Stderr, flags.json, err)
		return foundation.ExitCodeFor(err)
	}
	return foundation.ExitSuccess
}

// jsonRequested pre-scans args to pick the output format for errors that occur
// before cobra parses flags. It mirrors pflag's semantics closely enough for
// that early window: stop at the `--` terminator and let the last occurrence win
// (`--json=false --json` => true), rather than returning on the first match.
func jsonRequested(args []string) bool {
	result := false
	for _, arg := range args {
		if arg == "--" {
			break
		}
		if arg == "--json" {
			result = true
			continue
		}
		value, ok := strings.CutPrefix(arg, "--json=")
		if !ok {
			continue
		}
		parsed, err := strconv.ParseBool(value)
		result = err == nil && parsed
	}
	return result
}

func normalizeCommandError(err error) error {
	var appErr *foundation.AppError
	if errors.As(err, &appErr) {
		return err
	}
	return foundation.NewUsageError(err.Error())
}

func NewRootCommand(opts Options, flags *rootFlags) *cobra.Command {
	if opts.Stdout == nil {
		opts.Stdout = io.Discard
	}
	if opts.Stderr == nil {
		opts.Stderr = io.Discard
	}
	if opts.Env == nil {
		opts.Env = foundation.Env{}
	}

	cmd := &cobra.Command{
		Use:   "agent-outbox",
		Short: "Agent Outbox command line client",
		Long: commandHelp(commandHelpSpec{
			Purpose:     "Use Agent Outbox from automation and terminals. The CLI wraps the documented HTTP API for caller, input, output, and account workflows, and includes local utility commands for docs, diagnostics, upgrades, and version metadata.",
			Arguments:   "No root arguments. Run a subcommand such as caller, input, output, account, docs, doctor, upgrade, or version.",
			Flags:       "Global flags: --json for machine-readable output, --config for the local config path, --base-url for the app/API origin, --caller for local caller selection, and --no-color for deterministic terminals.",
			Environment: globalEnvironmentHelp(),
			Examples: strings.Join([]string{
				"agent-outbox caller connect steward-email",
				"agent-outbox output check --json",
				"agent-outbox docs cli",
				"agent-outbox doctor --json",
			}, "\n"),
			ExitCodes:   "0 success. 64 usage. 65 data/schema. 66 not found. 69 upgrade required. 70 software. 73 conflict. 74 secret store. 75 temporary failure. 77 permission. 78 config.",
			RelatedDocs: "docs/spec/README.md, docs/spec/http-api.md, docs/spec/errors.md, and agent-outbox docs cli.",
		}),
		Version:       versionLine(),
		SilenceErrors: true,
		SilenceUsage:  true,
		CompletionOptions: cobra.CompletionOptions{
			DisableDefaultCmd: true,
		},
		PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
			return validateCommandContext(cmd, flags, opts.Env)
		},
		RunE: func(cmd *cobra.Command, _ []string) error {
			return cmd.Help()
		},
	}
	cmd.SetOut(opts.Stdout)
	cmd.SetErr(opts.Stderr)
	cmd.SetVersionTemplate("{{.Version}}\n")
	cmd.SetFlagErrorFunc(func(_ *cobra.Command, err error) error {
		return foundation.NewUsageError(err.Error())
	})

	cmd.PersistentFlags().BoolVar(&flags.json, "json", false, "write machine-readable JSON")
	cmd.PersistentFlags().StringVar(&flags.config, "config", "", "path to local Agent Outbox config file")
	cmd.PersistentFlags().StringVar(&flags.caller, "caller", "", "select a configured local caller")
	cmd.PersistentFlags().StringVar(&flags.baseURL, "base-url", "", "Agent Outbox app/API origin")
	cmd.PersistentFlags().BoolVar(&flags.noColor, "no-color", false, "disable terminal color")

	caller := parentCommand("caller", "Manage local caller configuration")
	input := callerRequiredParentCommand("input", "Submit and inspect input items")
	output := callerRequiredParentCommand("output", "Read and acknowledge output results")
	account := callerRequiredParentCommand("account", "Inspect the selected account")
	documentCommand(caller, commandHelpSpec{
		Purpose:     "Manage local caller setup, status, rotation, revocation, and disconnect state.",
		Arguments:   "Use a caller subcommand. Caller names are local labels stored in the Agent Outbox config.",
		Flags:       "Approval subcommands may add --device-code, --browser, or --revoke. Global --config, --base-url, --caller, --json, and --no-color remain available.",
		Environment: globalEnvironmentHelp(),
		Examples: strings.Join([]string{
			"agent-outbox caller connect steward-email",
			"agent-outbox caller list",
			"agent-outbox caller status --json",
		}, "\n"),
		ExitCodes:   "0 success. 64 usage. 73 caller already exists. 74 secret store. 75 temporary approval/API failure. 77 permission. 78 config or caller selection.",
		RelatedDocs: "docs/spec/http-api.md#caller-connect-control-plane, docs/spec/errors.md, and agent-outbox docs caller.",
	})
	documentCommand(input, commandHelpSpec{
		Purpose:     "Submit, inspect, replace, or delete input items for the selected caller.",
		Arguments:   "Use send, list, read, replace, or delete. Input JSON never includes caller_id; the API derives it from the selected local caller credential.",
		Flags:       "send and replace require --file <input.json>. list supports --page-size, --cursor, and --no-auto-page. Global flags are available.",
		Environment: globalEnvironmentHelp(),
		Examples: strings.Join([]string{
			"agent-outbox input send --file input.json",
			"agent-outbox input list --json",
			"agent-outbox input read email:thread_123",
			"agent-outbox input replace --file input.json --json",
			"agent-outbox input delete email:thread_123",
		}, "\n"),
		ExitCodes:   "0 success. 64 usage. 65 input JSON/schema/safety errors. 66 missing input. 73 live item conflict. 74 secret store. 75 rate/quota/temporary failure. 77 permission. 78 config or caller selection.",
		RelatedDocs: "docs/spec/input-schema.md, docs/spec/http-api.md#input-queue, and agent-outbox docs input.",
	})
	documentCommand(output, commandHelpSpec{
		Purpose:     "Check, read, download files for, and acknowledge output results for the selected caller.",
		Arguments:   "Use check, read, file get, or ack. Output ids and file ids come from Agent Outbox output results.",
		Flags:       "check and read --all support --page-size, --cursor, and --no-auto-page. file get requires --output or --stdout. Global flags are available.",
		Environment: globalEnvironmentHelp(),
		Examples: strings.Join([]string{
			"agent-outbox output check",
			"agent-outbox output read --all --json",
			"agent-outbox output ack out_123",
		}, "\n"),
		ExitCodes:   "0 success. 64 usage. 66 missing output/file. 73 stale or already-read state. 74 secret store. 75 rate/quota/temporary failure. 77 permission. 78 config or caller selection.",
		RelatedDocs: "docs/spec/output-schema.md, docs/spec/http-api.md#output-queue, and agent-outbox docs output.",
	})
	documentCommand(account, commandHelpSpec{
		Purpose:     "Inspect account and tier status using an existing selected local caller credential.",
		Arguments:   "Use account status. There is no browser or device-code fallback for account status.",
		Flags:       "Global --caller, --config, --base-url, --json, and --no-color are available.",
		Environment: globalEnvironmentHelp(),
		Examples:    "agent-outbox account status --json",
		ExitCodes:   "0 success. 74 secret store. 75 temporary API failure. 77 permission. 78 config or caller selection.",
		RelatedDocs: "docs/spec/http-api.md#account-status, docs/spec/errors.md, and agent-outbox docs status.",
	})
	addDataPlaneCommands(caller, input, output, account, opts, flags)
	addControlPlaneCommands(caller, opts, flags)

	cmd.AddCommand(
		caller,
		input,
		output,
		account,
		docsCommand(opts, flags),
		doctorCommand(opts, flags),
		upgradeCommand(opts, flags),
		versionCommand(opts, flags),
	)

	return cmd
}

func validateCommandContext(cmd *cobra.Command, flags *rootFlags, env foundation.Env) error {
	if commandBypassesRootPreflight(cmd) {
		return nil
	}
	cfg, err := loadConfig(flags, env)
	if err != nil {
		return err
	}
	if _, err = foundation.ResolveBaseURL(flags.baseURL, env, cfg); err != nil {
		return err
	}
	if commandRequiresCaller(cmd) {
		_, err = foundation.SelectCaller(flags.caller, env, cfg)
		return err
	}
	return nil
}

func loadConfig(flags *rootFlags, env foundation.Env) (foundation.Config, error) {
	_, cfg, _, err := loadConfigDetails(flags, env)
	return cfg, err
}

func loadConfigDetails(flags *rootFlags, env foundation.Env) (string, foundation.Config, bool, error) {
	defaultPath := ""
	defaultPathSelected := false
	if strings.TrimSpace(flags.config) == "" && strings.TrimSpace(env.Get(foundation.EnvConfigPath)) == "" {
		paths, err := foundation.DefaultPathsFromOS()
		if err != nil {
			return "", foundation.Config{}, false, foundation.WrapConfigError("Could not determine local Agent Outbox config path.", err)
		}
		defaultPath = paths.ConfigPath
		defaultPathSelected = true
	}

	path, err := foundation.ResolveConfigPath(flags.config, env, defaultPath)
	if err != nil {
		return "", foundation.Config{}, false, err
	}
	cfg, err := foundation.LoadConfig(path)
	return path, cfg, defaultPathSelected, err
}

func parentCommand(use string, short string) *cobra.Command {
	return &cobra.Command{
		Use:           use,
		Short:         short,
		Args:          noArgs,
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return cmd.Help()
		},
	}
}

func callerRequiredParentCommand(use string, short string) *cobra.Command {
	return requireCaller(parentCommand(use, short))
}

func requireCaller(cmd *cobra.Command) *cobra.Command {
	annotateCommand(cmd, requiresCallerAnnotation, "true")
	return cmd
}

func bypassRootPreflight(cmd *cobra.Command) *cobra.Command {
	annotateCommand(cmd, bypassRootPreflightAnnotation, "true")
	return cmd
}

func commandRequiresCaller(cmd *cobra.Command) bool {
	for current := cmd; current != nil; current = current.Parent() {
		if current.Annotations[requiresCallerAnnotation] == "true" {
			return true
		}
	}
	return false
}

func commandBypassesRootPreflight(cmd *cobra.Command) bool {
	for current := cmd; current != nil; current = current.Parent() {
		if current.Annotations[bypassRootPreflightAnnotation] == "true" {
			return true
		}
	}
	return false
}

func annotateCommand(cmd *cobra.Command, key string, value string) {
	if cmd.Annotations == nil {
		cmd.Annotations = map[string]string{}
	}
	cmd.Annotations[key] = value
}

func noArgs(cmd *cobra.Command, args []string) error {
	if err := cobra.NoArgs(cmd, args); err != nil {
		return foundation.NewUsageError(err.Error())
	}
	return nil
}
