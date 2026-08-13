package foundation

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// defaultHTTPClient bounds connection, TLS-handshake, and response-header waits
// so a server that accepts a connection but stalls before sending response
// headers cannot hang a one-shot CLI command indefinitely. No client-wide
// Timeout is set on purpose: Download streams bounded file response bodies, and
// an overall deadline would truncate a valid download on a slow connection.
// maxJSONResponseBytes bounds the in-memory read of a JSON envelope so a
// malfunctioning or hostile endpoint cannot exhaust memory. Envelopes are small
// (well under the 128 KiB input-body limit); large file bytes use the streaming
// Download path, not this one, so a generous cap never truncates a real response.
const (
	maxJSONResponseBytes       int64 = 64 << 20 // 64 MiB
	maxOutputFileDownloadBytes int64 = SystemContractRawFileBytes
)

var defaultHTTPClient = &http.Client{
	Transport: &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	},
}

type APIClient struct {
	BaseURL      string
	HTTPClient   *http.Client
	NewRequestID func() string
}

type APIResponse struct {
	RequestID         string
	CorrelationID     string
	RetryAfterSeconds *int
}

type DownloadResponse struct {
	APIResponse
	ContentType   string
	ContentLength int64
}

type apiEnvelope struct {
	OK            bool            `json:"ok"`
	RequestID     string          `json:"request_id"`
	CorrelationID string          `json:"correlation_id"`
	Data          json.RawMessage `json:"data"`
	Error         *apiErrorBody   `json:"error"`
}

type apiErrorBody struct {
	Code              ErrorCode        `json:"code"`
	Message           string           `json:"message"`
	Fields            []FieldError     `json:"fields"`
	ErrorID           string           `json:"error_id"`
	RetryAfterSeconds *int             `json:"retry_after_seconds"`
	Limit             *LimitMetadata   `json:"limit"`
	Upgrade           *UpgradeMetadata `json:"upgrade"`
}

func (c APIClient) Do(ctx context.Context, method string, apiPath string, bearerToken string, body any, out any) (*APIResponse, error) {
	base, err := normalizeBaseURL(c.BaseURL)
	if err != nil {
		return nil, err
	}
	endpoint, err := joinBaseAndPath(base, apiPath)
	if err != nil {
		return nil, err
	}

	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, WrapConfigError("Could not encode API request JSON.", err)
		}
		reader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, WrapConfigError("Could not build API request.", err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Request-ID", c.requestID())
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+bearerToken)
	}

	client := c.HTTPClient
	if client == nil {
		client = defaultHTTPClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, &AppError{Code: CodeTemporaryUnavailable, Message: "Could not reach Agent Outbox API.", cause: err}
	}
	defer resp.Body.Close()

	responseMeta := &APIResponse{
		RequestID:         resp.Header.Get("X-Request-ID"),
		CorrelationID:     resp.Header.Get("X-Correlation-ID"),
		RetryAfterSeconds: retryAfterSeconds(resp.Header.Get("Retry-After"), time.Now()),
	}

	data, oversized, err := readBodyWithLimit(resp.Body, maxJSONResponseBytes)
	if err != nil {
		return responseMeta, &AppError{Code: CodeTemporaryUnavailable, Message: "Could not read Agent Outbox API response.", cause: err}
	}
	if oversized {
		return responseMeta, &AppError{Code: CodeTemporaryUnavailable, Message: "Agent Outbox API response exceeded the maximum size."}
	}

	var envelope apiEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return responseMeta, statusError(resp.StatusCode, responseMeta, "Agent Outbox API returned a non-JSON response.")
	}
	if envelope.RequestID != "" {
		responseMeta.RequestID = envelope.RequestID
	}
	if envelope.CorrelationID != "" {
		responseMeta.CorrelationID = envelope.CorrelationID
	}

	if !envelope.OK {
		appErr := appErrorFromEnvelope(&envelope, responseMeta)
		return responseMeta, appErr
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return responseMeta, statusError(resp.StatusCode, responseMeta, "Agent Outbox API returned an unsuccessful response.")
	}
	if out != nil && len(envelope.Data) > 0 {
		if err := json.Unmarshal(envelope.Data, out); err != nil {
			return responseMeta, WrapConfigError("Could not decode Agent Outbox API response data.", err)
		}
	}
	return responseMeta, nil
}

func (c APIClient) Download(ctx context.Context, apiPath string, bearerToken string, dst io.Writer) (*DownloadResponse, error) {
	base, err := normalizeBaseURL(c.BaseURL)
	if err != nil {
		return nil, err
	}
	endpoint, err := joinBaseAndPath(base, apiPath)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, WrapConfigError("Could not build API request.", err)
	}
	req.Header.Set("Accept", "*/*")
	req.Header.Set("X-Request-ID", c.requestID())
	if bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+bearerToken)
	}

	client := c.HTTPClient
	if client == nil {
		client = defaultHTTPClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, &AppError{Code: CodeTemporaryUnavailable, Message: "Could not reach Agent Outbox API.", cause: err}
	}
	defer resp.Body.Close()

	responseMeta := APIResponse{
		RequestID:         resp.Header.Get("X-Request-ID"),
		CorrelationID:     resp.Header.Get("X-Correlation-ID"),
		RetryAfterSeconds: retryAfterSeconds(resp.Header.Get("Retry-After"), time.Now()),
	}
	downloadMeta := &DownloadResponse{
		APIResponse:   responseMeta,
		ContentType:   resp.Header.Get("Content-Type"),
		ContentLength: resp.ContentLength,
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, oversized, readErr := readBodyWithLimit(resp.Body, maxJSONResponseBytes)
		if readErr != nil {
			return downloadMeta, &AppError{Code: CodeTemporaryUnavailable, Message: "Could not read Agent Outbox API response.", cause: readErr}
		}
		if oversized {
			return downloadMeta, &AppError{Code: CodeTemporaryUnavailable, Message: "Agent Outbox API response exceeded the maximum size."}
		}
		var envelope apiEnvelope
		if err := json.Unmarshal(data, &envelope); err != nil {
			return downloadMeta, statusError(resp.StatusCode, &downloadMeta.APIResponse, "Agent Outbox API returned an unsuccessful file-download response.")
		}
		if envelope.RequestID != "" {
			downloadMeta.RequestID = envelope.RequestID
		}
		if envelope.CorrelationID != "" {
			downloadMeta.CorrelationID = envelope.CorrelationID
		}
		return downloadMeta, appErrorFromEnvelope(&envelope, &downloadMeta.APIResponse)
	}

	if resp.ContentLength > maxOutputFileDownloadBytes {
		return downloadMeta, &AppError{Code: CodeTemporaryUnavailable, Message: "Output file exceeded the maximum size."}
	}
	staged, err := os.CreateTemp("", "agent-outbox-download-*")
	if err != nil {
		return downloadMeta, &AppError{Code: CodeTemporaryUnavailable, Message: "Could not stage output file bytes.", cause: err}
	}
	defer func() {
		_ = staged.Close()
		_ = os.Remove(staged.Name())
	}()

	oversized, err := copyBodyWithLimit(staged, resp.Body, maxOutputFileDownloadBytes)
	if err != nil {
		return downloadMeta, &AppError{Code: CodeTemporaryUnavailable, Message: "Could not stage output file bytes.", cause: err}
	}
	if oversized {
		return downloadMeta, &AppError{Code: CodeTemporaryUnavailable, Message: "Output file exceeded the maximum size."}
	}
	if _, err := staged.Seek(0, io.SeekStart); err != nil {
		return downloadMeta, &AppError{Code: CodeTemporaryUnavailable, Message: "Could not stage output file bytes.", cause: err}
	}
	if _, err := io.Copy(dst, staged); err != nil {
		return downloadMeta, &AppError{Code: CodeTemporaryUnavailable, Message: "Could not write output file bytes.", cause: err}
	}
	return downloadMeta, nil
}

func copyBodyWithLimit(dst io.Writer, src io.Reader, byteLimit int64) (bool, error) {
	if _, err := io.Copy(dst, io.LimitReader(src, byteLimit)); err != nil {
		return false, err
	}

	var probe [1]byte
	n, err := src.Read(probe[:])
	if n > 0 {
		return true, nil
	}
	if err == io.EOF {
		return false, nil
	}
	if err == nil {
		return false, io.ErrNoProgress
	}
	return false, err
}

func readBodyWithLimit(reader io.Reader, byteLimit int64) ([]byte, bool, error) {
	data, err := io.ReadAll(io.LimitReader(reader, byteLimit+1))
	if err != nil {
		return nil, false, err
	}
	return data, int64(len(data)) > byteLimit, nil
}

func joinBaseAndPath(base string, apiPath string) (string, error) {
	parsed, err := url.Parse(base)
	if err != nil {
		return "", err
	}

	relative, err := url.Parse(apiPath)
	if err != nil {
		return "", WrapConfigError("Agent Outbox API path is not valid.", err)
	}
	if relative.IsAbs() || relative.Host != "" || relative.User != nil {
		return "", NewAppError(CodeConfig, "Agent Outbox API path must be relative.")
	}
	if relative.Fragment != "" {
		return "", NewAppError(CodeConfig, "Agent Outbox API path must not include a fragment.")
	}

	path := relative.Path
	rawPath := relative.RawPath
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
		if rawPath != "" {
			rawPath = "/" + rawPath
		}
	}
	parsed.Path = path
	parsed.RawPath = rawPath
	parsed.RawQuery = relative.RawQuery
	return parsed.String(), nil
}

func (c APIClient) requestID() string {
	if c.NewRequestID != nil {
		if id := strings.TrimSpace(c.NewRequestID()); id != "" {
			return id
		}
	}
	random := make([]byte, 12)
	// crypto/rand.Read never returns an error and always fills the buffer.
	_, _ = rand.Read(random)
	return "req_" + hex.EncodeToString(random)
}

func appErrorFromEnvelope(envelope *apiEnvelope, meta *APIResponse) *AppError {
	if envelope.Error == nil {
		return statusError(500, meta, "Agent Outbox API returned an error envelope without an error.")
	}
	retryAfter := envelope.Error.RetryAfterSeconds
	if retryAfter == nil {
		retryAfter = meta.RetryAfterSeconds
	}
	return &AppError{
		Code:              envelope.Error.Code,
		Message:           envelope.Error.Message,
		Fields:            envelope.Error.Fields,
		ErrorID:           envelope.Error.ErrorID,
		RequestID:         meta.RequestID,
		CorrelationID:     meta.CorrelationID,
		RetryAfterSeconds: retryAfter,
		Limit:             envelope.Error.Limit,
		Upgrade:           envelope.Error.Upgrade,
	}
}

func statusError(status int, meta *APIResponse, message string) *AppError {
	code := CodeTemporaryUnavailable
	switch {
	case status == http.StatusUnauthorized:
		code = CodeAuthenticationRequired
	case status == http.StatusForbidden:
		code = CodeAuthorizationFailed
	case status == http.StatusNotFound:
		code = CodeNotFound
	case status == http.StatusConflict:
		code = CodePendingContentConflict
	case status >= 400 && status < 500:
		code = CodeInvalidRequest
	case status >= 500:
		code = CodeTemporaryUnavailable
	}
	return &AppError{
		Code:              code,
		Message:           message,
		RequestID:         meta.RequestID,
		CorrelationID:     meta.CorrelationID,
		RetryAfterSeconds: meta.RetryAfterSeconds,
	}
}

func retryAfterSeconds(value string, now time.Time) *int {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if seconds, err := strconv.Atoi(value); err == nil && seconds >= 0 {
		return &seconds
	}
	if when, err := http.ParseTime(value); err == nil {
		seconds := int(when.Sub(now).Seconds())
		if seconds < 0 {
			seconds = 0
		}
		return &seconds
	}
	return nil
}
