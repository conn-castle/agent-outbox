package command

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"runtime"

	"agent-outbox/internal/foundation"

	"github.com/spf13/cobra"
)

var (
	version = "0.0.0-dev"
	commit  = "unknown"
	date    = "unknown"
)

type versionPayload struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	Date      string `json:"date"`
	GoVersion string `json:"go_version"`
}

func versionCommand(opts Options, flags *rootFlags) *cobra.Command {
	cmd := &cobra.Command{
		Use:           "version",
		Short:         "Print Agent Outbox CLI version metadata",
		Args:          noArgs,
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(_ *cobra.Command, _ []string) error {
			if flags.json {
				return renderJSON(opts.Stdout, versionData())
			}
			return writeCommandOutput(opts.Stdout, []byte(versionLine()+"\n"))
		},
	}
	documentCommand(cmd, commandHelpSpec{
		Purpose:     "Print CLI build metadata. Use --version for the same concise human line, and version --json for machine-readable metadata.",
		Arguments:   "None.",
		Flags:       "--json prints version, commit, date, and go_version. Global --config, --base-url, and --caller are accepted but ignored by this local utility.",
		Environment: "No Agent Outbox environment variables are required. This command bypasses config, base URL, and caller preflight.",
		Examples:    "agent-outbox version\nagent-outbox version --json\nagent-outbox --version",
		ExitCodes:   "0 success. 64 usage. 75 local output write failure.",
		RelatedDocs: "docs/agent-layer/COMMANDS.md and agent-outbox docs cli.",
	})
	return bypassRootPreflight(cmd)
}

func versionData() versionPayload {
	return versionPayload{
		Version:   version,
		Commit:    commit,
		Date:      date,
		GoVersion: runtime.Version(),
	}
}

func versionLine() string {
	return fmt.Sprintf("agent-outbox %s (%s, %s, %s)", version, commit, date, runtime.Version())
}

func renderJSON(w io.Writer, payload any) error {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(payload); err != nil {
		return err
	}
	return writeCommandOutput(w, out.Bytes())
}

// writeCommandOutput writes a command's primary result to stdout and reports a
// failed write as local stream I/O failure instead of success.
func writeCommandOutput(w io.Writer, output []byte) error {
	if _, err := w.Write(output); err != nil {
		return foundation.NewAppError(foundation.CodeLocalIO, "Could not write command output.")
	}
	return nil
}
