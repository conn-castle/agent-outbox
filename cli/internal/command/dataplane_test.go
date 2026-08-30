package command

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"agent-outbox/internal/foundation"
)

type dataPlaneSecretStore struct {
	keys map[string]string
	err  error
}

func (s *dataPlaneSecretStore) LoadCallerKey(callerID string) (string, error) {
	if s.err != nil {
		return "", s.err
	}
	value, ok := s.keys[callerID]
	if !ok {
		return "", foundation.NewSecretStoreError("missing fake caller key")
	}
	return value, nil
}

func TestInputSendPostsFileAndRendersStableJSON(t *testing.T) {
	inputPath := filepath.Join(t.TempDir(), "input.json")
	if err := os.WriteFile(inputPath, []byte(`{
  "caller_item_id": "item_1",
  "row_type": {"display": "Email", "icon": "mail"},
  "title": "<strong>Title</strong>",
  "subtitle": "Subtitle",
  "summary": "Summary",
  "link_buttons": [],
  "actions": [{"display": "Approve", "icon": "check", "value": "approve", "overflow": false, "popup": {"kind": "none"}}]
}`), 0o600); err != nil {
		t.Fatalf("write input fixture: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/input/send" {
			t.Errorf("request = %s %s, want POST /api/input/send", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer caller-secret" {
			t.Errorf("authorization = %q", got)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("request body was not JSON: %v", err)
		}
		if body["caller_item_id"] != "item_1" {
			t.Errorf("caller_item_id body = %v", body["caller_item_id"])
		}
		if _, ok := body["caller_id"]; ok {
			t.Errorf("request body included caller_id")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"ok":true,"request_id":"req_server","correlation_id":"corr_server","data":{"caller_item_id":"item_1","status":"pending","revision":1,"created":true,"duplicate":false}}`)
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"--json", "input", "send", "--file", inputPath})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if stderr != "" {
		t.Fatalf("stderr should be empty: %s", stderr)
	}

	want := `{"ok":true,"request_id":"req_server","correlation_id":"corr_server","data":{"caller_item_id":"item_1","status":"pending","revision":1,"created":true,"duplicate":false}}` + "\n"
	if stdout != want {
		t.Fatalf("stdout = %s, want %s", stdout, want)
	}
}

func TestInputSendRejectsInvalidSchemaBeforeHTTP(t *testing.T) {
	inputPath := filepath.Join(t.TempDir(), "input.json")
	if err := os.WriteFile(inputPath, []byte(`{"caller_item_id":"item_1"}`), 0o600); err != nil {
		t.Fatalf("write input fixture: %v", err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"--json", "input", "send", "--file", inputPath})
	if code != foundation.ExitData {
		t.Fatalf("exit code = %d, want data; stderr: %s", code, stderr)
	}
	if requests != 0 {
		t.Fatalf("server requests = %d, want local validation to stop before HTTP", requests)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for validation errors")
	}
	if !strings.Contains(stderr, `"code":"validation_failed"`) {
		t.Fatalf("stderr missing validation code: %s", stderr)
	}
}

func TestInputListAutoPagesUntilComplete(t *testing.T) {
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.RawQuery)
		if r.Method != http.MethodGet || r.URL.Path != "/api/input/list" {
			t.Errorf("request = %s %s, want GET /api/input/list", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Query().Get("cursor") {
		case "":
			_, _ = fmt.Fprint(w, `{"ok":true,"data":{"items":[{"caller_item_id":"item_1","status":"pending","revision":1,"created_at":"2026-08-30T12:00:00Z","updated_at":"2026-08-30T12:00:00Z","answered_at":null}],"has_more":true,"next_cursor":"cursor_2","returned_count":1,"page_limit":2}}`)
		case "cursor_2":
			_, _ = fmt.Fprint(w, `{"ok":true,"data":{"items":[{"caller_item_id":"item_2","status":"answered","revision":2,"created_at":"2026-08-30T12:01:00Z","updated_at":"2026-08-30T12:02:00Z","answered_at":"2026-08-30T12:02:00Z"}],"has_more":false,"next_cursor":null,"returned_count":1,"page_limit":2}}`)
		default:
			t.Errorf("unexpected cursor %q", r.URL.Query().Get("cursor"))
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"--json", "input", "list", "--page-size", "2"})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if stderr != "" {
		t.Fatalf("stderr should be empty: %s", stderr)
	}
	if len(requests) != 2 || requests[0] != "limit=2" || requests[1] != "cursor=cursor_2&limit=2" {
		t.Fatalf("requests = %#v", requests)
	}

	payload := decodeCommandJSON(t, stdout)
	pagination := payload["pagination"].(map[string]any)
	if pagination["complete"] != true || pagination["page_count"] != float64(2) || pagination["returned_count"] != float64(2) {
		t.Fatalf("pagination = %#v", pagination)
	}
	data := payload["data"].(map[string]any)
	items := data["items"].([]any)
	if len(items) != 2 || items[0].(map[string]any)["caller_item_id"] != "item_1" || items[1].(map[string]any)["caller_item_id"] != "item_2" {
		t.Fatalf("items = %#v", items)
	}
}

func TestInputListHumanReadableOutputEscapesCallerItemID(t *testing.T) {
	const callerItemID = "item\nwith\tescape\x1b[2J"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/input/list" {
			t.Errorf("request = %s %s, want GET /api/input/list", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"ok":true,"data":{"items":[{"caller_item_id":"item\nwith\tescape\u001b[2J","status":"pending","revision":1,"updated_at":"2026-08-30T12:00:00Z"}],"has_more":false,"next_cursor":null,"returned_count":1,"page_limit":25}}`)
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"input", "list"})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if stderr != "" {
		t.Fatalf("stderr should be empty: %s", stderr)
	}
	if strings.Contains(stdout, "\x1b") {
		t.Fatalf("unescaped control sequence leaked into stdout: %q", stdout)
	}
	quotedID := strconv.Quote(callerItemID)
	if !strings.Contains(stdout, "caller_item_id="+quotedID) {
		t.Fatalf("stdout missing quoted caller_item_id: %q", stdout)
	}
	if strings.Count(stdout, "\n") != 1 {
		t.Fatalf("stdout should be one compact line, got %q", stdout)
	}
}

func TestInputReadPreservesCallerItemIDWhitespace(t *testing.T) {
	const callerItemID = " item "
	var gotID string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/input/read" {
			t.Errorf("request = %s %s, want POST /api/input/read", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("request body was not JSON: %v", err)
			return
		}
		gotID, _ = body["caller_item_id"].(string)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"ok":true,"request_id":"req_input_read","correlation_id":"corr_input_read","data":{"caller_item_id":%q}}`, callerItemID)
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"--json", "input", "read", callerItemID})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if stderr != "" {
		t.Fatalf("stderr should be empty: %s", stderr)
	}
	if gotID != callerItemID {
		t.Fatalf("caller_item_id body = %q, want %q", gotID, callerItemID)
	}
	if !strings.Contains(stdout, `"caller_item_id":" item "`) {
		t.Fatalf("stdout missing preserved caller_item_id: %s", stdout)
	}
}

func TestInputReadRejectsEmptyCallerItemID(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"input", "read", ""})
	if code != foundation.ExitUsage {
		t.Fatalf("exit code = %d, want usage; stderr: %s", code, stderr)
	}
	if requests != 0 {
		t.Fatalf("server requests = %d, want local validation to stop before HTTP", requests)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for usage errors")
	}
	if !strings.Contains(stderr, "caller_item_id is required") {
		t.Fatalf("stderr missing required-id error: %s", stderr)
	}
}

func TestInputListNoAutoPageReturnsCursorAndWarns(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"ok":true,"data":{"items":[],"has_more":true,"next_cursor":"cursor_2","returned_count":0,"page_limit":1}}`)
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"--json", "input", "list", "--page-size", "1", "--no-auto-page"})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if requests != 1 {
		t.Fatalf("request count = %d, want 1", requests)
	}
	if !strings.Contains(stderr, "input pages left") || !strings.Contains(stderr, "cursor_2") {
		t.Fatalf("stderr missing remaining-pages warning: %s", stderr)
	}
	pagination := decodeCommandJSON(t, stdout)["pagination"].(map[string]any)
	if pagination["complete"] != false || pagination["has_more"] != true || pagination["next_cursor"] != "cursor_2" {
		t.Fatalf("pagination = %#v", pagination)
	}
}

func TestOutputCheckAutoPagesUntilComplete(t *testing.T) {
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.RawQuery)
		if r.Method != http.MethodGet || r.URL.Path != "/api/output/check" {
			t.Errorf("request = %s %s, want GET /api/output/check", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Query().Get("cursor") {
		case "":
			_, _ = fmt.Fprint(w, `{"ok":true,"data":{"items":[{"output_result_id":"out_1","caller_item_id":"item_1","answered_at":"2026-07-02T20:00:00Z"}],"ready_count":2,"has_more":true,"next_cursor":"cursor_2","returned_count":1,"page_limit":2}}`)
		case "cursor_2":
			_, _ = fmt.Fprint(w, `{"ok":true,"data":{"items":[{"output_result_id":"out_2","caller_item_id":"item_2","answered_at":"2026-07-02T20:01:00Z"}],"ready_count":2,"has_more":false,"next_cursor":null,"returned_count":1,"page_limit":2}}`)
		default:
			t.Errorf("unexpected cursor %q", r.URL.Query().Get("cursor"))
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"--json", "output", "check", "--page-size", "2"})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if stderr != "" {
		t.Fatalf("stderr should be empty: %s", stderr)
	}
	if len(requests) != 2 {
		t.Fatalf("request count = %d, want 2", len(requests))
	}

	payload := decodeCommandJSON(t, stdout)
	pagination := payload["pagination"].(map[string]any)
	if pagination["complete"] != true || pagination["has_more"] != false {
		t.Fatalf("pagination did not report completion: %#v", pagination)
	}
	if pagination["page_count"] != float64(2) || pagination["request_count"] != float64(2) || pagination["returned_count"] != float64(2) {
		t.Fatalf("pagination counts = %#v", pagination)
	}
	data := payload["data"].(map[string]any)
	items := data["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("items length = %d, want 2", len(items))
	}
}

func TestOutputReadAllAutoPagesWithPostBodies(t *testing.T) {
	var bodies []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/output/read-all" {
			t.Errorf("request = %s %s, want POST /api/output/read-all", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("request body was not JSON: %v", err)
		}
		bodies = append(bodies, body)
		w.Header().Set("Content-Type", "application/json")
		if body["cursor"] == nil {
			_, _ = fmt.Fprint(w, `{"ok":true,"data":{"items":[{"output_result_id":"out_1","caller_id":"caller_123","caller_item_id":"item_1","action_value":"approve","response":{"kind":"none"},"answered_at":"2026-07-02T20:00:00Z","answered_by":"user_123"}],"unavailable_outputs":[{"output_result_id":"out_bad","code":"temporary_unavailable","message":"Output file metadata is temporarily unavailable."}],"unavailable_count":1,"has_more":true,"next_cursor":"cursor_2","returned_count":1,"page_limit":1}}`)
			return
		}
		_, _ = fmt.Fprint(w, `{"ok":true,"data":{"items":[{"output_result_id":"out_2","caller_id":"caller_123","caller_item_id":"item_2","action_value":"reject","response":{"kind":"none"},"answered_at":"2026-07-02T20:01:00Z","answered_by":"user_123"}],"unavailable_outputs":[],"unavailable_count":0,"has_more":false,"next_cursor":null,"returned_count":1,"page_limit":1}}`)
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"--json", "output", "read", "--all", "--page-size", "1"})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if len(bodies) != 2 {
		t.Fatalf("request count = %d, want 2", len(bodies))
	}
	if bodies[0]["limit"] != float64(1) || bodies[0]["cursor"] != nil {
		t.Fatalf("first body = %#v", bodies[0])
	}
	if bodies[1]["cursor"] != "cursor_2" {
		t.Fatalf("second body cursor = %#v", bodies[1])
	}
	if strings.Contains(stdout, "file bytes") {
		t.Fatalf("read-all output unexpectedly contained raw bytes")
	}
	payload := decodeCommandJSON(t, stdout)
	data := payload["data"].(map[string]any)
	unavailable := data["unavailable_outputs"].([]any)
	if len(unavailable) != 1 || data["unavailable_count"] != float64(1) {
		t.Fatalf("unavailable data = %#v", data)
	}
}

func TestOutputReadAllTextWarnsForUnavailableOutputs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"ok":true,"data":{"items":[],"unavailable_outputs":[{"output_result_id":"out_bad","code":"temporary_unavailable","message":"Output file metadata is temporarily unavailable."}],"unavailable_count":1,"has_more":false,"next_cursor":null,"returned_count":0,"page_limit":1}}`)
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"output", "read", "--all", "--page-size", "1"})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if !strings.Contains(stderr, "1 output result(s) were temporarily unavailable") {
		t.Fatalf("stderr missing unavailable warning: %s", stderr)
	}
	if !strings.Contains(stdout, "no output ready") {
		t.Fatalf("stdout = %s", stdout)
	}
}

func TestOutputReadAllJSONPreservesZeroUnavailableFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"ok":true,"data":{"items":[],"unavailable_outputs":[],"unavailable_count":0,"has_more":false,"next_cursor":null,"returned_count":0,"page_limit":25}}`)
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"--json", "output", "read", "--all"})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}

	payload := decodeCommandJSON(t, stdout)
	data := payload["data"].(map[string]any)
	if unavailable, ok := data["unavailable_outputs"].([]any); !ok || len(unavailable) != 0 {
		t.Fatalf("unavailable_outputs = %#v", data["unavailable_outputs"])
	}
	if count, ok := data["unavailable_count"].(float64); !ok || count != 0 {
		t.Fatalf("unavailable_count = %#v", data["unavailable_count"])
	}
}

func TestOutputReadRejectsPaginationFlagsWithoutAll(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"--json", "output", "read", "out_1", "--page-size", "10"})
	if code != foundation.ExitUsage {
		t.Fatalf("exit code = %d, want usage; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for argument errors")
	}
	if !strings.Contains(stderr, "require output read --all") {
		t.Fatalf("stderr missing pagination-flag usage message: %s", stderr)
	}
}

func TestNoAutoPageWarnsWhenUnreadPagesRemain(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"ok":true,"data":{"items":[{"output_result_id":"out_1","caller_item_id":"item_1","answered_at":"2026-07-02T20:00:00Z"}],"ready_count":2,"has_more":true,"next_cursor":"cursor_2","returned_count":1,"page_limit":1}}`)
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"--json", "output", "check", "--page-size", "1", "--no-auto-page"})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if !strings.Contains(stderr, "unread pages left") || !strings.Contains(stderr, "cursor_2") {
		t.Fatalf("stderr missing unread-pages diagnostic: %s", stderr)
	}
	payload := decodeCommandJSON(t, stdout)
	pagination := payload["pagination"].(map[string]any)
	if pagination["complete"] != false || pagination["has_more"] != true {
		t.Fatalf("pagination should report incomplete page: %#v", pagination)
	}
}

func TestOutputFileGetRefusesOverwriteBeforeDownload(t *testing.T) {
	existingPath := filepath.Join(t.TempDir(), "answer.bin")
	if err := os.WriteFile(existingPath, []byte("old"), 0o600); err != nil {
		t.Fatalf("write existing output: %v", err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"--json", "output", "file", "get", "out_1", "file_1", "--output", existingPath})
	if code != foundation.ExitUsage {
		t.Fatalf("exit code = %d, want usage; stderr: %s", code, stderr)
	}
	if requests != 0 {
		t.Fatalf("download requests = %d, want overwrite refusal before HTTP", requests)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for overwrite refusal")
	}
	if !strings.Contains(stderr, `"code":"usage_error"`) {
		t.Fatalf("stderr missing usage error: %s", stderr)
	}
}

func TestOutputFileGetKeepsBytesOutOfJSONAndDiagnostics(t *testing.T) {
	fileBytes := []byte("TOP-SECRET-FILE-BYTES")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/output/out_1/files/file_1" {
			t.Errorf("request path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer caller-secret" {
			t.Errorf("authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(fileBytes)))
		_, _ = w.Write(fileBytes)
	}))
	defer server.Close()

	outputPath := filepath.Join(t.TempDir(), "answer.bin")
	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"--json", "output", "file", "get", "out_1", "file_1", "--output", outputPath})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	written, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("read downloaded file: %v", err)
	}
	if !bytes.Equal(written, fileBytes) {
		t.Fatalf("downloaded bytes did not round-trip")
	}
	if strings.Contains(stdout, string(fileBytes)) || strings.Contains(stderr, string(fileBytes)) {
		t.Fatalf("file bytes leaked into command output; stdout=%q stderr=%q", stdout, stderr)
	}
	payload := decodeCommandJSON(t, stdout)
	data := payload["data"].(map[string]any)
	if data["output"] != outputPath || data["content_length"] != float64(len(fileBytes)) {
		t.Fatalf("file metadata JSON = %#v", data)
	}
}

func TestOutputFileGetForcePreservesExistingFileWhenDownloadFails(t *testing.T) {
	outputPath := filepath.Join(t.TempDir(), "answer.bin")
	original := []byte("original local bytes")
	if err := os.WriteFile(outputPath, original, 0o644); err != nil {
		t.Fatalf("write existing output: %v", err)
	}
	if err := os.Chmod(outputPath, 0o644); err != nil {
		t.Fatalf("chmod existing output: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/output/out_1/files/file_1" {
			t.Errorf("request = %s %s, want GET /api/output/out_1/files/file_1", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer caller-secret" {
			t.Errorf("authorization = %q", got)
		}
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"ok":false,"request_id":"req_file","correlation_id":"corr_file","error":{"code":"temporary_unavailable","message":"temporary download failure"}}`)
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"--json", "output", "file", "get", "out_1", "file_1", "--output", outputPath, "--force"})
	if code != foundation.ExitTemporary {
		t.Fatalf("exit code = %d, want temporary; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for failed download")
	}
	written, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("read preserved output: %v", err)
	}
	if !bytes.Equal(written, original) {
		t.Fatalf("forced failed download changed existing file: %q", string(written))
	}
	stat, err := os.Stat(outputPath)
	if err != nil {
		t.Fatalf("stat preserved output: %v", err)
	}
	if got := stat.Mode().Perm(); got != 0o644 {
		t.Fatalf("preserved output mode = %o, want 644", got)
	}
	if !strings.Contains(stderr, `"code":"temporary_unavailable"`) || !strings.Contains(stderr, `"request_id":"req_file"`) {
		t.Fatalf("stderr missing API error envelope: %s", stderr)
	}
}

func TestOutputFileGetForcePreservesExistingFileWhenDownloadIsOversized(t *testing.T) {
	outputPath := filepath.Join(t.TempDir(), "answer.bin")
	original := []byte("original local bytes")
	if err := os.WriteFile(outputPath, original, 0o644); err != nil {
		t.Fatalf("write existing output: %v", err)
	}
	if err := os.Chmod(outputPath, 0o644); err != nil {
		t.Fatalf("chmod existing output: %v", err)
	}
	const rawBytes = "raw-download-test-bytes"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/output/out_1/files/file_1" {
			t.Errorf("request = %s %s, want GET /api/output/out_1/files/file_1", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Length", "32000001")
		_, _ = io.WriteString(w, rawBytes)
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"--json", "output", "file", "get", "out_1", "file_1", "--output", outputPath, "--force"})
	if code != foundation.ExitTemporary {
		t.Fatalf("exit code = %d, want temporary; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for failed download")
	}
	if strings.Contains(stdout, rawBytes) || strings.Contains(stderr, rawBytes) {
		t.Fatalf("raw bytes leaked into command output; stdout=%q stderr=%q", stdout, stderr)
	}
	if !strings.Contains(stderr, `"code":"temporary_unavailable"`) {
		t.Fatalf("stderr missing temporary-unavailable error: %s", stderr)
	}
	written, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("read preserved output: %v", err)
	}
	if !bytes.Equal(written, original) {
		t.Fatalf("forced oversized download changed existing file: %q", string(written))
	}
	stat, err := os.Stat(outputPath)
	if err != nil {
		t.Fatalf("stat preserved output: %v", err)
	}
	if got := stat.Mode().Perm(); got != 0o644 {
		t.Fatalf("preserved output mode = %o, want 644", got)
	}
	entries, err := os.ReadDir(filepath.Dir(outputPath))
	if err != nil {
		t.Fatalf("read output directory: %v", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".answer.bin.tmp-") {
			t.Fatalf("temporary download file was not removed: %s", entry.Name())
		}
	}
}

func TestOutputFileGetForceReplacesWithOwnerOnlyPermissions(t *testing.T) {
	fileBytes := []byte("replacement file bytes")
	outputPath := filepath.Join(t.TempDir(), "answer.bin")
	if err := os.WriteFile(outputPath, []byte("old bytes"), 0o644); err != nil {
		t.Fatalf("write existing output: %v", err)
	}
	if err := os.Chmod(outputPath, 0o644); err != nil {
		t.Fatalf("chmod existing output: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/output/out_1/files/file_1" {
			t.Errorf("request = %s %s, want GET /api/output/out_1/files/file_1", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer caller-secret" {
			t.Errorf("authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(fileBytes)))
		_, _ = w.Write(fileBytes)
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"--json", "output", "file", "get", "out_1", "file_1", "--output", outputPath, "--force"})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if stderr != "" {
		t.Fatalf("stderr should be empty: %s", stderr)
	}
	written, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("read downloaded file: %v", err)
	}
	if !bytes.Equal(written, fileBytes) {
		t.Fatalf("downloaded bytes did not replace existing file")
	}
	stat, err := os.Stat(outputPath)
	if err != nil {
		t.Fatalf("stat downloaded file: %v", err)
	}
	if got := stat.Mode().Perm(); got != 0o600 {
		t.Fatalf("downloaded file mode = %o, want 600", got)
	}
	payload := decodeCommandJSON(t, stdout)
	data := payload["data"].(map[string]any)
	if data["output"] != outputPath || data["content_length"] != float64(len(fileBytes)) {
		t.Fatalf("file metadata JSON = %#v", data)
	}
}

func TestOutputFileGetStdoutRejectsLengthlessOversizeWithoutRawBytes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/output/out_1/files/file_1" {
			t.Errorf("request = %s %s, want GET /api/output/out_1/files/file_1", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer caller-secret" {
			t.Errorf("authorization = %q", got)
		}
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		chunkBytes := strings.Repeat("raw-download-test-bytes", 4096)
		for remaining := int64(32_000_001); remaining > 0; {
			writeBytes := int64(len(chunkBytes))
			if writeBytes > remaining {
				writeBytes = remaining
			}
			_, _ = io.WriteString(w, chunkBytes[:writeBytes])
			remaining -= writeBytes
		}
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"output", "file", "get", "out_1", "file_1", "--stdout"})
	if code != foundation.ExitTemporary {
		t.Fatalf("exit code = %d, want temporary; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout contained %d raw bytes, want none", len(stdout))
	}
	if strings.Contains(stderr, "raw-download-test-bytes") {
		t.Fatalf("raw bytes leaked into diagnostics: %q", stderr)
	}
	if !strings.Contains(stderr, "temporary_unavailable") {
		t.Fatalf("stderr missing temporary-unavailable error: %s", stderr)
	}
}

func TestOutputFileGetStdoutRejectsJSONMode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"--json", "output", "file", "get", "out_1", "file_1", "--stdout"})
	if code != foundation.ExitUsage {
		t.Fatalf("exit code = %d, want usage; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty when JSON/stdout raw bytes conflict")
	}
	if !strings.Contains(stderr, "stdout is reserved for raw file bytes") {
		t.Fatalf("stderr missing raw-byte conflict: %s", stderr)
	}
}

func TestDataPlaneEndpointWrappersUseExpectedHTTPMapping(t *testing.T) {
	inputPath := filepath.Join(t.TempDir(), "input.json")
	if err := os.WriteFile(inputPath, []byte(`{
  "caller_item_id": "item_1",
  "row_type": {"display": "Email", "icon": "mail"},
  "title": "Title",
  "subtitle": "Subtitle",
  "summary": "Summary",
  "link_buttons": [],
  "actions": [{"display": "Approve", "icon": "check", "value": "approve", "overflow": false, "popup": {"kind": "none"}}]
}`), 0o600); err != nil {
		t.Fatalf("write input fixture: %v", err)
	}

	tests := []struct {
		name       string
		args       []string
		method     string
		path       string
		assertBody func(t *testing.T, r *http.Request)
		response   string
		wantStdout string
	}{
		{
			name:   "input replace",
			args:   []string{"--json", "input", "replace", "--file", inputPath},
			method: http.MethodPost,
			path:   "/api/input/replace",
			assertBody: func(t *testing.T, r *http.Request) {
				t.Helper()
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatalf("request body was not JSON: %v", err)
				}
				if body["caller_item_id"] != "item_1" {
					t.Fatalf("caller_item_id body = %v", body["caller_item_id"])
				}
				if _, ok := body["caller_id"]; ok {
					t.Fatalf("request body included caller_id")
				}
			},
			response:   `{"ok":true,"request_id":"req_replace","correlation_id":"corr_replace","data":{"caller_item_id":"item_1","status":"pending","revision":2,"created":false,"duplicate":false}}`,
			wantStdout: `{"ok":true,"request_id":"req_replace","correlation_id":"corr_replace","data":{"caller_item_id":"item_1","status":"pending","revision":2,"created":false,"duplicate":false}}` + "\n",
		},
		{
			name:   "input delete",
			args:   []string{"--json", "input", "delete", "item_1"},
			method: http.MethodPost,
			path:   "/api/input/delete",
			assertBody: func(t *testing.T, r *http.Request) {
				t.Helper()
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatalf("request body was not JSON: %v", err)
				}
				if body["caller_item_id"] != "item_1" || len(body) != 1 {
					t.Fatalf("delete body = %#v", body)
				}
			},
			response:   `{"ok":true,"request_id":"req_delete","correlation_id":"corr_delete","data":{"caller_item_id":"item_1","deleted":true}}`,
			wantStdout: `{"ok":true,"request_id":"req_delete","correlation_id":"corr_delete","data":{"caller_item_id":"item_1","deleted":true}}` + "\n",
		},
		{
			name:   "input read",
			args:   []string{"--json", "input", "read", "item_1"},
			method: http.MethodPost,
			path:   "/api/input/read",
			assertBody: func(t *testing.T, r *http.Request) {
				t.Helper()
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatalf("request body was not JSON: %v", err)
				}
				if body["caller_item_id"] != "item_1" || len(body) != 1 {
					t.Fatalf("read body = %#v", body)
				}
			},
			response:   `{"ok":true,"request_id":"req_input_read","correlation_id":"corr_input_read","data":{"caller_item_id":"item_1","status":"pending","revision":1,"created_at":"2026-08-30T12:00:00Z","updated_at":"2026-08-30T12:00:00Z","answered_at":null,"raw_input":{"caller_item_id":"item_1"}}}`,
			wantStdout: `{"ok":true,"request_id":"req_input_read","correlation_id":"corr_input_read","data":{"caller_item_id":"item_1","status":"pending","revision":1,"created_at":"2026-08-30T12:00:00Z","updated_at":"2026-08-30T12:00:00Z","answered_at":null,"raw_input":{"caller_item_id":"item_1"}}}` + "\n",
		},
		{
			name:   "one-result output read",
			args:   []string{"--json", "output", "read", "out_1"},
			method: http.MethodPost,
			path:   "/api/output/out_1/read",
			assertBody: func(t *testing.T, r *http.Request) {
				t.Helper()
				assertEmptyRequestBody(t, r)
			},
			response:   `{"ok":true,"request_id":"req_read","correlation_id":"corr_read","data":{"output_result_id":"out_1","caller_item_id":"item_1","action_value":"approve","response":{"kind":"none"},"answered_at":"2026-07-02T20:00:00Z","answered_by":"user_123"}}`,
			wantStdout: `{"ok":true,"request_id":"req_read","correlation_id":"corr_read","data":{"output_result_id":"out_1","caller_item_id":"item_1","action_value":"approve","response":{"kind":"none"},"answered_at":"2026-07-02T20:00:00Z","answered_by":"user_123"}}` + "\n",
		},
		{
			name:   "output ack",
			args:   []string{"--json", "output", "ack", "out_1"},
			method: http.MethodPost,
			path:   "/api/output/out_1/ack",
			assertBody: func(t *testing.T, r *http.Request) {
				t.Helper()
				assertEmptyRequestBody(t, r)
			},
			response:   `{"ok":true,"request_id":"req_ack","correlation_id":"corr_ack","data":{"output_result_id":"out_1","acknowledged":true}}`,
			wantStdout: `{"ok":true,"request_id":"req_ack","correlation_id":"corr_ack","data":{"output_result_id":"out_1","acknowledged":true}}` + "\n",
		},
		{
			name:   "caller status",
			args:   []string{"--json", "caller", "status"},
			method: http.MethodGet,
			path:   "/api/caller/status",
			assertBody: func(t *testing.T, r *http.Request) {
				t.Helper()
				assertEmptyRequestBody(t, r)
			},
			response:   `{"ok":true,"request_id":"req_caller","correlation_id":"corr_caller","data":{"caller_id":"caller_123","caller_slug":"steward-email","status":"active","account":{"account_id":"acct_123","effective_tier":"free","billing_status":"not_applicable"}}}`,
			wantStdout: `{"ok":true,"request_id":"req_caller","correlation_id":"corr_caller","data":{"caller_id":"caller_123","caller_slug":"steward-email","status":"active","account":{"account_id":"acct_123","effective_tier":"free","billing_status":"not_applicable"}}}` + "\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.Method != tt.method || r.URL.Path != tt.path {
					t.Errorf("request = %s %s, want %s %s", r.Method, r.URL.Path, tt.method, tt.path)
					w.WriteHeader(http.StatusNotFound)
					return
				}
				if r.URL.RawQuery != "" {
					t.Errorf("query = %q, want empty", r.URL.RawQuery)
				}
				if got := r.Header.Get("Authorization"); got != "Bearer caller-secret" {
					t.Errorf("authorization = %q", got)
				}
				tt.assertBody(t, r)
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, tt.response)
			}))
			defer server.Close()

			stdout, stderr, code := executeDataPlaneCommand(t, server.URL, tt.args)
			if code != foundation.ExitSuccess {
				t.Fatalf("exit code = %d, stderr: %s", code, stderr)
			}
			if stderr != "" {
				t.Fatalf("stderr should be empty: %s", stderr)
			}
			if requests != 1 {
				t.Fatalf("request count = %d, want 1", requests)
			}
			if stdout != tt.wantStdout {
				t.Fatalf("stdout = %s, want %s", stdout, tt.wantStdout)
			}
		})
	}
}

func TestAPIErrorExitCodePropagatesThroughDataPlaneCommand(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = fmt.Fprint(w, `{"ok":false,"request_id":"req_auth","correlation_id":"corr_auth","error":{"code":"invalid_caller_credentials","message":"Caller credential is invalid, revoked, expired, or inactive."}}`)
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"--json", "input", "delete", "item_1"})
	if code != foundation.ExitPermission {
		t.Fatalf("exit code = %d, want permission; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for API errors")
	}
	if !strings.Contains(stderr, `"code":"invalid_caller_credentials"`) || !strings.Contains(stderr, `"request_id":"req_auth"`) {
		t.Fatalf("stderr missing API error envelope: %s", stderr)
	}
}

func TestAccountStatusUsesExistingLocalBearerCredential(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/account/status" {
			t.Errorf("request = %s %s, want GET /api/account/status", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer caller-secret" {
			t.Errorf("authorization = %q", got)
		}
		_, _ = io.WriteString(w, `{"ok":true,"data":{"account_id":"acct_123","label":"Test","tier":"hosted_free","effective_tier":"free","billing_status":"not_applicable","grace_ends_at":null,"file_upload_enabled":false,"storage":{"stored_bytes":0,"limit_name":"stored_non_file_queue_payload_bytes","limit_bytes":32000000},"active_limit_blocks":[]}}`)
	}))
	defer server.Close()

	stdout, stderr, code := executeDataPlaneCommand(t, server.URL, []string{"--json", "account", "status"})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if stderr != "" {
		t.Fatalf("stderr should be empty: %s", stderr)
	}
	if !strings.Contains(stdout, `"account_id":"acct_123"`) {
		t.Fatalf("stdout missing account status: %s", stdout)
	}
}

func TestDataPlaneUsesEnvironmentCredentialWithoutReadingFileStore(t *testing.T) {
	const envCredential = "aob_live_key_123_environmentsecret"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/account/status" {
			t.Fatalf("unexpected request path: %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+envCredential {
			t.Fatalf("authorization = %q, want environment credential", got)
		}
		_, _ = io.WriteString(w, `{"ok":true,"data":{"account_id":"acct_123","effective_tier":"free"}}`)
	}))
	defer server.Close()

	configPath := writeDataPlaneCommandConfig(t, server.URL)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Execute(context.Background(), Options{
		Args:        []string{"--config", configPath, "--json", "account", "status"},
		Stdout:      &stdout,
		Stderr:      &stderr,
		Env:         foundation.Env{foundation.EnvAPIKey: envCredential},
		SecretStore: &dataPlaneSecretStore{err: foundation.NewSecretStoreError("file store should not be read")},
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr.String())
	}
	if strings.Contains(stdout.String(), envCredential) || strings.Contains(stderr.String(), envCredential) {
		t.Fatalf("environment credential leaked into command output")
	}
}

func TestEnvironmentCredentialMustMatchSelectedCaller(t *testing.T) {
	caller := foundation.CallerConfig{Name: "steward-email", KeyID: "key_123"}
	for _, credential := range []string{
		"not-a-caller-key",
		"aob_live_different_key_environmentsecret",
	} {
		if _, _, err := environmentCallerCredential(
			foundation.Env{foundation.EnvAPIKey: credential},
			caller,
		); err == nil {
			t.Fatalf("environment credential %q did not fail selected-caller validation", credential)
		}
	}
}

func executeDataPlaneCommand(t *testing.T, baseURL string, args []string) (string, string, int) {
	t.Helper()

	configPath := writeDataPlaneCommandConfig(t, baseURL)
	fullArgs := append([]string{"--config", configPath}, args...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Execute(nil, Options{
		Args:         fullArgs,
		Stdout:       &stdout,
		Stderr:       &stderr,
		Env:          foundation.Env{},
		SecretStore:  &dataPlaneSecretStore{keys: map[string]string{"caller_123": "caller-secret"}},
		NewRequestID: func() string { return "req_cli" },
	})
	return stdout.String(), stderr.String(), code
}

func writeDataPlaneCommandConfig(t *testing.T, baseURL string) string {
	t.Helper()

	configPath := filepath.Join(t.TempDir(), "config.json")
	content := fmt.Sprintf(`{
  "version": 1,
  "base_url": %q,
  "callers": [
    {
      "name": "steward-email",
      "account_id": "acct_123",
      "caller_id": "caller_123",
      "caller_slug": "steward-email",
      "key_id": "key_123",
      "key_prefix": "aob_live",
      "key_suffix": "abcd"
    }
  ]
}`, baseURL)
	if err := os.WriteFile(configPath, []byte(content), 0o600); err != nil {
		t.Fatalf("write config fixture: %v", err)
	}
	return configPath
}

func assertEmptyRequestBody(t *testing.T, r *http.Request) {
	t.Helper()

	body, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatalf("read request body: %v", err)
	}
	if strings.TrimSpace(string(body)) != "" {
		t.Fatalf("request body = %q, want empty", string(body))
	}
}

func decodeCommandJSON(t *testing.T, stdout string) map[string]any {
	t.Helper()

	var payload map[string]any
	if err := json.Unmarshal([]byte(stdout), &payload); err != nil {
		t.Fatalf("stdout is not valid JSON: %v\n%s", err, stdout)
	}
	return payload
}
