package command

import (
	"fmt"
	"strings"

	"agent-outbox/internal/foundation"

	"github.com/spf13/cobra"
)

type docsTopic struct {
	Name        string   `json:"name"`
	Title       string   `json:"title"`
	Summary     string   `json:"summary,omitempty"`
	Body        string   `json:"body"`
	RelatedDocs []string `json:"related_docs"`
}

type docsTopicSummary struct {
	Name    string `json:"name"`
	Summary string `json:"summary"`
}

var terminalDocs = []docsTopic{
	{
		Name:    "cli",
		Title:   "CLI Model",
		Summary: "Command model, stdout/stderr, JSON, config flags, and exit codes.",
		Body: strings.Join([]string{
			"Agent Outbox CLI commands are line-oriented wrappers over the documented HTTP API plus local utility commands.",
			"stdout is for command results. stderr is for diagnostics, warnings, progress, and errors.",
			"--json prints stable machine-readable success payloads for noninteractive commands. JSON errors use the shared error envelope.",
			"Global selection flags are --config, --base-url, and --caller. Environment fallbacks are AGENT_OUTBOX_CONFIG_PATH, AGENT_OUTBOX_BASE_URL, and AGENT_OUTBOX_CALLER.",
			"Caller API keys are stored in an owner-only credentials.json file beside config.json, or supplied through AGENT_OUTBOX_API_KEY by a secret manager. They are never stored in config, docs, diagnostics, or JSON metadata.",
		}, "\n"),
		RelatedDocs: []string{"docs/spec/README.md", "docs/spec/errors.md", "docs/agent-layer/COMMANDS.md"},
	},
	{
		Name:    "caller",
		Title:   "Caller Commands",
		Summary: "Connect, list, status, rotate, revoke, and disconnect local callers.",
		Body: strings.Join([]string{
			"caller connect <caller> starts human-approved setup and stores a display-once caller credential locally after approval.",
			"Approval opens in a browser on desktops and automatically uses a device code in SSH, CI, or headless Linux sessions; --browser and --device-code override detection.",
			"caller list reads only local config. It does not query remote account callers.",
			"caller status uses the selected local caller credential and GET /api/caller/status.",
			"caller rotate and caller revoke require human approval. Rotate activates the new hosted key only after local persistence succeeds.",
			"caller disconnect removes local caller state and can optionally revoke hosted credentials first with --revoke.",
		}, "\n"),
		RelatedDocs: []string{"docs/spec/http-api.md#caller-connect-control-plane", "docs/spec/errors.md"},
	},
	{
		Name:    "input",
		Title:   "Input Commands",
		Summary: "Submit, replace, delete, and validate review input items.",
		Body: strings.Join([]string{
			"input send --file <input.json> submits a retry-safe pending item through POST /api/input/send.",
			"input replace --file <input.json> updates an existing pending item through POST /api/input/replace.",
			"input delete <caller_item_id> removes only pending work through POST /api/input/delete.",
			"Input files must be JSON objects and must not include caller_id; caller identity is derived from the selected bearer credential.",
			"Local validation catches missing required fields, oversized payloads, and clearly unsafe HTML before the network request when practical.",
		}, "\n"),
		RelatedDocs: []string{"docs/spec/input-schema.md", "docs/spec/http-api.md#input-queue"},
	},
	{
		Name:    "output",
		Title:   "Output Commands",
		Summary: "Check, read, read-all, download file bytes, and acknowledge output.",
		Body: strings.Join([]string{
			"output check reads readiness metadata without marking output read.",
			"output read <output_result_id> returns one result and marks that result read.",
			"output read --all auto-pages by default, marks only returned results read, and preserves unavailable output metadata in JSON mode.",
			"In text mode, read-all prints only a filename-free warning count when file metadata is temporarily unavailable.",
			"output file get <output_result_id> <file_id> requires --output or --stdout; --output refuses overwrite unless --force is set.",
			"output ack <output_result_id> should run only after caller-owned downstream handling is durable.",
		}, "\n"),
		RelatedDocs: []string{"docs/spec/output-schema.md", "docs/spec/http-api.md#output-queue"},
	},
	{
		Name:    "status",
		Title:   "Status And Diagnostics",
		Summary: "Caller/account status commands and doctor checks.",
		Body: strings.Join([]string{
			"caller status uses GET /api/caller/status for selected caller health plus account metadata.",
			"account status uses GET /api/account/status with an existing local caller credential; it does not start browser setup.",
			"doctor checks config path, config file, base URL, caller selection, secret loading, caller status, and account status in deterministic order.",
			"Missing default config or ambiguous local caller selection is reported as a warning, not a root preflight abort.",
		}, "\n"),
		RelatedDocs: []string{"docs/spec/http-api.md#caller-status", "docs/spec/http-api.md#account-status", "docs/spec/errors.md"},
	},
	{
		Name:    "errors",
		Title:   "Errors And Exit Codes",
		Summary: "API error envelope and CLI exit-code mapping.",
		Body: strings.Join([]string{
			"JSON errors have ok=false and an error object with a stable code, message, and optional request/correlation ids.",
			"Exit codes are stable for agent branching: 64 usage, 65 data, 66 not found, 69 upgrade required, 70 software, 73 conflict, 74 secret store, 75 temporary, 77 permission, and 78 config.",
			"API error metadata may include field errors, retry-after seconds, limit details, and upgrade metadata.",
			"Errors and diagnostics must not include caller API keys, file bytes, raw review HTML, full request bodies, or bearer headers.",
		}, "\n"),
		RelatedDocs: []string{"docs/spec/errors.md"},
	},
	{
		Name:    "upgrade",
		Title:   "Upgrade Command",
		Summary: "Hosted upgrade page and CLI billing boundary.",
		Body: strings.Join([]string{
			"upgrade resolves the selected app origin from --base-url, AGENT_OUTBOX_BASE_URL, config base_url, then the default origin.",
			"It prints and opens <origin>/upgrade in human mode. Browser-open failure is a warning because the URL is still printed.",
			"upgrade --json does not open a browser and returns the URL with open_attempted=false and opened=false.",
			"The command does not implement Stripe checkout, billing portal behavior, or a status-response upgrade URL.",
		}, "\n"),
		RelatedDocs: []string{"docs/spec/README.md", "docs/spec/errors.md"},
	},
}

func docsCommand(opts Options, flags *rootFlags) *cobra.Command {
	cmd := &cobra.Command{
		Use:           "docs [topic]",
		Short:         "Print built-in Agent Outbox terminal documentation",
		Args:          cobra.MaximumNArgs(1),
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(_ *cobra.Command, args []string) error {
			if len(args) == 0 {
				return renderDocsIndex(opts, flags)
			}
			topic, ok := findDocsTopic(args[0])
			if !ok {
				return foundation.NewUsageError("Unknown docs topic; run agent-outbox docs to list topics.")
			}
			if flags.json {
				return renderJSON(opts.Stdout, map[string]any{"topic": topic})
			}
			_, _ = fmt.Fprintf(opts.Stdout, "%s\n\n%s\n\nRelated docs:\n", topic.Title, topic.Body)
			for _, related := range topic.RelatedDocs {
				_, _ = fmt.Fprintf(opts.Stdout, "- %s\n", related)
			}
			return nil
		},
	}
	documentCommand(cmd, commandHelpSpec{
		Purpose:     "Print short built-in docs for the CLI without requiring network access, config, base URL, or caller credentials.",
		Arguments:   "Optional topic. Valid topics: cli, caller, input, output, status, errors, upgrade.",
		Flags:       "--json prints topics[] with name and summary, or topic with name, title, body, and related_docs. Global selection flags are accepted but ignored.",
		Environment: "No Agent Outbox environment variables are required. This command bypasses config, base URL, and caller preflight.",
		Examples:    "agent-outbox docs\nagent-outbox docs cli\nagent-outbox docs errors --json",
		ExitCodes:   "0 success. 64 unknown topic or invalid usage. 70 local rendering failure.",
		RelatedDocs: "docs/spec/README.md and the topic-specific related docs printed by this command.",
	})
	return bypassRootPreflight(cmd)
}

func renderDocsIndex(opts Options, flags *rootFlags) error {
	topics := make([]docsTopicSummary, 0, len(terminalDocs))
	for _, topic := range terminalDocs {
		topics = append(topics, docsTopicSummary{Name: topic.Name, Summary: topic.Summary})
	}
	if flags.json {
		return renderJSON(opts.Stdout, map[string]any{"topics": topics})
	}
	for _, topic := range topics {
		_, _ = fmt.Fprintf(opts.Stdout, "%s\t%s\n", topic.Name, topic.Summary)
	}
	return nil
}

func findDocsTopic(name string) (docsTopic, bool) {
	name = strings.ToLower(strings.TrimSpace(name))
	for _, topic := range terminalDocs {
		if topic.Name == name {
			return topic, true
		}
	}
	return docsTopic{}, false
}
