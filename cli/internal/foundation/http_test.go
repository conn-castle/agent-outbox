package foundation

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
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

func TestAPIClientUsesResolvedIPv6ZoneOrigins(t *testing.T) {
	for _, tc := range []struct {
		origin string
		host   string
	}{
		{origin: "https://[fe80::1%25Eth0]", host: "[fe80::1%Eth0]"},
		{origin: "https://[fe80::1%25eth%2525]:0443", host: "[fe80::1%eth%25]:0443"},
	} {
		for _, operation := range []string{"do", "download"} {
			t.Run(tc.origin+"/"+operation, func(t *testing.T) {
				baseURL, err := ResolveBaseURL(tc.origin, nil, Config{})
				if err != nil {
					t.Fatal(err)
				}
				requests := 0
				client := APIClient{BaseURL: baseURL, HTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
					requests++
					if r.Method != http.MethodGet || r.URL.Host != tc.host || r.URL.String() != tc.origin+"/api/example" || r.Header.Get("Authorization") != "Bearer zone-fixture" {
						t.Fatalf("unexpected request: %s %s host=%q authorization=%q", r.Method, r.URL, r.URL.Host, r.Header.Get("Authorization"))
					}
					w := httptest.NewRecorder()
					if operation == "do" {
						w.Header().Set("Content-Type", "application/json")
						_, _ = io.WriteString(w, `{"ok":true,"data":{"value":"zone-response"}}`)
					} else {
						w.Header().Set("Content-Type", "application/octet-stream")
						_, _ = io.WriteString(w, "zone-response")
					}
					return w.Result(), nil
				})}}
				var got string
				if operation == "do" {
					var out struct{ Value string }
					_, err = client.Do(context.Background(), http.MethodGet, "/api/example", "zone-fixture", nil, &out)
					got = out.Value
				} else {
					var dst bytes.Buffer
					_, err = client.Download(context.Background(), "/api/example", "zone-fixture", &dst)
					got = dst.String()
				}
				if err != nil || got != "zone-response" || requests != 1 {
					t.Fatalf("response=%q requests=%d err=%v, want successful zoned-origin request", got, requests, err)
				}
			})
		}
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

func TestAPIClientRejectsMalformedErrorEnvelopeWithoutInventingServiceClassification(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Correlation-ID", "corr_proxy")
		w.Header().Set("Retry-After", "4")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, `{"ok":false,"request_id":"req_body"}`)
	}))
	defer server.Close()

	client := APIClient{
		BaseURL:      server.URL,
		NewRequestID: func() string { return "req_client" },
	}
	_, err := client.Do(context.Background(), http.MethodGet, "/api/example", "bearer-fixture", nil, nil)
	appErr, ok := err.(*AppError)
	if !ok {
		t.Fatalf("error type = %T, want *AppError", err)
	}
	if appErr.Code != CodeAPIResponseInvalid {
		t.Fatalf("error code = %q, want %q", appErr.Code, CodeAPIResponseInvalid)
	}
	if appErr.HTTPStatus != http.StatusBadGateway {
		t.Fatalf("http status = %d, want %d", appErr.HTTPStatus, http.StatusBadGateway)
	}
	if appErr.RequestID != "req_body" || appErr.CorrelationID != "corr_proxy" {
		t.Fatalf("response ids = %q/%q", appErr.RequestID, appErr.CorrelationID)
	}
	if appErr.RetryAfterSeconds == nil || *appErr.RetryAfterSeconds != 4 {
		t.Fatalf("retry-after was not preserved")
	}
	if appErr.WriteOutcome != "" {
		t.Fatalf("read failure write outcome = %q, want omitted", appErr.WriteOutcome)
	}

	var rendered bytes.Buffer
	RenderError(&rendered, true, appErr)
	errorBody := renderedErrorBody(t, rendered.Bytes())
	if errorBody["http_status"] != float64(http.StatusBadGateway) {
		t.Fatalf("rendered http status = %v", errorBody["http_status"])
	}
	if errorBody["code"] != string(CodeAPIResponseInvalid) {
		t.Fatalf("rendered error code = %v", errorBody["code"])
	}
}

func TestAPIClientRetainsGeneratedRequestIDWhenResponseCannotEchoIt(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{}`)
	}))
	defer server.Close()

	client := APIClient{
		BaseURL:      server.URL,
		NewRequestID: func() string { return "req_client" },
	}
	_, err := client.Do(context.Background(), http.MethodGet, "/api/example", "bearer-fixture", nil, nil)
	appErr, ok := err.(*AppError)
	if !ok {
		t.Fatalf("error type = %T, want *AppError", err)
	}
	if appErr.Code != CodeAPIResponseInvalid || appErr.RequestID != "req_client" {
		t.Fatalf("error code/request id = %q/%q", appErr.Code, appErr.RequestID)
	}
	if appErr.CorrelationID != "" {
		t.Fatalf("invented correlation id = %q", appErr.CorrelationID)
	}
}

func TestAPIClientClassifiesTransportAndBodyReadFailuresAsUnavailable(t *testing.T) {
	t.Run("transport", func(t *testing.T) {
		client := APIClient{
			BaseURL: "https://app.example",
			HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return nil, errors.New("fixture transport failure")
			})},
			NewRequestID: func() string { return "req_transport" },
		}

		_, err := client.Do(context.Background(), http.MethodGet, "/api/example", "bearer-fixture", nil, nil)
		assertAPIUnavailable(t, err, "req_transport")
	})

	t.Run("response body", func(t *testing.T) {
		client := APIClient{
			BaseURL: "https://app.example",
			HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     make(http.Header),
					Body:       io.NopCloser(errorReader{err: errors.New("fixture body failure")}),
				}, nil
			})},
			NewRequestID: func() string { return "req_body_read" },
		}

		_, err := client.Do(context.Background(), http.MethodGet, "/api/example", "bearer-fixture", nil, nil)
		assertAPIUnavailable(t, err, "req_body_read")
	})
}

func TestAPIClientPreservesSafeUnderlyingErrorFactsFromInvalidEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"ok":false,"request_id":"req_partial","error":{"code":"temporary_unavailable","message":"sensitive upstream text","fields":[{"path":"payload","code":"unsafe","message":"sensitive field text"}],"retry_after_seconds":3,"error_id":"err_partial","limit":{"limit_name":"api_requests","limit_reason_code":"api_limit","limit_reason":"sensitive limit text","limit_resets_at":"2026-09-04T00:00:00Z"},"upgrade":{"message":"sensitive upgrade text","url":"https://example.test/private"}}}`)
	}))
	defer server.Close()

	_, err := (APIClient{BaseURL: server.URL}).Do(context.Background(), http.MethodGet, "/api/example", "bearer-fixture", nil, nil)
	appErr, ok := err.(*AppError)
	if !ok {
		t.Fatalf("error type = %T, want *AppError", err)
	}
	if appErr.Code != CodeAPIResponseInvalid || appErr.UpstreamErrorCode != CodeTemporaryUnavailable {
		t.Fatalf("error code/upstream code = %q/%q", appErr.Code, appErr.UpstreamErrorCode)
	}
	if appErr.ErrorID != "err_partial" {
		t.Fatalf("error id = %q", appErr.ErrorID)
	}
	if appErr.RetryAfterSeconds == nil || *appErr.RetryAfterSeconds != 3 {
		t.Fatalf("body retry metadata was not preserved")
	}
	if appErr.Limit == nil || appErr.Limit.LimitName != "api_requests" || appErr.Limit.LimitReasonCode != "api_limit" || appErr.Limit.LimitReason != "" {
		t.Fatalf("safe partial limit metadata = %#v", appErr.Limit)
	}
	if appErr.Upgrade != nil || len(appErr.Fields) != 0 {
		t.Fatalf("untrusted structured metadata survived: fields=%#v upgrade=%#v", appErr.Fields, appErr.Upgrade)
	}
	var rendered bytes.Buffer
	RenderError(&rendered, true, appErr)
	for _, forbidden := range []string{"sensitive upstream text", "sensitive field text", "sensitive limit text", "sensitive upgrade text", "example.test/private"} {
		if strings.Contains(rendered.String(), forbidden) {
			t.Fatalf("rendered diagnostics included untrusted text %q: %s", forbidden, rendered.String())
		}
	}
}

func TestAPIClientDropsSecretsAndFreeTextFromInvalidEnvelopeDiagnostics(t *testing.T) {
	const secret = "aob_live_keyid_supersecret"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Request-ID", "req_"+secret)
		w.Header().Set("X-Correlation-ID", "corr."+secret)
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"ok":false,"request_id":"req_`+secret+`","correlation_id":"corr.`+secret+`","error":{"code":"`+secret+`","message":"upstream `+secret+`","fields":[{"path":"payload","code":"unsafe","message":"field `+secret+`"}],"error_id":"err_`+secret+`","retry_after_seconds":3,"limit":{"limit_name":"limit_`+secret+`","limit_reason_code":"reason_`+secret+`","limit_reason":"limit `+secret+`"},"upgrade":{"url":"https://example.test/?key=`+secret+`"}}}`)
	}))
	defer server.Close()

	client := APIClient{BaseURL: server.URL, NewRequestID: func() string { return "req_generated" }}
	_, err := client.Do(context.Background(), http.MethodGet, "/api/example", secret, nil, nil)
	appErr, ok := err.(*AppError)
	if !ok {
		t.Fatalf("error type = %T, want *AppError", err)
	}
	var rendered bytes.Buffer
	RenderError(&rendered, true, appErr)
	if strings.Contains(rendered.String(), secret) {
		t.Fatalf("rendered diagnostics leaked credential: %s", rendered.String())
	}
	if appErr.RequestID != "req_generated" || appErr.CorrelationID != "" || appErr.UpstreamErrorCode != "" || appErr.ErrorID != "" || appErr.Limit != nil || appErr.Upgrade != nil || len(appErr.Fields) != 0 {
		t.Fatalf("unsafe malformed-envelope metadata survived sanitization: %#v", appErr)
	}
}

func TestAPIClientWriteOutcomesDistinguishValidErrorsAndAmbiguousResponses(t *testing.T) {
	tests := []struct {
		name        string
		status      int
		body        string
		wantCode    ErrorCode
		wantOutcome string
	}{
		{
			name:        "classified rejection",
			status:      http.StatusTooManyRequests,
			body:        `{"ok":false,"request_id":"req_write","correlation_id":"corr_write","error":{"code":"rate_limit_exceeded","message":"Rate limit exceeded."}}`,
			wantCode:    CodeRateLimitExceeded,
			wantOutcome: "not_accepted",
		},
		{
			name:        "internal error",
			status:      http.StatusInternalServerError,
			body:        `{"ok":false,"request_id":"req_write","correlation_id":"corr_write","error":{"code":"internal_error","message":"Unexpected server error."}}`,
			wantCode:    CodeInternalError,
			wantOutcome: "unknown",
		},
		{
			name:        "temporary unavailable",
			status:      http.StatusServiceUnavailable,
			body:        `{"ok":false,"request_id":"req_write","correlation_id":"corr_write","error":{"code":"temporary_unavailable","message":"Temporarily unavailable."}}`,
			wantCode:    CodeTemporaryUnavailable,
			wantOutcome: "unknown",
		},
		{
			name:        "malformed response",
			status:      http.StatusServiceUnavailable,
			body:        `{}`,
			wantCode:    CodeAPIResponseInvalid,
			wantOutcome: "unknown",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.status)
				_, _ = io.WriteString(w, tt.body)
			}))
			defer server.Close()

			client := APIClient{
				BaseURL:      server.URL,
				NewRequestID: func() string { return "req_client" },
			}
			_, err := client.DoWrite(context.Background(), http.MethodPost, "/api/input/send", "bearer-fixture", map[string]string{"caller_item_id": "stable"}, nil)
			appErr, ok := err.(*AppError)
			if !ok {
				t.Fatalf("error type = %T, want *AppError", err)
			}
			if appErr.Code != tt.wantCode || appErr.WriteOutcome != tt.wantOutcome {
				t.Fatalf("error code/write outcome = %q/%q, want %q/%q", appErr.Code, appErr.WriteOutcome, tt.wantCode, tt.wantOutcome)
			}
		})
	}
}

func TestAPIClientTypedSuccessRejectsNullData(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"ok":true,"request_id":"req_write","correlation_id":"corr_write","data":null}`)
	}))
	defer server.Close()

	var out struct {
		Value string `json:"value"`
	}
	_, err := (APIClient{BaseURL: server.URL}).DoWrite(context.Background(), http.MethodPost, "/api/input/send", "bearer-fixture", map[string]string{"caller_item_id": "stable"}, &out)
	appErr, ok := err.(*AppError)
	if !ok {
		t.Fatalf("error type = %T, want *AppError", err)
	}
	if appErr.Code != CodeAPIResponseInvalid || appErr.WriteOutcome != "accepted" {
		t.Fatalf("error code/write outcome = %q/%q", appErr.Code, appErr.WriteOutcome)
	}
	if out.Value != "" {
		t.Fatalf("typed output was decoded from null data: %#v", out)
	}
}

func TestAPIClientWriteSuccessWithUndecodableDataReportsAccepted(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"ok":true,"request_id":"req_write","correlation_id":"corr_write","data":"not-an-object"}`)
	}))
	defer server.Close()

	var out struct {
		Value string `json:"value"`
	}
	_, err := (APIClient{BaseURL: server.URL}).DoWrite(context.Background(), http.MethodPost, "/api/input/send", "bearer-fixture", map[string]string{"caller_item_id": "stable"}, &out)
	appErr, ok := err.(*AppError)
	if !ok {
		t.Fatalf("error type = %T, want *AppError", err)
	}
	if appErr.Code != CodeAPIResponseInvalid || appErr.WriteOutcome != "accepted" {
		t.Fatalf("error code/write outcome = %q/%q", appErr.Code, appErr.WriteOutcome)
	}
}

func TestAPIClientRawWriteSuccessRequiresNonemptyObjectData(t *testing.T) {
	for _, data := range []string{"", `null`, `[]`, `{}`, `"not-an-object"`} {
		t.Run(data, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				body := `{"ok":true,"request_id":"req_write","correlation_id":"corr_write"}`
				if data != "" {
					body = `{"ok":true,"request_id":"req_write","correlation_id":"corr_write","data":` + data + `}`
				}
				_, _ = io.WriteString(w, body)
			}))
			defer server.Close()

			var out json.RawMessage
			_, err := (APIClient{BaseURL: server.URL}).DoWrite(context.Background(), http.MethodPost, "/api/input/send", "bearer-fixture", nil, &out)
			appErr, ok := err.(*AppError)
			if !ok {
				t.Fatalf("error type = %T, want *AppError", err)
			}
			if appErr.Code != CodeAPIResponseInvalid || appErr.WriteOutcome != "accepted" {
				t.Fatalf("error code/write outcome = %q/%q", appErr.Code, appErr.WriteOutcome)
			}
		})
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
	if dst.bytes != 0 {
		t.Fatalf("destination bytes = %d, want 0", dst.bytes)
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

func TestAPIClientDownloadClassifiesResponseReadFailureAsUnavailable(t *testing.T) {
	client := APIClient{
		BaseURL: "https://app.example",
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(errorReader{err: errors.New("fixture download read failure")}),
			}, nil
		})},
		NewRequestID: func() string { return "req_download" },
	}

	dst := &countingWriter{}
	_, err := client.Download(context.Background(), "/api/output/out_1/files/file_1", "bearer-fixture", dst)
	assertAPIUnavailable(t, err, "req_download")
	if dst.bytes != 0 {
		t.Fatalf("destination bytes = %d, want 0", dst.bytes)
	}
}

func TestAPIClientDownloadClassifiesDestinationWriteFailureAsLocalIO(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "file bytes")
	}))
	defer server.Close()

	_, err := (APIClient{BaseURL: server.URL}).Download(
		context.Background(),
		"/api/output/out_1/files/file_1",
		"bearer-fixture",
		errorWriter{err: errors.New("fixture destination failure")},
	)
	appErr, ok := err.(*AppError)
	if !ok {
		t.Fatalf("error type = %T, want *AppError", err)
	}
	if appErr.Code != CodeLocalIO {
		t.Fatalf("error code = %q, want %q", appErr.Code, CodeLocalIO)
	}
}

func TestKnownAPIErrorCodesHaveExpectedHTTPStatuses(t *testing.T) {
	want := map[ErrorCode]int{
		CodeInvalidRequest: http.StatusBadRequest, CodeInvalidJSON: http.StatusBadRequest,
		CodeRequestTooLarge:  http.StatusRequestEntityTooLarge,
		CodeValidationFailed: http.StatusUnprocessableEntity, CodeUnsupportedIcon: http.StatusUnprocessableEntity,
		CodeUnsafeHTML: http.StatusUnprocessableEntity, CodeUnsafeColor: http.StatusUnprocessableEntity,
		CodeInvalidActionResponse: http.StatusUnprocessableEntity,
		CodeUpgradeRequired:       http.StatusPaymentRequired, CodeBillingGraceExpired: http.StatusPaymentRequired,
		CodeAuthenticationRequired: http.StatusUnauthorized, CodeInvalidCallerCredentials: http.StatusUnauthorized,
		CodeAuthorizationFailed: http.StatusForbidden, CodeNotFound: http.StatusNotFound,
		CodeCallerAlreadyExists: http.StatusConflict, CodePendingContentConflict: http.StatusConflict,
		CodeAnsweredUnacknowledged: http.StatusConflict, CodeInputNotPending: http.StatusConflict,
		CodeStaleInputRevision: http.StatusConflict, CodeOutputAlreadyRead: http.StatusConflict,
		CodeRateLimitExceeded: http.StatusTooManyRequests, CodeQuotaLimitExceeded: http.StatusTooManyRequests,
		CodeStorageLimitExceeded: http.StatusTooManyRequests, CodeRetentionLimitExceeded: http.StatusTooManyRequests,
		CodeAuthorizationPending: http.StatusAccepted, CodeTemporaryUnavailable: http.StatusServiceUnavailable,
		CodeInternalError: http.StatusInternalServerError,
	}
	if len(want) != 27 {
		t.Fatalf("status contract covers %d codes, want 27", len(want))
	}
	for code, status := range want {
		if !knownAPIErrorCode(code) {
			t.Errorf("knownAPIErrorCode(%q) = false", code)
		}
		if got := expectedHTTPStatus(code); got != status {
			t.Errorf("expectedHTTPStatus(%q) = %d, want %d", code, got, status)
		}
	}
}

func assertDownloadOversizeError(t *testing.T, err error) {
	t.Helper()

	appErr, ok := err.(*AppError)
	if !ok {
		t.Fatalf("error type = %T, want *AppError", err)
	}
	if appErr.Code != CodeAPIResponseInvalid {
		t.Fatalf("error code = %q, want %q", appErr.Code, CodeAPIResponseInvalid)
	}
	if appErr.Message != "Output file exceeded the maximum size." {
		t.Fatalf("error message = %q", appErr.Message)
	}
}

func assertAPIUnavailable(t *testing.T, err error, requestID string) {
	t.Helper()
	appErr, ok := err.(*AppError)
	if !ok {
		t.Fatalf("error type = %T, want *AppError", err)
	}
	if appErr.Code != CodeAPIUnavailable || appErr.RequestID != requestID {
		t.Fatalf("error code/request id = %q/%q, want %q/%q", appErr.Code, appErr.RequestID, CodeAPIUnavailable, requestID)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

type errorReader struct {
	err error
}

func (r errorReader) Read([]byte) (int, error) {
	return 0, r.err
}

type errorWriter struct {
	err error
}

func (w errorWriter) Write([]byte) (int, error) {
	return 0, w.err
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

func TestAPIClientRefusesRedirectsThatWouldSendCredentialsOverCleartext(t *testing.T) {
	for _, tc := range []struct {
		name     string
		redirect string
		write    bool
		download bool
	}{
		{name: "same host read", redirect: "http://app.example.test"},
		{name: "subdomain write", redirect: "http://api.app.example.test", write: true},
		{name: "same host download", redirect: "http://app.example.test", download: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cleartext := newCredentialRecordingServer(t, httptest.NewServer)
			origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Request-ID", "req_redirect")
				http.Redirect(w, r, tc.redirect+":"+cleartext.port+r.URL.Path, http.StatusTemporaryRedirect)
			}))
			defer origin.Close()

			client := APIClient{BaseURL: "https://app.example.test:" + serverPort(t, origin), HTTPClient: hostMappingClient()}
			var err error
			switch {
			case tc.download:
				_, err = client.Download(context.Background(), "/api/output/out_1/files/file_1", "aob_live_fixture", &countingWriter{})
			case tc.write:
				_, err = client.DoWrite(context.Background(), http.MethodPost, "/api/input", "aob_live_fixture", map[string]string{"content": "secret body"}, nil)
			default:
				_, err = client.Do(context.Background(), http.MethodGet, "/api/caller/status", "aob_live_fixture", nil, nil)
			}

			if cleartext.hits != 0 {
				t.Fatalf("cleartext server received %d request(s); Authorization=%q", cleartext.hits, cleartext.authorization)
			}
			var appErr *AppError
			if !errors.As(err, &appErr) {
				t.Fatalf("error = %v, want *AppError", err)
			}
			if appErr.Code != CodeAPIResponseInvalid || ExitCodeFor(err) != ExitTemporary {
				t.Fatalf("error code = %q exit = %d, want %q exit %d", appErr.Code, ExitCodeFor(err), CodeAPIResponseInvalid, ExitTemporary)
			}
			if appErr.HTTPStatus != http.StatusTemporaryRedirect || appErr.RequestID != "req_redirect" {
				t.Fatalf("http status = %d request id = %q, want redirect response metadata", appErr.HTTPStatus, appErr.RequestID)
			}
			wantOutcome := ""
			if tc.write {
				wantOutcome = "unknown"
			}
			if appErr.WriteOutcome != wantOutcome {
				t.Fatalf("write outcome = %q, want %q", appErr.WriteOutcome, wantOutcome)
			}
			var rendered bytes.Buffer
			RenderError(&rendered, true, err)
			if strings.Contains(rendered.String(), "aob_live_fixture") || strings.Contains(rendered.String(), "http://") {
				t.Fatalf("rendered error exposes the key or redirect target: %s", rendered.String())
			}
		})
	}
}

func TestAPIClientRefusesRedirectFromLoopbackHTTPToNonLoopbackHTTP(t *testing.T) {
	cleartext := newCredentialRecordingServer(t, httptest.NewServer)
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://app.example.test:"+cleartext.port+r.URL.Path, http.StatusPermanentRedirect)
	}))
	defer origin.Close()

	client := APIClient{BaseURL: "http://localhost:" + serverPort(t, origin), HTTPClient: hostMappingClient()}
	_, err := client.Do(context.Background(), http.MethodGet, "/api/caller/status", "aob_live_fixture", nil, nil)

	if cleartext.hits != 0 {
		t.Fatalf("cleartext server received %d request(s)", cleartext.hits)
	}
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Code != CodeAPIResponseInvalid {
		t.Fatalf("error = %v, want %q", err, CodeAPIResponseInvalid)
	}
}

func TestAPIClientFollowsHTTPSRedirectToAppSubdomainWithCredentials(t *testing.T) {
	app := newCredentialRecordingServer(t, httptest.NewTLSServer)
	website := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://app.example.test:"+app.port+r.URL.Path, http.StatusPermanentRedirect)
	}))
	defer website.Close()

	client := APIClient{BaseURL: "https://example.test:" + serverPort(t, website), HTTPClient: hostMappingClient()}
	var out struct {
		Value string `json:"value"`
	}
	if _, err := client.DoWrite(context.Background(), http.MethodPost, "/api/input", "aob_live_fixture", map[string]string{"content": "body"}, &out); err != nil {
		t.Fatalf("DoWrite failed: %v", err)
	}
	if app.hits != 1 || app.authorization != "Bearer aob_live_fixture" || out.Value != "ok" {
		t.Fatalf("app hits = %d authorization = %q value = %q", app.hits, app.authorization, out.Value)
	}
}

func TestAPIClientFollowsLoopbackHTTPRedirectWithCredentials(t *testing.T) {
	target := newCredentialRecordingServer(t, httptest.NewServer)
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://localhost:"+target.port+r.URL.Path, http.StatusTemporaryRedirect)
	}))
	defer origin.Close()

	client := APIClient{BaseURL: "http://localhost:" + serverPort(t, origin)}
	if _, err := client.Do(context.Background(), http.MethodGet, "/api/caller/status", "aob_live_fixture", nil, nil); err != nil {
		t.Fatalf("Do failed: %v", err)
	}
	if target.hits != 1 || target.authorization != "Bearer aob_live_fixture" {
		t.Fatalf("target hits = %d authorization = %q", target.hits, target.authorization)
	}
}

func TestAPIClientHonorsInjectedRedirectPolicyAfterTransportCheck(t *testing.T) {
	policyErr := errors.New("cross-host redirect refused")
	for _, tc := range []struct {
		name          string
		target        string
		hops          int
		policy        func(*http.Request, []*http.Request) error
		wantRequests  int
		wantCallbacks int
		wantCode      ErrorCode
	}{
		{
			name: "reject cross-host", target: "https://app.example.test/api/target", hops: 1,
			policy: func(req *http.Request, via []*http.Request) error {
				if req.URL.Host != via[0].URL.Host {
					return policyErr
				}
				return nil
			},
			wantRequests: 1, wantCallbacks: 1, wantCode: CodeAPIUnavailable,
		},
		{
			name: "use last response", target: "https://app.example.test/api/target", hops: 1,
			policy:       func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
			wantRequests: 1, wantCallbacks: 1, wantCode: CodeAPIResponseInvalid,
		},
		{
			name: "allow secure redirect", target: "https://app.example.test/api/target", hops: 1,
			policy:       func(*http.Request, []*http.Request) error { return nil },
			wantRequests: 2, wantCallbacks: 1,
		},
		{
			name: "custom policy replaces default cap", target: "https://app.example.test/api/target", hops: 11,
			policy:       func(*http.Request, []*http.Request) error { return nil },
			wantRequests: 12, wantCallbacks: 11,
		},
		{
			name: "stricter custom hop limit", target: "https://app.example.test/api/target", hops: 11,
			policy: func(_ *http.Request, via []*http.Request) error {
				if len(via) >= 2 {
					return errors.New("stopped after 2 requests")
				}
				return nil
			},
			wantRequests: 2, wantCallbacks: 2, wantCode: CodeAPIUnavailable,
		},
		{
			name: "nil policy keeps default cap", target: "https://app.example.test/api/target", hops: 11,
			wantRequests: 10, wantCode: CodeAPIUnavailable,
		},
		{
			name: "insecure target before allowing policy", target: "http://app.example.test/api/target", hops: 1,
			policy:       func(*http.Request, []*http.Request) error { return nil },
			wantRequests: 1, wantCode: CodeAPIResponseInvalid,
		},
		{
			name: "insecure target before last response policy", target: "http://app.example.test/api/target", hops: 1,
			policy:       func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
			wantRequests: 1, wantCode: CodeAPIResponseInvalid,
		},
	} {
		for _, operation := range []string{"Do", "DoWrite", "Download"} {
			t.Run(tc.name+"/"+operation, func(t *testing.T) {
				requests, callbacks := 0, 0
				injected := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
					requests++
					if req.Header.Get("Authorization") != "Bearer redirect-policy-fixture" {
						t.Fatal("request lost authorization")
					}
					w := httptest.NewRecorder()
					if requests <= tc.hops {
						w.Header().Set("Location", tc.target)
						w.Header().Set("X-Request-ID", "req_redirect")
						w.Header().Set("X-Correlation-ID", "corr_redirect")
						w.WriteHeader(http.StatusTemporaryRedirect)
						_, _ = io.WriteString(w, "redirect response")
					} else {
						_, _ = io.WriteString(w, `{"ok":true,"data":{"value":"ok"}}`)
					}
					return w.Result(), nil
				})}
				if tc.policy != nil {
					injected.CheckRedirect = func(req *http.Request, via []*http.Request) error {
						callbacks++
						if req.URL.String() != tc.target || len(via) != callbacks || via[0].URL.Host != "example.test" {
							t.Fatal("callback received unexpected redirect request or history")
						}
						return tc.policy(req, via)
					}
				}
				client := APIClient{BaseURL: "https://example.test", HTTPClient: injected}
				var err error
				switch operation {
				case "Do":
					_, err = client.Do(context.Background(), http.MethodGet, "/api/source", "redirect-policy-fixture", nil, nil)
				case "DoWrite":
					_, err = client.DoWrite(context.Background(), http.MethodPost, "/api/source", "redirect-policy-fixture", map[string]string{"content": "body"}, nil)
				case "Download":
					_, err = client.Download(context.Background(), "/api/source", "redirect-policy-fixture", &bytes.Buffer{})
				}
				if requests != tc.wantRequests || callbacks != tc.wantCallbacks {
					t.Fatalf("requests=%d callbacks=%d, want requests=%d callbacks=%d", requests, callbacks, tc.wantRequests, tc.wantCallbacks)
				}
				if tc.wantCode == "" {
					if err != nil {
						t.Fatalf("request failed: %v", err)
					}
					return
				}
				var appErr *AppError
				if !errors.As(err, &appErr) || appErr.Code != tc.wantCode {
					t.Fatalf("error = %v, want %q", err, tc.wantCode)
				}
				if operation == "DoWrite" && appErr.WriteOutcome != "unknown" {
					t.Fatalf("write outcome = %q, want unknown", appErr.WriteOutcome)
				}
				if tc.wantCode == CodeAPIResponseInvalid {
					if appErr.HTTPStatus != http.StatusTemporaryRedirect || appErr.RequestID != "req_redirect" || appErr.CorrelationID != "corr_redirect" || ExitCodeFor(err) != ExitTemporary {
						t.Fatalf("redirect failure lost response metadata or exit code: %+v", appErr)
					}
				}
			})
		}
	}
}

func TestAPIClientStopsRedirectLoops(t *testing.T) {
	hits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		http.Redirect(w, r, r.URL.Path, http.StatusFound)
	}))
	defer server.Close()

	_, err := (APIClient{BaseURL: server.URL}).Do(context.Background(), http.MethodGet, "/api/caller/status", "aob_live_fixture", nil, nil)
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Code != CodeAPIUnavailable {
		t.Fatalf("error = %v, want %q", err, CodeAPIUnavailable)
	}
	if hits != 10 {
		t.Fatalf("server hits = %d, want 10", hits)
	}
}

type credentialRecordingServer struct {
	port          string
	hits          int
	authorization string
}

func newCredentialRecordingServer(t *testing.T, start func(http.Handler) *httptest.Server) *credentialRecordingServer {
	t.Helper()
	recorder := &credentialRecordingServer{}
	server := start(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorder.hits++
		recorder.authorization = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":             true,
			"request_id":     "req_target",
			"correlation_id": "corr_target",
			"data":           map[string]string{"value": "ok"},
		})
	}))
	t.Cleanup(server.Close)
	recorder.port = serverPort(t, server)
	return recorder
}

func serverPort(t *testing.T, server *httptest.Server) string {
	t.Helper()
	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse server URL: %v", err)
	}
	return parsed.Port()
}

// hostMappingClient dials every host name to the loopback listener on the same
// port, so tests can exercise non-loopback host names against local servers.
func hostMappingClient() *http.Client {
	dialer := &net.Dialer{}
	return &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			_, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort("127.0.0.1", port))
		},
	}}
}
