package foundation

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
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
	HTTPStatus        int
}

type DownloadResponse struct {
	APIResponse
	ContentType   string
	ContentLength int64
}

type apiEnvelope struct {
	OK            *bool           `json:"ok"`
	RequestID     string          `json:"request_id"`
	CorrelationID string          `json:"correlation_id"`
	Data          json.RawMessage `json:"data"`
	Error         *apiErrorBody   `json:"error"`
}

type requestKind int

const (
	readRequest requestKind = iota
	writeRequest
)

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
	return c.do(ctx, method, apiPath, bearerToken, body, out, readRequest)
}

// DoWrite performs a request whose successful processing mutates durable
// server state. Errors report whether acceptance is known so callers never
// have to infer write safety from a transport or response-contract failure.
func (c APIClient) DoWrite(ctx context.Context, method string, apiPath string, bearerToken string, body any, out any) (*APIResponse, error) {
	return c.do(ctx, method, apiPath, bearerToken, body, out, writeRequest)
}

// do serves Do and DoWrite with Accept: application/json and closes the response
// body. Metadata is nil on build or transport failures and remains available
// when response decoding or validation fails.
func (c APIClient) do(ctx context.Context, method string, apiPath string, bearerToken string, body any, out any, kind requestKind) (*APIResponse, error) {
	resp, responseMeta, err := c.send(ctx, method, apiPath, bearerToken, "application/json", body, kind)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	envelope, appErr := decodeEnvelope(resp.Body, responseMeta, kind, "Agent Outbox API returned a non-JSON response.")
	if appErr != nil {
		return responseMeta, appErr
	}
	if !*envelope.OK {
		return responseMeta, appErrorFromEnvelope(envelope, responseMeta, kind)
	}
	if _, ok := out.(*json.RawMessage); ok && !isNonEmptyJSONObject(envelope.Data) {
		return responseMeta, acceptedResponseFailure("Agent Outbox API response data is not a nonempty JSON object.", responseMeta, kind, nil)
	}
	if out != nil && len(envelope.Data) > 0 {
		if err := json.Unmarshal(envelope.Data, out); err != nil {
			return responseMeta, acceptedResponseFailure("Could not decode Agent Outbox API response data.", responseMeta, kind, err)
		}
	}
	return responseMeta, nil
}

// Download fetches raw file bytes with Accept: */* and closes the response body.
// Build or transport failures return nil metadata; decoded error-envelope IDs
// update the returned metadata even when validation fails. Successful responses
// are staged within the file-size limit before bytes are copied to dst.
func (c APIClient) Download(ctx context.Context, apiPath string, bearerToken string, dst io.Writer) (*DownloadResponse, error) {
	resp, responseMeta, err := c.send(ctx, http.MethodGet, apiPath, bearerToken, "*/*", nil, readRequest)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	downloadMeta := &DownloadResponse{
		APIResponse:   *responseMeta,
		ContentType:   resp.Header.Get("Content-Type"),
		ContentLength: resp.ContentLength,
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		envelope, appErr := decodeEnvelope(resp.Body, &downloadMeta.APIResponse, readRequest, "Agent Outbox API returned a non-JSON file-download error response.")
		if appErr != nil {
			return downloadMeta, appErr
		}
		// validateEnvelope rejects success envelopes on non-2xx statuses, so a
		// decoded envelope here is always a valid error envelope.
		return downloadMeta, appErrorFromEnvelope(envelope, &downloadMeta.APIResponse, readRequest)
	}

	if resp.ContentLength > maxOutputFileDownloadBytes {
		return downloadMeta, responseFailure(CodeAPIResponseInvalid, "Output file exceeded the maximum size.", &downloadMeta.APIResponse, readRequest, nil)
	}
	staged, err := os.CreateTemp("", "agent-outbox-download-*")
	if err != nil {
		return downloadMeta, responseFailure(CodeLocalIO, "Could not stage output file bytes.", &downloadMeta.APIResponse, readRequest, err)
	}
	defer func() {
		_ = staged.Close()
		_ = os.Remove(staged.Name())
	}()

	trackedBody := &readErrorTracker{reader: resp.Body}
	oversized, err := copyBodyWithLimit(staged, trackedBody, maxOutputFileDownloadBytes)
	if err != nil {
		if trackedBody.err != nil {
			return downloadMeta, responseFailure(CodeAPIUnavailable, "Could not read Agent Outbox API response.", &downloadMeta.APIResponse, readRequest, trackedBody.err)
		}
		return downloadMeta, responseFailure(CodeLocalIO, "Could not stage output file bytes.", &downloadMeta.APIResponse, readRequest, err)
	}
	if oversized {
		return downloadMeta, responseFailure(CodeAPIResponseInvalid, "Output file exceeded the maximum size.", &downloadMeta.APIResponse, readRequest, nil)
	}
	if _, err := staged.Seek(0, io.SeekStart); err != nil {
		return downloadMeta, responseFailure(CodeLocalIO, "Could not stage output file bytes.", &downloadMeta.APIResponse, readRequest, err)
	}
	if _, err := io.Copy(dst, staged); err != nil {
		return downloadMeta, responseFailure(CodeLocalIO, "Could not write output file bytes.", &downloadMeta.APIResponse, readRequest, err)
	}
	return downloadMeta, nil
}

// send builds and performs one request using accept, sending json.RawMessage
// bodies unchanged and JSON-encoding other non-nil bodies. Content-Type is set
// only for a non-nil body. On success it returns header-derived metadata and a
// response whose body the caller must close. Build or transport failures return
// nil response and metadata; transport errors retain the generated request ID.
func (c APIClient) send(ctx context.Context, method string, apiPath string, bearerToken string, accept string, body any, kind requestKind) (*http.Response, *APIResponse, error) {
	base, err := normalizeBaseURL(c.BaseURL)
	if err != nil {
		return nil, nil, err
	}
	endpoint, err := joinBaseAndPath(base, apiPath)
	if err != nil {
		return nil, nil, err
	}

	var reader io.Reader
	if raw, ok := body.(json.RawMessage); ok {
		// Pre-encoded bodies are sent byte-for-byte; json.Marshal would compact
		// and HTML-escape them, changing the size the caller already checked.
		reader = bytes.NewReader(raw)
	} else if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, nil, WrapConfigError("Could not encode API request JSON.", err)
		}
		reader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, nil, WrapConfigError("Could not build API request.", err)
	}
	req.Header.Set("Accept", accept)
	requestID := c.requestID()
	req.Header.Set("X-Request-ID", requestID)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+bearerToken)
	}

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, nil, requestFailure(&APIResponse{RequestID: requestID}, kind, err)
	}
	return resp, &APIResponse{
		RequestID:         firstSafeDiagnosticID(resp.Header.Get("X-Request-ID"), requestID),
		CorrelationID:     firstSafeDiagnosticID(resp.Header.Get("X-Correlation-ID")),
		RetryAfterSeconds: retryAfterSeconds(resp.Header.Get("Retry-After"), time.Now()),
		HTTPStatus:        resp.StatusCode,
	}, nil
}

// decodeEnvelope reads a bounded JSON envelope and validates it against
// meta.HTTPStatus. After JSON decoding, safe body IDs update meta before
// validation, so they survive validation failures. Read, size, and JSON errors
// take precedence over envelope validation; the caller closes the body.
func decodeEnvelope(body io.Reader, meta *APIResponse, kind requestKind, nonJSONMessage string) (*apiEnvelope, *AppError) {
	data, oversized, err := readBodyWithLimit(body, maxJSONResponseBytes)
	if err != nil {
		return nil, responseFailure(CodeAPIUnavailable, "Could not read Agent Outbox API response.", meta, kind, err)
	}
	if oversized {
		return nil, responseFailure(CodeAPIResponseInvalid, "Agent Outbox API response exceeded the maximum size.", meta, kind, nil)
	}

	var envelope apiEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, responseFailure(CodeAPIResponseInvalid, nonJSONMessage, meta, kind, err)
	}
	if safeDiagnosticID(envelope.RequestID) {
		meta.RequestID = envelope.RequestID
	}
	if safeDiagnosticID(envelope.CorrelationID) {
		meta.CorrelationID = envelope.CorrelationID
	}
	if err := validateEnvelope(&envelope, meta.HTTPStatus); err != nil {
		return nil, invalidEnvelopeFailure(&envelope, meta, kind, err.Error())
	}
	return &envelope, nil
}

// httpClient returns the configured client with the CLI redirect safety policy
// applied. Existing callbacks own redirect-count policy; the wrapper preserves
// net/http's default limit only when no callback exists.
func (c APIClient) httpClient() *http.Client {
	base := c.HTTPClient
	if base == nil {
		base = defaultHTTPClient
	}
	client := *base
	next := base.CheckRedirect
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if err := checkRedirect(req, via); err != nil {
			return err
		}
		if next != nil {
			return next(req, via)
		}
		// Setting CheckRedirect replaces net/http's default ten-hop limit.
		if len(via) >= 10 {
			return errors.New("stopped after 10 redirects")
		}
		return nil
	}
	return &client
}

// redirectRefusal is returned by checkRedirect for redirects the CLI must not
// follow. net/http forwards the Authorization header to same-domain redirect
// targets regardless of scheme, and rewrites POST to GET on 301/302/303.
type redirectRefusal struct {
	message string
}

func (r *redirectRefusal) Error() string {
	return r.message
}

func checkRedirect(req *http.Request, via []*http.Request) error {
	if req.URL.Scheme != "https" && !(req.URL.Scheme == "http" && isLoopbackHost(req.URL.Hostname())) {
		return &redirectRefusal{message: "Agent Outbox API redirected to a URL that is not https or loopback http; the CLI refused to follow it so caller API keys never travel unencrypted."}
	}
	if req.Method != via[0].Method {
		return &redirectRefusal{message: "Agent Outbox API redirected with a request method change; the CLI refused to follow it so the request is not silently altered."}
	}
	return nil
}

func requestFailure(meta *APIResponse, kind requestKind, err error) *AppError {
	var refusal *redirectRefusal
	if errors.As(err, &refusal) {
		return responseFailure(CodeAPIResponseInvalid, refusal.message, meta, kind, err)
	}
	return responseFailure(CodeAPIUnavailable, "Could not reach Agent Outbox API.", meta, kind, err)
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

type readErrorTracker struct {
	reader io.Reader
	err    error
}

func (r *readErrorTracker) Read(data []byte) (int, error) {
	n, err := r.reader.Read(data)
	if err != nil && !errors.Is(err, io.EOF) {
		r.err = err
	}
	return n, err
}

func isNonEmptyJSONObject(data json.RawMessage) bool {
	var object map[string]json.RawMessage
	return json.Unmarshal(data, &object) == nil && object != nil && len(object) > 0
}

func isJSONNull(data json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(data), []byte("null"))
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

func appErrorFromEnvelope(envelope *apiEnvelope, meta *APIResponse, kind requestKind) *AppError {
	retryAfter := envelope.Error.RetryAfterSeconds
	if retryAfter == nil {
		retryAfter = meta.RetryAfterSeconds
	}
	return &AppError{
		Code:              envelope.Error.Code,
		Message:           envelope.Error.Message,
		HTTPStatus:        meta.HTTPStatus,
		Fields:            envelope.Error.Fields,
		ErrorID:           envelope.Error.ErrorID,
		RequestID:         meta.RequestID,
		CorrelationID:     meta.CorrelationID,
		RetryAfterSeconds: retryAfter,
		Limit:             envelope.Error.Limit,
		Upgrade:           envelope.Error.Upgrade,
		WriteOutcome:      writeOutcome(kind, envelopeWriteOutcome(envelope.Error.Code)),
	}
}

// validateEnvelope returns the first envelope-contract violation. Success
// requires a 2xx status and non-null data; errors require safe diagnostic IDs,
// a recognized public code, and its matching HTTP status.
func validateEnvelope(envelope *apiEnvelope, status int) error {
	if envelope.OK == nil {
		return errors.New("Agent Outbox API response is missing the required ok field.")
	}
	if *envelope.OK {
		if status < 200 || status >= 300 {
			return errors.New("Agent Outbox API returned a success envelope with an unsuccessful HTTP status.")
		}
		if len(envelope.Data) == 0 || isJSONNull(envelope.Data) {
			return errors.New("Agent Outbox API success response is missing data.")
		}
		if envelope.Error != nil {
			return errors.New("Agent Outbox API success response unexpectedly contains an error.")
		}
		return nil
	}
	if !safeDiagnosticID(envelope.RequestID) || !safeDiagnosticID(envelope.CorrelationID) {
		return errors.New("Agent Outbox API error response is missing required request or correlation identifiers.")
	}
	if envelope.Error == nil {
		return errors.New("Agent Outbox API error response is missing an error object.")
	}
	if len(envelope.Data) > 0 {
		return errors.New("Agent Outbox API error response unexpectedly contains data.")
	}
	if expectedHTTPStatus(envelope.Error.Code) == 0 || strings.TrimSpace(envelope.Error.Message) == "" {
		return errors.New("Agent Outbox API error response does not contain a usable public error code and message.")
	}
	if envelope.Error.RetryAfterSeconds != nil && *envelope.Error.RetryAfterSeconds < 0 {
		return errors.New("Agent Outbox API error response contains invalid retry metadata.")
	}
	if envelope.Error.ErrorID != "" && !safeDiagnosticID(envelope.Error.ErrorID) {
		return errors.New("Agent Outbox API error response contains an invalid error identifier.")
	}
	if status != expectedHTTPStatus(envelope.Error.Code) {
		return errors.New("Agent Outbox API error response code does not match its HTTP status.")
	}
	return nil
}

// expectedHTTPStatus returns the public API status for code, or zero when code
// is unrecognized. Envelope validation also uses this mapping to recognize codes.
func expectedHTTPStatus(code ErrorCode) int {
	switch code {
	case CodeInvalidRequest, CodeInvalidJSON:
		return http.StatusBadRequest
	case CodeRequestTooLarge:
		return http.StatusRequestEntityTooLarge
	case CodeValidationFailed, CodeUnsupportedIcon, CodeUnsafeHTML, CodeUnsafeColor, CodeInvalidActionResponse:
		return http.StatusUnprocessableEntity
	case CodeUpgradeRequired, CodeBillingGraceExpired:
		return http.StatusPaymentRequired
	case CodeAuthenticationRequired, CodeInvalidCallerCredentials:
		return http.StatusUnauthorized
	case CodeAuthorizationFailed:
		return http.StatusForbidden
	case CodeNotFound:
		return http.StatusNotFound
	case CodeCallerAlreadyExists, CodePendingContentConflict, CodeAnsweredUnacknowledged,
		CodeInputNotPending, CodeStaleInputRevision, CodeOutputAlreadyRead:
		return http.StatusConflict
	case CodeRateLimitExceeded, CodeQuotaLimitExceeded, CodeStorageLimitExceeded, CodeRetentionLimitExceeded:
		return http.StatusTooManyRequests
	case CodeAuthorizationPending:
		return http.StatusAccepted
	case CodeTemporaryUnavailable:
		return http.StatusServiceUnavailable
	case CodeInternalError:
		return http.StatusInternalServerError
	default:
		return 0
	}
}

func responseFailure(code ErrorCode, message string, meta *APIResponse, kind requestKind, cause error) *AppError {
	return &AppError{
		Code:              code,
		Message:           message,
		HTTPStatus:        meta.HTTPStatus,
		RequestID:         meta.RequestID,
		CorrelationID:     meta.CorrelationID,
		RetryAfterSeconds: meta.RetryAfterSeconds,
		WriteOutcome:      writeOutcome(kind, "unknown"),
		cause:             cause,
	}
}

func NewAPIResponseInvalidError(message string, meta *APIResponse) *AppError {
	if meta == nil {
		meta = &APIResponse{}
	}
	return responseFailure(CodeAPIResponseInvalid, message, meta, readRequest, nil)
}

// acceptedResponseFailure reports unusable data after a validated success
// envelope. Write errors report accepted; read errors omit the write outcome.
func acceptedResponseFailure(message string, meta *APIResponse, kind requestKind, cause error) *AppError {
	appErr := responseFailure(CodeAPIResponseInvalid, message, meta, kind, cause)
	appErr.WriteOutcome = writeOutcome(kind, "accepted")
	return appErr
}

// invalidEnvelopeFailure keeps response-invalid classification while retaining
// safe partial error diagnostics. Writes with a 2xx status and ok:true report
// accepted; other writes remain unknown, and reads omit the write outcome.
func invalidEnvelopeFailure(envelope *apiEnvelope, meta *APIResponse, kind requestKind, message string) *AppError {
	appErr := responseFailure(CodeAPIResponseInvalid, message, meta, kind, nil)
	if envelope.OK != nil && *envelope.OK && meta.HTTPStatus >= 200 && meta.HTTPStatus < 300 {
		appErr.WriteOutcome = writeOutcome(kind, "accepted")
	}
	if envelope.Error == nil {
		return appErr
	}
	if expectedHTTPStatus(envelope.Error.Code) != 0 && strings.TrimSpace(envelope.Error.Message) != "" {
		appErr.UpstreamErrorCode = envelope.Error.Code
	}
	if safeDiagnosticID(envelope.Error.ErrorID) {
		appErr.ErrorID = envelope.Error.ErrorID
	}
	if envelope.Error.RetryAfterSeconds != nil && *envelope.Error.RetryAfterSeconds >= 0 {
		appErr.RetryAfterSeconds = envelope.Error.RetryAfterSeconds
	}
	appErr.Limit = safePartialLimitMetadata(envelope.Error.Limit)
	return appErr
}

func safePartialLimitMetadata(limit *LimitMetadata) *LimitMetadata {
	if limit == nil || !safeDiagnosticID(limit.LimitName) || !safeDiagnosticID(limit.LimitReasonCode) {
		return nil
	}
	result := &LimitMetadata{
		LimitName:       limit.LimitName,
		LimitReasonCode: limit.LimitReasonCode,
	}
	if limit.LimitResetsAt != nil {
		if _, err := time.Parse(time.RFC3339, *limit.LimitResetsAt); err == nil {
			result.LimitResetsAt = limit.LimitResetsAt
		}
	}
	return result
}

// writeOutcome keeps read errors free of write outcomes, even when response
// handling classifies a failure as accepted or unknown.
func writeOutcome(kind requestKind, outcome string) string {
	if kind == writeRequest {
		return outcome
	}
	return ""
}

func envelopeWriteOutcome(code ErrorCode) string {
	switch code {
	case CodeInternalError, CodeTemporaryUnavailable:
		return "unknown"
	default:
		return "not_accepted"
	}
}

func firstSafeDiagnosticID(values ...string) string {
	for _, value := range values {
		if safeDiagnosticID(value) {
			return value
		}
	}
	return ""
}

func safeDiagnosticID(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	if strings.Contains(strings.ToLower(value), "aob_live_") {
		return false
	}
	for _, character := range value {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			strings.ContainsRune("._:-", character) {
			continue
		}
		return false
	}
	return true
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
