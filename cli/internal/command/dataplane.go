package command

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"agent-outbox/internal/foundation"

	"github.com/spf13/cobra"
)

const inputPayloadLimitBytes = 128000

type apiRuntime struct {
	Client foundation.APIClient
	Bearer string
}

type successEnvelope struct {
	OK            bool                `json:"ok"`
	RequestID     string              `json:"request_id,omitempty"`
	CorrelationID string              `json:"correlation_id,omitempty"`
	Data          any                 `json:"data"`
	Pagination    *paginationMetadata `json:"pagination,omitempty"`
}

type paginationMetadata struct {
	Complete      bool    `json:"complete"`
	HasMore       bool    `json:"has_more"`
	NextCursor    *string `json:"next_cursor"`
	PageCount     int     `json:"page_count"`
	RequestCount  int     `json:"request_count"`
	ReturnedCount int     `json:"returned_count"`
	PageLimit     int     `json:"page_limit"`
}

type pageFlags struct {
	PageSize   int
	Cursor     string
	NoAutoPage bool
}

type outputPage struct {
	Items         []json.RawMessage `json:"items"`
	ReadyCount    *int              `json:"ready_count,omitempty"`
	HasMore       bool              `json:"has_more"`
	NextCursor    *string           `json:"next_cursor"`
	ReturnedCount int               `json:"returned_count"`
	PageLimit     int               `json:"page_limit"`
}

type paginatedData struct {
	Items      []json.RawMessage `json:"items"`
	ReadyCount *int              `json:"ready_count,omitempty"`
}

type paginatedResult struct {
	Data       paginatedData
	Pagination paginationMetadata
}

type fileGetFlags struct {
	OutputPath string
	Stdout     bool
	Force      bool
}

func addDataPlaneCommands(caller *cobra.Command, input *cobra.Command, output *cobra.Command, account *cobra.Command, opts Options, flags *rootFlags) {
	caller.AddCommand(requireCaller(apiGetCommand("status", "Show selected caller status", "/api/caller/status", opts, flags)))

	input.AddCommand(inputJSONFileCommand("send", "Submit a new input item", "/api/input/send", opts, flags))
	input.AddCommand(inputJSONFileCommand("replace", "Replace a pending input item", "/api/input/replace", opts, flags))
	input.AddCommand(inputDeleteCommand(opts, flags))

	output.AddCommand(outputCheckCommand(opts, flags))
	output.AddCommand(outputReadCommand(opts, flags))
	file := parentCommand("file", "Download output files")
	documentCommand(file, commandHelpSpec{
		Purpose:     "Group output file download commands. File bytes are retrieved only through the dedicated raw-byte endpoint.",
		Arguments:   "Use file get with an output_result_id and file_id.",
		Flags:       "Subcommands define file destination flags. Global --caller, --config, --base-url, --json, and --no-color are available.",
		Environment: globalEnvironmentHelp(),
		Examples:    "agent-outbox output file get out_123 file_456 --output answer.bin",
		ExitCodes:   "0 success. 64 usage. 66 missing output/file. 74 secret store. 75 temporary API/local file failure. 77 permission. 78 config or caller selection.",
		RelatedDocs: "docs/spec/output-schema.md#file-download and agent-outbox docs output.",
	})
	file.AddCommand(outputFileGetCommand(opts, flags))
	output.AddCommand(file)
	output.AddCommand(outputAckCommand(opts, flags))

	account.AddCommand(apiGetCommand("status", "Show selected account status", "/api/account/status", opts, flags))
}

func apiGetCommand(use string, short string, apiPath string, opts Options, flags *rootFlags) *cobra.Command {
	cmd := &cobra.Command{
		Use:           use,
		Short:         short,
		Args:          noArgs,
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			runtime, err := runtimeForCommand(opts, flags)
			if err != nil {
				return err
			}
			var data json.RawMessage
			meta, err := runtime.Client.Do(cmd.Context(), http.MethodGet, apiPath, runtime.Bearer, nil, &data)
			if err != nil {
				return err
			}
			return renderRawSuccess(opts.Stdout, flags.json, meta, data)
		},
	}
	related := "docs/spec/http-api.md and docs/spec/errors.md."
	exampleCommand := use
	if apiPath == "/api/caller/status" {
		related = "docs/spec/http-api.md#caller-status, docs/spec/errors.md, and agent-outbox docs status."
		exampleCommand = "caller status"
	} else if apiPath == "/api/account/status" {
		related = "docs/spec/http-api.md#account-status, docs/spec/errors.md, and agent-outbox docs status."
		exampleCommand = "account status"
	}
	documentCommand(cmd, commandHelpSpec{
		Purpose:     short + " by calling " + apiPath + " with the selected local caller credential.",
		Arguments:   "None. Select the local caller with --caller, AGENT_OUTBOX_CALLER, or the single configured caller.",
		Flags:       "--json prints the API data in the shared success envelope. Global --caller, --config, --base-url, and --no-color are available.",
		Environment: globalEnvironmentHelp(),
		Examples:    "agent-outbox " + exampleCommand + "\nagent-outbox " + exampleCommand + " --json",
		ExitCodes:   "0 success. 74 secret-store failure. 75 temporary API failure. 77 permission/auth failure. 78 config or caller selection.",
		RelatedDocs: related,
	})
	return cmd
}

func inputJSONFileCommand(use string, short string, apiPath string, opts Options, flags *rootFlags) *cobra.Command {
	var filePath string
	cmd := &cobra.Command{
		Use:           use + " --file <input.json>",
		Short:         short,
		Args:          noArgs,
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			body, err := readInputSubmissionFile(filePath)
			if err != nil {
				return err
			}
			runtime, err := runtimeForCommand(opts, flags)
			if err != nil {
				return err
			}
			var data json.RawMessage
			meta, err := runtime.Client.Do(cmd.Context(), http.MethodPost, apiPath, runtime.Bearer, body, &data)
			if err != nil {
				return err
			}
			return renderRawSuccess(opts.Stdout, flags.json, meta, data)
		},
	}
	cmd.Flags().StringVar(&filePath, "file", "", "input submission JSON file")
	documentCommand(cmd, commandHelpSpec{
		Purpose:     short + " by reading an input submission JSON file, validating local invariants, then posting it to " + apiPath + ".",
		Arguments:   "None; the input item is read from --file.",
		Flags:       "--file <input.json> is required. --json prints the API response in the shared success envelope. Global --caller, --config, --base-url, and --no-color are available.",
		Environment: globalEnvironmentHelp(),
		Examples:    "agent-outbox input " + use + " --file input.json\nagent-outbox input " + use + " --file input.json --json",
		ExitCodes:   "0 success. 64 usage. 65 invalid JSON/schema/safety errors. 73 live item conflict. 74 secret store. 75 rate/quota/temporary failure. 77 permission. 78 config or caller selection.",
		RelatedDocs: "docs/spec/input-schema.md, docs/spec/http-api.md#input-queue, docs/spec/errors.md, and agent-outbox docs input.",
	})
	return cmd
}

func inputDeleteCommand(opts Options, flags *rootFlags) *cobra.Command {
	cmd := &cobra.Command{
		Use:           "delete <caller_item_id>",
		Short:         "Delete a pending input item",
		Args:          exactArgs(1),
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(cmd *cobra.Command, args []string) error {
			callerItemID := strings.TrimSpace(args[0])
			if callerItemID == "" {
				return foundation.NewUsageError("caller_item_id is required.")
			}
			runtime, err := runtimeForCommand(opts, flags)
			if err != nil {
				return err
			}
			var data json.RawMessage
			meta, err := runtime.Client.Do(
				cmd.Context(),
				http.MethodPost,
				"/api/input/delete",
				runtime.Bearer,
				map[string]string{"caller_item_id": callerItemID},
				&data,
			)
			if err != nil {
				return err
			}
			return renderRawSuccess(opts.Stdout, flags.json, meta, data)
		},
	}
	documentCommand(cmd, commandHelpSpec{
		Purpose:     "Delete a pending input item for the selected caller through POST /api/input/delete.",
		Arguments:   "<caller_item_id> is the caller-owned id of the pending input item to delete.",
		Flags:       "--json prints the API response in the shared success envelope. Global --caller, --config, --base-url, and --no-color are available.",
		Environment: globalEnvironmentHelp(),
		Examples:    "agent-outbox input delete email:thread_123\nagent-outbox input delete email:thread_123 --json",
		ExitCodes:   "0 success. 64 usage. 66 not found. 73 input not pending. 74 secret store. 75 rate/quota/temporary failure. 77 permission. 78 config or caller selection.",
		RelatedDocs: "docs/spec/input-schema.md#input-semantics, docs/spec/http-api.md#input-queue, docs/spec/errors.md, and agent-outbox docs input.",
	})
	return cmd
}

func outputCheckCommand(opts Options, flags *rootFlags) *cobra.Command {
	page := pageFlags{PageSize: 25}
	cmd := &cobra.Command{
		Use:           "check",
		Short:         "Check ready output without marking it read",
		Args:          noArgs,
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			runtime, err := runtimeForCommand(opts, flags)
			if err != nil {
				return err
			}
			result, err := fetchOutputPages(cmd.Context(), runtime, "check", page)
			if err != nil {
				return err
			}
			warnUnreadPagesLeft(opts.Stderr, result.Pagination)
			return renderPaginatedSuccess(opts.Stdout, flags.json, result)
		},
	}
	addPageFlags(cmd, &page)
	documentCommand(cmd, commandHelpSpec{
		Purpose:     "Check ready output metadata without marking results read. Auto-pages by default until the API reports no more ready output.",
		Arguments:   "None.",
		Flags:       "--page-size sets a 1 to 100 item page size. --cursor starts from a server cursor. --no-auto-page fetches one page and warns if more remains. --json includes pagination metadata. Global flags are available.",
		Environment: globalEnvironmentHelp(),
		Examples:    "agent-outbox output check\nagent-outbox output check --page-size 50 --json\nagent-outbox output check --no-auto-page",
		ExitCodes:   "0 success. 64 usage. 74 secret store. 75 rate/quota/temporary failure. 77 permission. 78 config or caller selection.",
		RelatedDocs: "docs/spec/output-schema.md#output-check-page, docs/spec/http-api.md#output-queue, and agent-outbox docs output.",
	})
	return cmd
}

func outputReadCommand(opts Options, flags *rootFlags) *cobra.Command {
	page := pageFlags{PageSize: 25}
	readAll := false
	cmd := &cobra.Command{
		Use:           "read <output_result_id>",
		Short:         "Read output payloads and mark returned results read",
		SilenceErrors: true,
		SilenceUsage:  true,
		Args: func(cmd *cobra.Command, args []string) error {
			if readAll {
				if len(args) != 0 {
					return foundation.NewUsageError("output read --all does not accept an output_result_id.")
				}
				return nil
			}
			return exactArgs(1)(cmd, args)
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			if !readAll && (cmd.Flags().Changed("page-size") || cmd.Flags().Changed("cursor") || cmd.Flags().Changed("no-auto-page")) {
				return foundation.NewUsageError("--page-size, --cursor, and --no-auto-page require output read --all.")
			}
			runtime, err := runtimeForCommand(opts, flags)
			if err != nil {
				return err
			}
			if readAll {
				result, err := fetchOutputPages(cmd.Context(), runtime, "read-all", page)
				if err != nil {
					return err
				}
				warnUnreadPagesLeft(opts.Stderr, result.Pagination)
				return renderPaginatedSuccess(opts.Stdout, flags.json, result)
			}

			var data json.RawMessage
			path := "/api/output/" + url.PathEscape(args[0]) + "/read"
			meta, err := runtime.Client.Do(cmd.Context(), http.MethodPost, path, runtime.Bearer, nil, &data)
			if err != nil {
				return err
			}
			return renderRawSuccess(opts.Stdout, flags.json, meta, data)
		},
	}
	cmd.Flags().BoolVar(&readAll, "all", false, "read all ready output pages")
	addPageFlags(cmd, &page)
	documentCommand(cmd, commandHelpSpec{
		Purpose:     "Read one output result or read all ready output pages, marking only returned results as read.",
		Arguments:   "<output_result_id> is required unless --all is set. output read --all accepts no output id.",
		Flags:       "--all reads every ready output page. With --all, --page-size, --cursor, and --no-auto-page control pagination. --json prints pagination metadata. Global flags are available.",
		Environment: globalEnvironmentHelp(),
		Examples:    "agent-outbox output read out_123\nagent-outbox output read --all --json\nagent-outbox output read --all --no-auto-page --page-size 10",
		ExitCodes:   "0 success. 64 usage. 66 not found. 73 stale/read conflict. 74 secret store. 75 rate/quota/temporary failure. 77 permission. 78 config or caller selection.",
		RelatedDocs: "docs/spec/output-schema.md#output-read-result, docs/spec/http-api.md#output-queue, and agent-outbox docs output.",
	})
	return cmd
}

func outputFileGetCommand(opts Options, flags *rootFlags) *cobra.Command {
	fileFlags := fileGetFlags{}
	cmd := &cobra.Command{
		Use:           "get <output_result_id> <file_id>",
		Short:         "Download raw output file bytes",
		Args:          exactArgs(2),
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := validateFileGetFlags(fileFlags, flags.json); err != nil {
				return err
			}
			runtime, err := runtimeForCommand(opts, flags)
			if err != nil {
				return err
			}
			apiPath := "/api/output/" + url.PathEscape(args[0]) + "/files/" + url.PathEscape(args[1])
			if fileFlags.Stdout {
				_, err := runtime.Client.Download(cmd.Context(), apiPath, runtime.Bearer, opts.Stdout)
				return err
			}
			meta, err := downloadFileToPath(cmd.Context(), runtime, apiPath, fileFlags.OutputPath, fileFlags.Force)
			if err != nil {
				return err
			}
			data := map[string]any{
				"output_result_id": args[0],
				"file_id":          args[1],
				"output":           fileFlags.OutputPath,
			}
			if meta.ContentType != "" {
				data["content_type"] = meta.ContentType
			}
			if meta.ContentLength >= 0 {
				data["content_length"] = meta.ContentLength
			}
			return renderStructuredSuccess(opts.Stdout, flags.json, &meta.APIResponse, data)
		},
	}
	cmd.Flags().StringVar(&fileFlags.OutputPath, "output", "", "path to write downloaded bytes")
	cmd.Flags().BoolVar(&fileFlags.Stdout, "stdout", false, "write downloaded bytes to stdout")
	cmd.Flags().BoolVar(&fileFlags.Force, "force", false, "overwrite an existing output path")
	documentCommand(cmd, commandHelpSpec{
		Purpose:     "Download raw bytes for one output file using the dedicated authorized file endpoint.",
		Arguments:   "<output_result_id> identifies the output result. <file_id> identifies the file metadata row on that result.",
		Flags:       "Exactly one of --output <path> or --stdout is required. --force allows overwrite with --output. --json requires --output so stdout stays reserved for JSON. Global flags are available.",
		Environment: globalEnvironmentHelp(),
		Examples:    "agent-outbox output file get out_123 file_456 --output answer.bin\nagent-outbox output file get out_123 file_456 --output answer.bin --force --json\nagent-outbox output file get out_123 file_456 --stdout > answer.bin",
		ExitCodes:   "0 success. 64 usage or local overwrite refusal. 66 not found. 74 secret store. 75 temporary API/local file failure. 77 permission. 78 config or caller selection.",
		RelatedDocs: "docs/spec/output-schema.md#file-download, docs/spec/http-api.md#output-file-download, and agent-outbox docs output.",
	})
	return cmd
}

func outputAckCommand(opts Options, flags *rootFlags) *cobra.Command {
	cmd := &cobra.Command{
		Use:           "ack <output_result_id>",
		Short:         "Acknowledge durably handled output",
		Args:          exactArgs(1),
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(cmd *cobra.Command, args []string) error {
			runtime, err := runtimeForCommand(opts, flags)
			if err != nil {
				return err
			}
			var data json.RawMessage
			path := "/api/output/" + url.PathEscape(args[0]) + "/ack"
			meta, err := runtime.Client.Do(cmd.Context(), http.MethodPost, path, runtime.Bearer, nil, &data)
			if err != nil {
				return err
			}
			return renderRawSuccess(opts.Stdout, flags.json, meta, data)
		},
	}
	documentCommand(cmd, commandHelpSpec{
		Purpose:     "Acknowledge that caller-owned downstream handling for an output result is durable, deleting the live queue pair.",
		Arguments:   "<output_result_id> is the output result to acknowledge.",
		Flags:       "--json prints the API response in the shared success envelope. Global --caller, --config, --base-url, and --no-color are available.",
		Environment: globalEnvironmentHelp(),
		Examples:    "agent-outbox output ack out_123\nagent-outbox output ack out_123 --json",
		ExitCodes:   "0 success. 64 usage. 66 not found. 73 already acknowledged or stale state. 74 secret store. 75 rate/quota/temporary failure. 77 permission. 78 config or caller selection.",
		RelatedDocs: "docs/spec/output-schema.md#acknowledgement, docs/spec/http-api.md#output-queue, and agent-outbox docs output.",
	})
	return cmd
}

func addPageFlags(cmd *cobra.Command, page *pageFlags) {
	cmd.Flags().IntVar(&page.PageSize, "page-size", 25, "output page size, 1 to 100")
	cmd.Flags().StringVar(&page.Cursor, "cursor", "", "opaque output pagination cursor")
	cmd.Flags().BoolVar(&page.NoAutoPage, "no-auto-page", false, "fetch only one output page")
}

func runtimeForCommand(opts Options, flags *rootFlags) (*apiRuntime, error) {
	cfg, err := loadConfig(flags, opts.Env)
	if err != nil {
		return nil, err
	}
	baseURL, err := foundation.ResolveBaseURL(flags.baseURL, opts.Env, cfg)
	if err != nil {
		return nil, err
	}
	caller, err := foundation.SelectCaller(flags.caller, opts.Env, cfg)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(caller.CallerID) == "" {
		return nil, foundation.NewAppError(foundation.CodeConfig, "Selected caller is missing caller_id in local config.")
	}
	store, err := secretStoreForCommand(opts)
	if err != nil {
		return nil, err
	}
	bearer, err := store.LoadCallerKey(caller.CallerID)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(bearer) == "" {
		return nil, foundation.NewSecretStoreError("Local caller secret is empty; run agent-outbox caller rotate <caller> or reconnect the caller.")
	}
	return &apiRuntime{
		Client: foundation.APIClient{
			BaseURL:      baseURL,
			HTTPClient:   opts.HTTPClient,
			NewRequestID: opts.NewRequestID,
		},
		Bearer: bearer,
	}, nil
}

func secretStoreForCommand(opts Options) (foundation.CallerSecretLoader, error) {
	if opts.SecretStore != nil {
		return opts.SecretStore, nil
	}
	paths, err := foundation.DefaultPathsFromOS()
	if err != nil {
		return nil, foundation.WrapConfigError("Could not determine local Agent Outbox secret-store path.", err)
	}
	masterKey, err := foundation.LoadMasterKey(foundation.GoKeyring{})
	if err != nil {
		return nil, err
	}
	return foundation.NewEncryptedCallerSecretStore(paths.SecretsPath, masterKey)
}

func readInputSubmissionFile(path string) (json.RawMessage, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, foundation.NewUsageError("--file is required.")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, foundation.NewAppError(foundation.CodeConfig, "Could not read input submission file.")
	}
	if len(data) > inputPayloadLimitBytes {
		return nil, foundation.NewAppError(foundation.CodeRequestTooLarge, "Input submission JSON exceeds the 128000 byte limit.")
	}
	if err := validateInputSubmissionJSON(data); err != nil {
		return nil, err
	}
	return json.RawMessage(data), nil
}

func validateInputSubmissionJSON(data []byte) error {
	var body map[string]json.RawMessage
	if err := json.Unmarshal(data, &body); err != nil {
		return foundation.NewAppError(foundation.CodeInvalidJSON, "Input submission file is not valid JSON.")
	}
	if body == nil {
		return foundation.NewAppError(foundation.CodeValidationFailed, "Input submission must be a JSON object.")
	}
	if _, ok := body["caller_id"]; ok {
		return &foundation.AppError{
			Code:    foundation.CodeValidationFailed,
			Message: "Input submission must not include caller_id; the server derives caller identity from the bearer credential.",
			Fields:  []foundation.FieldError{{Path: "caller_id", Code: "caller_id_not_allowed", Message: "caller_id must not be sent."}},
		}
	}

	var fields []foundation.FieldError
	for _, required := range []string{"caller_item_id", "row_type", "title", "subtitle", "summary", "link_buttons", "actions"} {
		if _, ok := body[required]; !ok {
			fields = append(fields, foundation.FieldError{
				Path:    required,
				Code:    "required",
				Message: required + " is required.",
			})
		}
	}
	if len(fields) > 0 {
		return &foundation.AppError{
			Code:    foundation.CodeValidationFailed,
			Message: "Input submission is missing required fields.",
			Fields:  fields,
		}
	}

	for _, field := range []string{"title", "subtitle", "corner", "summary", "details"} {
		raw, ok := body[field]
		if !ok {
			continue
		}
		var value string
		if err := json.Unmarshal(raw, &value); err == nil && containsClearlyUnsafeHTML(value) {
			return &foundation.AppError{
				Code:    foundation.CodeUnsafeHTML,
				Message: "Input submission contains clearly unsafe HTML.",
				Fields:  []foundation.FieldError{{Path: field, Code: "unsafe_html", Message: field + " contains a disallowed HTML tag."}},
			}
		}
	}
	return nil
}

func containsClearlyUnsafeHTML(value string) bool {
	lower := strings.ToLower(value)
	for _, pattern := range []string{"<script", "<style", "<iframe", "<svg", "<math", "<form", "<input", "<button", "<img", "<video", "<audio"} {
		if strings.Contains(lower, pattern) {
			return true
		}
	}
	return false
}

func fetchOutputPages(ctx context.Context, runtime *apiRuntime, kind string, page pageFlags) (*paginatedResult, error) {
	if page.PageSize < 1 || page.PageSize > 100 {
		return nil, foundation.NewUsageError("--page-size must be between 1 and 100.")
	}

	cursor := strings.TrimSpace(page.Cursor)
	seenCursors := map[string]bool{}
	if cursor != "" {
		seenCursors[cursor] = true
	}

	result := &paginatedResult{
		Data: paginatedData{Items: []json.RawMessage{}},
		Pagination: paginationMetadata{
			Complete:  true,
			PageLimit: page.PageSize,
		},
	}

	for {
		nextPage, err := fetchOutputPage(ctx, runtime, kind, page.PageSize, cursor)
		if err != nil {
			return nil, err
		}
		if err := validateOutputPage(nextPage); err != nil {
			return nil, err
		}
		if result.Data.ReadyCount == nil && nextPage.ReadyCount != nil {
			result.Data.ReadyCount = nextPage.ReadyCount
		}
		result.Data.Items = append(result.Data.Items, nextPage.Items...)
		result.Pagination.PageCount++
		result.Pagination.RequestCount++
		result.Pagination.ReturnedCount += nextPage.ReturnedCount
		result.Pagination.HasMore = nextPage.HasMore
		result.Pagination.NextCursor = nextPage.NextCursor

		if !nextPage.HasMore {
			result.Pagination.Complete = true
			return result, nil
		}
		if page.NoAutoPage {
			result.Pagination.Complete = false
			return result, nil
		}

		nextCursor := strings.TrimSpace(*nextPage.NextCursor)
		if seenCursors[nextCursor] {
			return nil, foundation.NewAppError(foundation.CodeValidationFailed, "Agent Outbox API returned a repeated pagination cursor.")
		}
		seenCursors[nextCursor] = true
		cursor = nextCursor
	}
}

func fetchOutputPage(ctx context.Context, runtime *apiRuntime, kind string, pageSize int, cursor string) (*outputPage, error) {
	var page outputPage
	switch kind {
	case "check":
		values := url.Values{}
		values.Set("limit", fmt.Sprintf("%d", pageSize))
		if cursor != "" {
			values.Set("cursor", cursor)
		}
		_, err := runtime.Client.Do(ctx, http.MethodGet, "/api/output/check?"+values.Encode(), runtime.Bearer, nil, &page)
		return &page, err
	case "read-all":
		body := struct {
			Limit  int     `json:"limit"`
			Cursor *string `json:"cursor"`
		}{Limit: pageSize}
		if cursor != "" {
			body.Cursor = &cursor
		}
		_, err := runtime.Client.Do(ctx, http.MethodPost, "/api/output/read-all", runtime.Bearer, body, &page)
		return &page, err
	default:
		return nil, foundation.NewAppError(foundation.CodeInternalError, "Unknown output pagination kind.")
	}
}

func validateOutputPage(page *outputPage) error {
	if page.ReturnedCount != len(page.Items) {
		return foundation.NewAppError(foundation.CodeValidationFailed, "Agent Outbox API returned inconsistent pagination counts.")
	}
	if page.PageLimit < 1 || page.PageLimit > 100 {
		return foundation.NewAppError(foundation.CodeValidationFailed, "Agent Outbox API returned an invalid page limit.")
	}
	if page.HasMore {
		if page.NextCursor == nil || strings.TrimSpace(*page.NextCursor) == "" {
			return foundation.NewAppError(foundation.CodeValidationFailed, "Agent Outbox API returned has_more without next_cursor.")
		}
	} else if page.NextCursor != nil {
		return foundation.NewAppError(foundation.CodeValidationFailed, "Agent Outbox API returned next_cursor without has_more.")
	}
	return nil
}

func validateFileGetFlags(fileFlags fileGetFlags, jsonMode bool) error {
	hasOutput := strings.TrimSpace(fileFlags.OutputPath) != ""
	if hasOutput == fileFlags.Stdout {
		return foundation.NewUsageError("output file get requires exactly one of --output <path> or --stdout.")
	}
	if jsonMode && fileFlags.Stdout {
		return foundation.NewUsageError("output file get --json requires --output because --stdout is reserved for raw file bytes.")
	}
	if fileFlags.Force && fileFlags.Stdout {
		return foundation.NewUsageError("output file get --force can only be used with --output.")
	}
	return nil
}

func downloadFileToPath(ctx context.Context, runtime *apiRuntime, apiPath string, outputPath string, force bool) (*foundation.DownloadResponse, error) {
	outputPath = strings.TrimSpace(outputPath)
	if outputPath == "" {
		return nil, foundation.NewUsageError("--output path is required.")
	}
	if stat, err := os.Stat(outputPath); err == nil {
		if stat.IsDir() {
			return nil, foundation.NewUsageError("Output path is a directory.")
		}
		if !force {
			return nil, foundation.NewUsageError("Output path already exists; pass --force to overwrite it.")
		}
	} else if !os.IsNotExist(err) {
		return nil, foundation.NewAppError(foundation.CodeTemporaryUnavailable, "Could not inspect output path.")
	}

	dir := filepath.Dir(outputPath)
	base := filepath.Base(outputPath)
	file, err := os.CreateTemp(dir, "."+base+".tmp-*")
	if err != nil {
		return nil, foundation.NewAppError(foundation.CodeTemporaryUnavailable, "Could not open output path for writing.")
	}
	tempPath := file.Name()
	closeFile := true
	keepTemp := false
	defer func() {
		if closeFile {
			_ = file.Close()
		}
		if !keepTemp {
			_ = os.Remove(tempPath)
		}
	}()
	if err := file.Chmod(0o600); err != nil {
		return nil, foundation.NewAppError(foundation.CodeTemporaryUnavailable, "Could not secure output file permissions.")
	}

	meta, err := runtime.Client.Download(ctx, apiPath, runtime.Bearer, file)
	if err != nil {
		return nil, err
	}
	if err := file.Sync(); err != nil {
		return nil, foundation.NewAppError(foundation.CodeTemporaryUnavailable, "Could not finish writing output file.")
	}
	if err := file.Close(); err != nil {
		closeFile = false
		return nil, foundation.NewAppError(foundation.CodeTemporaryUnavailable, "Could not finish writing output file.")
	}
	closeFile = false
	if !force {
		if _, err := os.Stat(outputPath); err == nil {
			return nil, foundation.NewUsageError("Output path already exists; pass --force to overwrite it.")
		} else if !os.IsNotExist(err) {
			return nil, foundation.NewAppError(foundation.CodeTemporaryUnavailable, "Could not inspect output path.")
		}
	}
	if err := os.Rename(tempPath, outputPath); err != nil {
		return nil, foundation.NewAppError(foundation.CodeTemporaryUnavailable, "Could not move output file into place.")
	}
	keepTemp = true
	return meta, nil
}

func renderRawSuccess(w io.Writer, jsonMode bool, meta *foundation.APIResponse, data json.RawMessage) error {
	if len(bytes.TrimSpace(data)) == 0 {
		data = json.RawMessage(`{}`)
	}
	if jsonMode {
		return renderStructuredSuccess(w, true, meta, data)
	}
	_, _ = w.Write(prettyJSON(data))
	_, _ = w.Write([]byte("\n"))
	return nil
}

func renderPaginatedSuccess(w io.Writer, jsonMode bool, result *paginatedResult) error {
	if jsonMode {
		return renderStructuredEnvelope(w, successEnvelope{
			OK:         true,
			Data:       result.Data,
			Pagination: &result.Pagination,
		})
	}
	if len(result.Data.Items) == 0 {
		_, _ = fmt.Fprintln(w, "no output ready")
		return nil
	}
	for _, item := range result.Data.Items {
		_, _ = fmt.Fprintln(w, compactOutputItem(item))
	}
	return nil
}

func renderStructuredSuccess(w io.Writer, jsonMode bool, meta *foundation.APIResponse, data any) error {
	if jsonMode {
		envelope := successEnvelope{OK: true, Data: data}
		if meta != nil {
			envelope.RequestID = meta.RequestID
			envelope.CorrelationID = meta.CorrelationID
		}
		return renderStructuredEnvelope(w, envelope)
	}
	encoded, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	_, _ = w.Write(encoded)
	_, _ = w.Write([]byte("\n"))
	return nil
}

func renderStructuredEnvelope(w io.Writer, envelope successEnvelope) error {
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(envelope)
}

func prettyJSON(data json.RawMessage) []byte {
	var out bytes.Buffer
	if err := json.Indent(&out, data, "", "  "); err != nil {
		return data
	}
	return out.Bytes()
}

func compactOutputItem(item json.RawMessage) string {
	var fields map[string]any
	if err := json.Unmarshal(item, &fields); err != nil {
		return string(item)
	}
	outputID, _ := fields["output_result_id"].(string)
	callerItemID, _ := fields["caller_item_id"].(string)
	answeredAt, _ := fields["answered_at"].(string)
	parts := []string{}
	if outputID != "" {
		parts = append(parts, "output_result_id="+outputID)
	}
	if callerItemID != "" {
		parts = append(parts, "caller_item_id="+callerItemID)
	}
	if answeredAt != "" {
		parts = append(parts, "answered_at="+answeredAt)
	}
	if len(parts) == 0 {
		return string(item)
	}
	return strings.Join(parts, " ")
}

func warnUnreadPagesLeft(w io.Writer, pagination paginationMetadata) {
	if pagination.Complete || !pagination.HasMore || pagination.NextCursor == nil {
		return
	}
	_, _ = fmt.Fprintf(w, "unread pages left; rerun with --cursor %s or omit --no-auto-page to auto-page all results\n", *pagination.NextCursor)
}

func exactArgs(n int) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if err := cobra.ExactArgs(n)(cmd, args); err != nil {
			return foundation.NewUsageError(err.Error())
		}
		return nil
	}
}
