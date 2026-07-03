package command

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"agent-outbox/internal/foundation"

	"github.com/spf13/cobra"
)

type upgradePayload struct {
	URL           string `json:"url"`
	OpenAttempted bool   `json:"open_attempted"`
	Opened        bool   `json:"opened"`
}

func upgradeCommand(opts Options, flags *rootFlags) *cobra.Command {
	cmd := &cobra.Command{
		Use:           "upgrade",
		Short:         "Open the hosted Agent Outbox upgrade page",
		Args:          noArgs,
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(_ *cobra.Command, _ []string) error {
			upgradeURL, err := resolveUpgradeURL(flags, opts.Env)
			if err != nil {
				return err
			}
			if flags.json {
				return renderJSON(opts.Stdout, upgradePayload{URL: upgradeURL, OpenAttempted: false, Opened: false})
			}

			_, _ = fmt.Fprintln(opts.Stdout, upgradeURL)
			openBrowser := opts.OpenBrowser
			if openBrowser == nil {
				openBrowser = openBrowserURL
			}
			if err := openBrowser(upgradeURL); err != nil {
				_, _ = fmt.Fprintf(opts.Stderr, "could not open browser automatically; open the upgrade URL manually: %v\n", err)
			}
			return nil
		},
	}
	documentCommand(cmd, commandHelpSpec{
		Purpose:   "Resolve the selected Agent Outbox app origin and open its hosted upgrade page. Billing implementation and paid file upload remain hosted app behavior, not CLI logic.",
		Arguments: "None.",
		Flags:     "--json prints the URL without opening a browser. --base-url and --config influence origin resolution. --caller is accepted but ignored.",
		Environment: strings.Join([]string{
			"AGENT_OUTBOX_BASE_URL selects the app origin unless --base-url is set.",
			"AGENT_OUTBOX_CONFIG_PATH selects the config path unless --config is set.",
			"AGENT_OUTBOX_CALLER is ignored; upgrade does not require a local caller.",
		}, "\n"),
		Examples:    "agent-outbox upgrade\nagent-outbox --base-url http://localhost:38000 upgrade\nagent-outbox upgrade --json",
		ExitCodes:   "0 success, including browser-open warning after the URL is printed. 64 usage. 78 invalid base URL or explicit/existing config.",
		RelatedDocs: "docs/spec/README.md, docs/spec/errors.md, and agent-outbox docs upgrade.",
	})
	return bypassRootPreflight(cmd)
}

func resolveUpgradeURL(flags *rootFlags, env foundation.Env) (string, error) {
	cfg, err := loadConfigAllowMissingDefault(flags, env)
	if err != nil {
		return "", err
	}
	baseURL, err := foundation.ResolveBaseURL(flags.baseURL, env, cfg)
	if err != nil {
		return "", err
	}
	return baseURL + "/upgrade", nil
}

func loadConfigAllowMissingDefault(flags *rootFlags, env foundation.Env) (foundation.Config, error) {
	path, explicit, err := resolvedOptionalConfigPath(flags, env)
	if err != nil {
		return foundation.Config{}, err
	}
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) && !explicit {
			return foundation.Config{Version: foundation.ConfigVersion}, nil
		}
		if errors.Is(err, os.ErrNotExist) {
			return foundation.Config{}, foundation.WrapConfigError("Selected Agent Outbox config file does not exist.", err)
		}
		return foundation.Config{}, foundation.WrapConfigError("Could not inspect local Agent Outbox config.", err)
	}
	return foundation.LoadConfig(path)
}

func resolvedOptionalConfigPath(flags *rootFlags, env foundation.Env) (string, bool, error) {
	explicit := strings.TrimSpace(flags.config) != "" || strings.TrimSpace(env.Get(foundation.EnvConfigPath)) != ""
	defaultPath := ""
	if !explicit {
		paths, err := foundation.DefaultPathsFromOS()
		if err != nil {
			return "", false, foundation.WrapConfigError("Could not determine local Agent Outbox config path.", err)
		}
		defaultPath = paths.ConfigPath
	}
	path, err := foundation.ResolveConfigPath(flags.config, env, defaultPath)
	if err != nil {
		return "", explicit, err
	}
	return path, explicit, nil
}
