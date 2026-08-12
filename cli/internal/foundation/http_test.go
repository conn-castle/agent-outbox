package foundation

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestAPIClientAddsBearerAuthAndParsesSuccessEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			t.Fatalf("missing authorization header")
		}
		if r.Header.Get("X-Request-ID") != "req_test" {
			t.Fatalf("missing request id header")
		}
		w.Header().Set("X-Request-ID", "req_test")
		w.Header().Set("X-Correlation-ID", "corr_test")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":             true,
			"request_id":     "req_test",
			"correlation_id": "corr_test",
			"data":           map[string]string{"value": "ok"},
		})
	}))
	defer server.Close()

	client := APIClient{
		BaseURL:      server.URL,
		NewRequestID: func() string { return "req_test" },
	}
	var out struct {
		Value string `json:"value"`
	}
	meta, err := client.Do(context.Background(), http.MethodPost, "/api/example", "bearer-fixture", map[string]string{"hello": "world"}, &out)
	if err != nil {
		t.Fatalf("Do failed: %v", err)
	}
	if out.Value != "ok" {
		t.Fatalf("response value = %q", out.Value)
	}
	if meta.RequestID != "req_test" || meta.CorrelationID != "corr_test" {
		t.Fatalf("response ids were not captured")
	}
}

func TestAPIClientPreservesAPIPathQuery(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/output/check" {
			t.Fatalf("request path = %q, want /api/output/check", r.URL.Path)
		}
		query := r.URL.Query()
		if query.Get("limit") != "25" {
			t.Fatalf("limit query = %q, want 25", query.Get("limit"))
		}
		if query.Get("cursor") != "abc" {
			t.Fatalf("cursor query = %q, want abc", query.Get("cursor"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":   true,
			"data": map[string]any{},
		})
	}))
	defer server.Close()

	client := APIClient{BaseURL: server.URL}
	if _, err := client.Do(context.Background(), http.MethodGet, "/api/output/check?limit=25&cursor=abc", "bearer-fixture", nil, nil); err != nil {
		t.Fatalf("Do failed: %v", err)
	}
}

func TestJoinBaseAndPathRejectsUnsafeAPIPaths(t *testing.T) {
	for name, apiPath := range map[string]string{
		"absolute URL":            "https://evil.example/api/output/check",
		"authority with userinfo": "//user:pass@evil.example/api/output/check",
		"relative path with hash": "/api/output/check#access-token",
	} {
		t.Run(name, func(t *testing.T) {
			_, err := joinBaseAndPath("https://app.agent-outbox.dev", apiPath)
			appErr, ok := err.(*AppError)
			if !ok {
				t.Fatalf("error type = %T, want *AppError", err)
			}
			if appErr.Code != CodeConfig {
				t.Fatalf("error code = %q, want %q", appErr.Code, CodeConfig)
			}
		})
	}
}

func TestAPIClientParsesErrorEnvelopeRetryAfterAndDoesNotRetry(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":             false,
			"request_id":     "req_rate",
			"correlation_id": "corr_rate",
			"error": map[string]any{
				"code":    "rate_limit_exceeded",
				"message": "Rate limit exceeded.",
			},
		})
	}))
	defer server.Close()

	client := APIClient{BaseURL: server.URL}
	_, err := client.Do(context.Background(), http.MethodGet, "/api/example", "bearer-fixture", nil, nil)
	appErr, ok := err.(*AppError)
	if !ok {
		t.Fatalf("error type = %T, want *AppError", err)
	}
	if appErr.Code != CodeRateLimitExceeded {
		t.Fatalf("error code = %q", appErr.Code)
	}
	if appErr.RetryAfterSeconds == nil || *appErr.RetryAfterSeconds != 7 {
		t.Fatalf("retry-after was not captured")
	}
	if requests != 1 {
		t.Fatalf("request count = %d, want no retry", requests)
	}
}

func TestAPIClientPreservesLimitMetadataInRenderedJSONError(t *testing.T) {
	resetAt := "2026-07-01T00:00:00Z"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":             false,
			"request_id":     "req_quota",
			"correlation_id": "corr_quota",
			"error": map[string]any{
				"code":    "quota_limit_exceeded",
				"message": "Monthly caller API request limit reached.",
				"limit": map[string]any{
					"limit_name":        "authenticated_caller_api_requests_per_calendar_month",
					"limit_reason_code": "monthly_caller_api_quota_exceeded",
					"limit_reason":      "Monthly caller API request limit reached; cleanup operations remain available.",
					"limit_resets_at":   resetAt,
				},
			},
		})
	}))
	defer server.Close()

	client := APIClient{BaseURL: server.URL}
	_, err := client.Do(context.Background(), http.MethodGet, "/api/example", "bearer-fixture", nil, nil)
	appErr, ok := err.(*AppError)
	if !ok {
		t.Fatalf("error type = %T, want *AppError", err)
	}
	if appErr.Limit == nil {
		t.Fatalf("limit metadata was not captured")
	}
	if appErr.Limit.LimitName != "authenticated_caller_api_requests_per_calendar_month" {
		t.Fatalf("limit name = %q", appErr.Limit.LimitName)
	}
	if appErr.Limit.LimitResetsAt == nil || *appErr.Limit.LimitResetsAt != resetAt {
		t.Fatalf("limit reset timestamp was not preserved")
	}

	var rendered bytes.Buffer
	RenderError(&rendered, true, appErr)
	errorBody := renderedErrorBody(t, rendered.Bytes())
	limit := renderedObject(t, errorBody, "limit")
	if limit["limit_reason_code"] != "monthly_caller_api_quota_exceeded" {
		t.Fatalf("rendered limit reason code = %v", limit["limit_reason_code"])
	}
	if limit["limit_resets_at"] != resetAt {
		t.Fatalf("rendered limit reset = %v", limit["limit_resets_at"])
	}
}

func TestAPIClientPreservesUpgradeMetadataInRenderedJSONError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusPaymentRequired)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":             false,
			"request_id":     "req_upgrade",
			"correlation_id": "corr_upgrade",
			"error": map[string]any{
				"code":    "upgrade_required",
				"message": "File upload actions require a paid hosted account.",
				"upgrade": map[string]any{
					"message": "File upload actions require a paid hosted account.",
					"url":     "https://app.agent-outbox.dev/upgrade",
				},
			},
		})
	}))
	defer server.Close()

	client := APIClient{BaseURL: server.URL}
	_, err := client.Do(context.Background(), http.MethodPost, "/api/example", "bearer-fixture", map[string]string{"kind": "file_upload"}, nil)
	appErr, ok := err.(*AppError)
	if !ok {
		t.Fatalf("error type = %T, want *AppError", err)
	}
	if appErr.Upgrade == nil {
		t.Fatalf("upgrade metadata was not captured")
	}
	if appErr.Upgrade.URL != "https://app.agent-outbox.dev/upgrade" {
		t.Fatalf("upgrade url = %q", appErr.Upgrade.URL)
	}

	var rendered bytes.Buffer
	RenderError(&rendered, true, appErr)
	errorBody := renderedErrorBody(t, rendered.Bytes())
	upgrade := renderedObject(t, errorBody, "upgrade")
	if upgrade["url"] != "https://app.agent-outbox.dev/upgrade" {
		t.Fatalf("rendered upgrade url = %v", upgrade["url"])
	}
	if upgrade["message"] != "File upload actions require a paid hosted account." {
		t.Fatalf("rendered upgrade message = %v", upgrade["message"])
	}
}

func TestAPIClientPreservesErrorIDInRenderedJSONError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":             false,
			"request_id":     "req_internal",
			"correlation_id": "corr_internal",
			"error": map[string]any{
				"code":     "internal_error",
				"message":  "Unexpected server error.",
				"error_id": "err_01JZ4Y6T9K0Z3S8W7R1A2B3C4D",
			},
		})
	}))
	defer server.Close()

	client := APIClient{BaseURL: server.URL}
	_, err := client.Do(context.Background(), http.MethodGet, "/api/example", "bearer-fixture", nil, nil)
	appErr, ok := err.(*AppError)
	if !ok {
		t.Fatalf("error type = %T, want *AppError", err)
	}
	if appErr.ErrorID != "err_01JZ4Y6T9K0Z3S8W7R1A2B3C4D" {
		t.Fatalf("error id = %q", appErr.ErrorID)
	}

	var rendered bytes.Buffer
	RenderError(&rendered, true, appErr)
	errorBody := renderedErrorBody(t, rendered.Bytes())
	if errorBody["error_id"] != "err_01JZ4Y6T9K0Z3S8W7R1A2B3C4D" {
		t.Fatalf("rendered error id = %v", errorBody["error_id"])
	}
}

func TestReadBodyWithLimit(t *testing.T) {
	data, oversized, err := readBodyWithLimit(strings.NewReader("seventeen bytes!!"), 16)
	if err != nil {
		t.Fatalf("readBodyWithLimit returned an error: %v", err)
	}
	if !oversized {
		t.Fatal("oversized = false, want true")
	}
	if got, want := string(data), "seventeen bytes!!"; got != want {
		t.Fatalf("data = %q, want %q", got, want)
	}
}

func TestAPIClientDownloadRejectsAdvertisedOversizeBeforeWriting(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", strconv.FormatInt(maxOutputFileDownloadBytes+1, 10))
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	dst := &countingWriter{}
	_, err := (APIClient{BaseURL: server.URL}).Download(context.Background(), "/api/output/out_1/files/file_1", "bearer-fixture", dst)
	assertDownloadOversizeError(t, err)
	if dst.bytes != 0 {
		t.Fatalf("destination bytes = %d, want 0", dst.bytes)
	}
}

func TestAPIClientDownloadRejectsLengthlessOversizeWithoutWritingProbeByte(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		_, _ = io.Copy(w, &repeatedByteReader{remaining: maxOutputFileDownloadBytes + 1})
	}))
	defer server.Close()

	dst := &countingWriter{}
	meta, err := (APIClient{BaseURL: server.URL}).Download(context.Background(), "/api/output/out_1/files/file_1", "bearer-fixture", dst)
	assertDownloadOversizeError(t, err)
	if meta.ContentLength != -1 {
		t.Fatalf("content length = %d, want unknown", meta.ContentLength)
	}
	if dst.bytes != maxOutputFileDownloadBytes {
		t.Fatalf("destination bytes = %d, want %d", dst.bytes, maxOutputFileDownloadBytes)
	}
}

func TestAPIClientDownloadAcceptsFilesAtOrBelowLimit(t *testing.T) {
	for name, size := range map[string]int64{
		"smaller file": 17,
		"exact limit":  maxOutputFileDownloadBytes,
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
				_, _ = io.Copy(w, &repeatedByteReader{remaining: size})
			}))
			defer server.Close()

			dst := &countingWriter{}
			meta, err := (APIClient{BaseURL: server.URL}).Download(context.Background(), "/api/output/out_1/files/file_1", "bearer-fixture", dst)
			if err != nil {
				t.Fatalf("Download failed: %v", err)
			}
			if meta.ContentLength != size {
				t.Fatalf("content length = %d, want %d", meta.ContentLength, size)
			}
			if dst.bytes != size {
				t.Fatalf("destination bytes = %d, want %d", dst.bytes, size)
			}
		})
	}
}

func assertDownloadOversizeError(t *testing.T, err error) {
	t.Helper()

	appErr, ok := err.(*AppError)
	if !ok {
		t.Fatalf("error type = %T, want *AppError", err)
	}
	if appErr.Code != CodeTemporaryUnavailable {
		t.Fatalf("error code = %q, want %q", appErr.Code, CodeTemporaryUnavailable)
	}
	if appErr.Message != "Output file exceeded the maximum size." {
		t.Fatalf("error message = %q", appErr.Message)
	}
}

type countingWriter struct {
	bytes int64
}

func (w *countingWriter) Write(data []byte) (int, error) {
	w.bytes += int64(len(data))
	return len(data), nil
}

type repeatedByteReader struct {
	remaining int64
}

func (r *repeatedByteReader) Read(data []byte) (int, error) {
	if r.remaining == 0 {
		return 0, io.EOF
	}
	n := int64(len(data))
	if n > r.remaining {
		n = r.remaining
	}
	for i := range data[:n] {
		data[i] = 'x'
	}
	r.remaining -= n
	return int(n), nil
}

func renderedErrorBody(t *testing.T, data []byte) map[string]any {
	t.Helper()

	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatalf("rendered error is not valid JSON: %v", err)
	}
	return renderedObject(t, payload, "error")
}

func renderedObject(t *testing.T, parent map[string]any, key string) map[string]any {
	t.Helper()

	value, ok := parent[key]
	if !ok {
		t.Fatalf("rendered JSON missing %q", key)
	}
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("rendered %q type = %T, want object", key, value)
	}
	return object
}
