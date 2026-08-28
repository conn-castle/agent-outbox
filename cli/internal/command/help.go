package command

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

type commandHelpSpec struct {
	Purpose     string
	Arguments   string
	Flags       string
	Environment string
	Examples    string
	ExitCodes   string
	RelatedDocs string
}

func documentCommand(cmd *cobra.Command, spec commandHelpSpec) {
	cmd.Long = commandHelp(spec)
	cmd.Example = spec.Examples
}

func commandHelp(spec commandHelpSpec) string {
	return strings.TrimSpace(fmt.Sprintf(`Purpose:
%s

Arguments:
%s

Flags:
%s

Environment:
%s

Examples:
%s

Exit codes:
%s

Related docs:
%s`, spec.Purpose, spec.Arguments, spec.Flags, spec.Environment, spec.Examples, spec.ExitCodes, spec.RelatedDocs))
}

func globalEnvironmentHelp() string {
	return strings.Join([]string{
		"AGENT_OUTBOX_BASE_URL selects the app/API origin unless --base-url is set.",
		"AGENT_OUTBOX_CONFIG_PATH selects the local config path unless --config is set.",
		"AGENT_OUTBOX_CALLER selects the local caller unless --caller is set; setting both is a config error.",
		"AGENT_OUTBOX_API_KEY supplies the selected caller credential instead of reading credentials.json; use a secret manager when setting it.",
		"NO_COLOR is honored by color-capable output; current output is deterministic without color.",
	}, "\n")
}
