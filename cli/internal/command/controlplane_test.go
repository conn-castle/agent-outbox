package command

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"agent-outbox/internal/foundation"
)

var testControlNow = time.Date(2026, 7, 2, 20, 0, 0, 0, time.UTC)

type controlPlaneSecretStore struct {
	keys         map[string]string
	storeErr     error
	deleteErr    error
	preflightErr error
}

func (s *controlPlaneSecretStore) LoadCallerKey(callerID string) (string, error) {
	if s.keys == nil {
		s.keys = map[string]string{}
	}
	value, ok := s.keys[callerID]
	if !ok {
		return "", foundation.WrapSecretStoreError("missing fake caller key", foundation.ErrSecretNotFound)
	}
	return value, nil
}

func (s *controlPlaneSecretStore) StoreCallerKey(callerID string, callerAPIKey string) error {
	if s.storeErr != nil {
		return s.storeErr
	}
	if s.keys == nil {
		s.keys = map[string]string{}
	}
	s.keys[callerID] = callerAPIKey
	return nil
}

func (s *controlPlaneSecretStore) DeleteCallerKey(callerID string) error {
	if s.deleteErr != nil {
		return s.deleteErr
	}
	if s.keys == nil {
		s.keys = map[string]string{}
	}
	if _, ok := s.keys[callerID]; !ok {
		return foundation.WrapSecretStoreError("missing fake caller key", foundation.ErrSecretNotFound)
	}
	delete(s.keys, callerID)
	return nil
}

func (s *controlPlaneSecretStore) PreflightWritable() error {
	return s.preflightErr
}

type readOnlyControlPlaneSecretStore struct{}

func (readOnlyControlPlaneSecretStore) LoadCallerKey(string) (string, error) {
	return "read-only-secret", nil
}

func TestApprovalUsesDeviceCodeHonorsExplicitAndHeadlessSelection(t *testing.T) {
	if _, err := approvalUsesDeviceCode(Options{Env: foundation.Env{}}, true, true); err == nil {
		t.Fatalf("device-code and browser flags did not conflict")
	}
	useDevice, err := approvalUsesDeviceCode(Options{Env: foundation.Env{"SSH_CONNECTION": "client server"}}, false, false)
	if err != nil || !useDevice {
		t.Fatalf("SSH session selection = %v, %v; want device code", useDevice, err)
	}
	useDevice, err = approvalUsesDeviceCode(Options{Env: foundation.Env{"SSH_CONNECTION": "client server"}}, false, true)
	if err != nil || useDevice {
		t.Fatalf("forced browser selection = %v, %v; want browser", useDevice, err)
	}
	useDevice, err = approvalUsesDeviceCode(Options{
		Env:         foundation.Env{},
		OpenBrowser: func(string) error { return nil },
	}, false, false)
	if err != nil || useDevice {
		t.Fatalf("injected browser selection = %v, %v; want browser", useDevice, err)
	}
}

func TestCallerConnectBrowserUsesAllocatedCallbackPortAndStoresCredential(t *testing.T) {
	store := &controlPlaneSecretStore{}
	configPath := filepath.Join(t.TempDir(), "config.json")
	var callbackURL string
	var sawActivate bool
	const apiKey = "aob_live_keyid_connectsecret"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/connect/browser/start":
			if r.Method != http.MethodPost {
				t.Errorf("connect start method = %s", r.Method)
			}
			var body map[string]string
			decodeJSONBody(t, r, &body)
			callbackURL = body["callback_url"]
			parsed, err := url.Parse(callbackURL)
			if err != nil {
				t.Fatalf("callback_url parse failed: %v", err)
			}
			if parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || parsed.Port() == "" {
				t.Fatalf("callback_url = %q, want loopback URL with allocated port", callbackURL)
			}
			if parsed.Port() == "49152" {
				t.Fatalf("callback_url used the illustrative fixed port: %s", callbackURL)
			}
			if body["local_caller_name"] != "steward-email" || body["display_name"] != "steward-email" {
				t.Fatalf("connect start body = %#v", body)
			}
			writeEnvelope(w, `{"approval_url":"https://app.example/caller/connect/approve?setup=setup_123","setup_request_id":"setup_123","expires_at":"2099-07-02T20:10:00Z"}`)
		case "/api/caller/connect/exchange":
			var body map[string]string
			decodeJSONBody(t, r, &body)
			if body["setup_code"] != "setup_code_browser" {
				t.Fatalf("exchange setup_code = %q", body["setup_code"])
			}
			writeEnvelope(w, fmt.Sprintf(`{"setup_request_id":"setup_123","caller":{"caller_id":"caller_123","caller_slug":"steward-email","display_name":"Steward Email"},"account":{"account_id":"acct_123","label":"Test","effective_tier":"free"},"credential":{"api_key":%q,"key_id":"key_new","prefix":"aob_live","last_chars":"cdef","created_at":"2026-07-02T20:00:00Z","expires_at":"2026-07-02T20:10:00Z"}}`, apiKey))
		case "/api/caller/connect/activate":
			sawActivate = true
			if got := r.Header.Get("Authorization"); got != "Bearer "+apiKey {
				t.Fatalf("activate authorization = %q", got)
			}
			if store.keys["caller_123"] != apiKey {
				t.Fatalf("activate happened before local credential store; key=%q", store.keys["caller_123"])
			}
			var body map[string]string
			decodeJSONBody(t, r, &body)
			if body["setup_request_id"] != "setup_123" {
				t.Fatalf("activate body = %#v", body)
			}
			writeEnvelope(w, `{"caller_id":"caller_123","activated_key_id":"key_new","activated_at":"2026-07-02T20:01:00Z"}`)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      store,
		args:       []string{"--json", "caller", "connect", "steward-email"},
		openBrowser: func(_ string) error {
			if callbackURL == "" {
				return errors.New("callback_url was not captured before browser open")
			}
			resp, err := http.Get(callbackURL + "?status=approved&setup_request_id=setup_123&setup_code=setup_code_browser")
			if err != nil {
				return err
			}
			_ = resp.Body.Close()
			return nil
		},
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if !sawActivate {
		t.Fatalf("connect did not call activate")
	}
	if store.keys["caller_123"] != apiKey {
		t.Fatalf("stored key = %q, want connect credential", store.keys["caller_123"])
	}
	assertNoSecretLeak(t, apiKey, stdout, stderr, configPath)

	cfg, err := foundation.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if len(cfg.Callers) != 1 || cfg.Callers[0].Name != "steward-email" || cfg.Callers[0].CallerID != "caller_123" || cfg.Callers[0].KeyID != "key_new" {
		t.Fatalf("stored caller config = %#v", cfg.Callers)
	}
	payload := decodeCommandJSON(t, stdout)
	data := payload["data"].(map[string]any)
	credential := data["credential"].(map[string]any)
	if _, ok := credential["api_key"]; ok {
		t.Fatalf("connect JSON exposed api_key: %s", stdout)
	}
	activation := data["activation"].(map[string]any)
	if activation["activated_key_id"] != "key_new" {
		t.Fatalf("connect JSON missing activation result: %s", stdout)
	}
}

func TestStoreAndActivateConnectPreservesConcurrentConfigUpdates(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	if err := foundation.SaveConfig(configPath, foundation.Config{Version: foundation.ConfigVersion}); err != nil {
		t.Fatalf("SaveConfig fixture failed: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/caller/connect/activate" {
			http.Error(w, "unexpected request", http.StatusNotFound)
			return
		}
		var body map[string]string
		decodeJSONBody(t, r, &body)
		writeEnvelope(w, fmt.Sprintf(`{"caller_id":"%s","activated_key_id":"activated_%s","activated_at":"2026-07-02T20:01:00Z"}`, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), body["setup_request_id"]))
	}))
	defer server.Close()

	runConnect := func(localName string, callerID string, keyID string, apiKey string) error {
		runtime := &controlPlaneRuntime{
			ConfigPath: configPath,
			Config:     foundation.Config{Version: foundation.ConfigVersion},
			Client: foundation.APIClient{
				BaseURL:      server.URL,
				HTTPClient:   server.Client(),
				NewRequestID: func() string { return "req_" + localName },
			},
			Secrets: &controlPlaneSecretStore{},
		}
		_, err := storeAndActivateConnect(context.Background(), runtime, localName, connectExchangeData{
			SetupRequestID: "setup_" + localName,
			Caller: callerData{
				CallerID:    callerID,
				CallerSlug:  localName,
				DisplayName: localName,
			},
			Account: accountData{
				AccountID:     "acct_123",
				Label:         "Test",
				EffectiveTier: "free",
			},
			Credential: credentialData{
				APIKey:    apiKey,
				KeyID:     keyID,
				Prefix:    "aob_live",
				LastChars: "tail",
				CreatedAt: "2026-07-02T20:00:00Z",
			},
		})
		return err
	}

	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for _, item := range []struct {
		name     string
		callerID string
		keyID    string
		apiKey   string
	}{
		{name: "steward-email", callerID: "caller_steward", keyID: "key_steward", apiKey: "aob_live_steward_secret"},
		{name: "ops-bot", callerID: "caller_ops", keyID: "key_ops", apiKey: "aob_live_ops_secret"},
	} {
		item := item
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			errs <- runConnect(item.name, item.callerID, item.keyID, item.apiKey)
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("storeAndActivateConnect failed: %v", err)
		}
	}

	cfg, err := foundation.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	got := map[string]foundation.CallerConfig{}
	for _, caller := range cfg.Callers {
		got[caller.Name] = caller
	}
	for name, want := range map[string]string{
		"steward-email": "caller_steward",
		"ops-bot":       "caller_ops",
	} {
		caller, ok := got[name]
		if !ok {
			t.Fatalf("caller %q missing from config after concurrent connect: %#v", name, cfg.Callers)
		}
		if caller.CallerID != want {
			t.Fatalf("caller %q id = %q, want %q", name, caller.CallerID, want)
		}
	}
}

func TestWithRuntimeLocalStateLockReleasesLockAfterPanic(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.json")
	runtime := &controlPlaneRuntime{ConfigPath: configPath}
	const panicValue = "panic under local state lock"

	func() {
		defer func() {
			got := recover()
			if got != panicValue {
				t.Fatalf("recover() = %#v, want %q", got, panicValue)
			}
		}()
		_ = withRuntimeLocalStateLock(runtime, func() error {
			panic(panicValue)
		})
	}()

	if runtime.stateLockHeld {
		t.Fatalf("runtime stateLockHeld stayed true after panic")
	}

	acquired := make(chan error, 1)
	go func() {
		lock, err := foundation.AcquireLocalStateLock(configPath)
		if err == nil {
			err = lock.Close()
		}
		acquired <- err
	}()

	select {
	case err := <-acquired:
		if err != nil {
			t.Fatalf("AcquireLocalStateLock after panic failed: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatalf("local state lock stayed held after panic")
	}
}

func TestCallerConnectBrowserIgnoresMalformedCallbacksUntilValidCallback(t *testing.T) {
	store := &controlPlaneSecretStore{}
	configPath := filepath.Join(t.TempDir(), "config.json")
	var callbackURL string
	const apiKey = "aob_live_keyid_connectsecret"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/connect/browser/start":
			var body map[string]string
			decodeJSONBody(t, r, &body)
			callbackURL = body["callback_url"]
			writeEnvelope(w, `{"approval_url":"https://app.example/caller/connect/approve?setup=setup_123","setup_request_id":"setup_123","expires_at":"2099-07-02T20:10:00Z"}`)
		case "/api/caller/connect/exchange":
			var body map[string]string
			decodeJSONBody(t, r, &body)
			if body["setup_code"] != "setup_code_browser" {
				t.Fatalf("exchange setup_code = %q", body["setup_code"])
			}
			writeEnvelope(w, fmt.Sprintf(`{"setup_request_id":"setup_123","caller":{"caller_id":"caller_123","caller_slug":"steward-email","display_name":"Steward Email"},"account":{"account_id":"acct_123","label":"Test","effective_tier":"free"},"credential":{"api_key":%q,"key_id":"key_new","prefix":"aob_live","last_chars":"cdef","created_at":"2026-07-02T20:00:00Z","expires_at":"2026-07-02T20:10:00Z"}}`, apiKey))
		case "/api/caller/connect/activate":
			writeEnvelope(w, `{"caller_id":"caller_123","activated_key_id":"key_new","activated_at":"2026-07-02T20:01:00Z"}`)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      store,
		args:       []string{"--json", "caller", "connect", "steward-email"},
		openBrowser: func(_ string) error {
			if callbackURL == "" {
				return errors.New("callback_url was not captured before browser open")
			}
			for _, suffix := range []string{
				"?setup_request_id=setup_123&setup_code=missing_status",
				"?status=approved&setup_request_id=wrong_setup&setup_code=wrong_setup_code",
				"?status=approved&setup_request_id=setup_123&setup_code=setup_code_browser",
			} {
				resp, err := http.Get(callbackURL + suffix)
				if err != nil {
					return err
				}
				_ = resp.Body.Close()
			}
			return nil
		},
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if store.keys["caller_123"] != apiKey {
		t.Fatalf("stored key = %q, want connect credential", store.keys["caller_123"])
	}
	if !strings.Contains(stdout, `"connected":true`) {
		t.Fatalf("connect stdout missing success payload: %s", stdout)
	}
}

func TestBrowserFlowExpiresAtStopsWaiting(t *testing.T) {
	var stderr bytes.Buffer
	opened := false

	_, err := runBrowserFlow(context.Background(), Options{
		Stderr: &stderr,
		OpenBrowser: func(string) error {
			opened = true
			return nil
		},
	}, "connect", func(string) (browserStartData, error) {
		return browserStartData{
			ApprovalURL:    "https://app.example/caller/connect/approve?setup=setup_expired",
			SetupRequestID: "setup_expired",
			ExpiresAt:      time.Now().Add(-time.Minute).UTC().Format(time.RFC3339),
		}, nil
	})
	if err == nil {
		t.Fatalf("runBrowserFlow succeeded after expiry")
	}
	appErr, ok := err.(*foundation.AppError)
	if !ok {
		t.Fatalf("error type = %T, want *AppError", err)
	}
	if appErr.Code != foundation.CodeTemporaryUnavailable {
		t.Fatalf("error code = %q, want %q", appErr.Code, foundation.CodeTemporaryUnavailable)
	}
	if !opened {
		t.Fatalf("browser opener was not called")
	}
}

func TestCallerConnectDevicePollHonorsRetryMetadata(t *testing.T) {
	store := &controlPlaneSecretStore{}
	configPath := filepath.Join(t.TempDir(), "config.json")
	const apiKey = "aob_live_keyid_devicesecret"
	polls := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/connect/device/start":
			writeEnvelope(w, `{"device_code":"dev_secret","user_code":"ABCD-EFGH","verification_uri":"https://app.example/caller/connect/device","verification_uri_complete":"https://app.example/caller/connect/device?user_code=ABCD-EFGH","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/connect/device/poll":
			polls++
			var body map[string]string
			decodeJSONBody(t, r, &body)
			if body["device_code"] != "dev_secret" {
				t.Fatalf("device_code = %q", body["device_code"])
			}
			if polls == 1 {
				w.Header().Set("Retry-After", "7")
				w.WriteHeader(http.StatusAccepted)
				_, _ = io.WriteString(w, `{"ok":false,"request_id":"req_pending","correlation_id":"corr_pending","error":{"code":"authorization_pending","message":"Approval pending."}}`)
				return
			}
			writeEnvelope(w, fmt.Sprintf(`{"setup_request_id":"setup_device","caller":{"caller_id":"caller_123","caller_slug":"steward-email","display_name":"Steward Email"},"account":{"account_id":"acct_123","label":"Test","effective_tier":"free"},"credential":{"api_key":%q,"key_id":"key_device","prefix":"aob_live","last_chars":"zzzz","created_at":"2026-07-02T20:00:00Z","expires_at":"2026-07-02T20:10:00Z"}}`, apiKey))
		case "/api/caller/connect/activate":
			if got := r.Header.Get("Authorization"); got != "Bearer "+apiKey {
				t.Fatalf("activate authorization = %q", got)
			}
			var body map[string]string
			decodeJSONBody(t, r, &body)
			if body["setup_request_id"] != "setup_device" {
				t.Fatalf("activate body = %#v", body)
			}
			writeEnvelope(w, `{"caller_id":"caller_123","activated_key_id":"key_device","activated_at":"2026-07-02T20:01:00Z"}`)
		default:
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	var sleeps []time.Duration
	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      store,
		args:       []string{"--json", "caller", "connect", "steward-email", "--device-code"},
		sleep: func(_ context.Context, d time.Duration) error {
			sleeps = append(sleeps, d)
			return nil
		},
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if polls != 2 {
		t.Fatalf("poll count = %d, want 2", polls)
	}
	if len(sleeps) != 1 || sleeps[0] != 7*time.Second {
		t.Fatalf("sleeps = %#v, want one 7s retry", sleeps)
	}
	if !strings.Contains(stderr, "user_code=ABCD-EFGH") || strings.Contains(stderr, "dev_secret") {
		t.Fatalf("device diagnostics leaked or omitted values: %s", stderr)
	}
	if store.keys["caller_123"] != apiKey {
		t.Fatalf("stored key = %q, want device credential", store.keys["caller_123"])
	}
	assertNoSecretLeak(t, apiKey, stdout, stderr, configPath)
}

func TestCallerConnectDevicePollStopsAtDeviceExpiry(t *testing.T) {
	store := &controlPlaneSecretStore{}
	configPath := filepath.Join(t.TempDir(), "config.json")
	now := testControlNow
	polls := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/connect/device/start":
			writeEnvelope(w, fmt.Sprintf(`{"device_code":"dev_expiring","user_code":"EXP-1","verification_uri":"https://app.example/caller/connect/device","verification_uri_complete":"https://app.example/caller/connect/device?user_code=EXP-1","expires_at":%q,"poll_interval_seconds":5}`, now.Add(time.Second).UTC().Format(time.RFC3339)))
		case "/api/caller/connect/device/poll":
			polls++
			if polls > 1 {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = io.WriteString(w, `{"ok":false,"request_id":"req_after_expiry","correlation_id":"corr_after_expiry","error":{"code":"invalid_request","message":"Poll happened after expiry."}}`)
				return
			}
			w.Header().Set("Retry-After", "7")
			w.WriteHeader(http.StatusAccepted)
			_, _ = io.WriteString(w, `{"ok":false,"request_id":"req_pending","correlation_id":"corr_pending","error":{"code":"authorization_pending","message":"Approval pending."}}`)
		default:
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	var sleeps []time.Duration
	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      store,
		args:       []string{"--json", "caller", "connect", "steward-email", "--device-code"},
		now: func() time.Time {
			return now
		},
		sleep: func(_ context.Context, d time.Duration) error {
			sleeps = append(sleeps, d)
			now = now.Add(d)
			return nil
		},
	})
	if code != foundation.ExitTemporary {
		t.Fatalf("exit code = %d, want device expiry timeout; stdout: %s stderr: %s", code, stdout, stderr)
	}
	if polls != 1 {
		t.Fatalf("poll count = %d, want one poll before expiry", polls)
	}
	if len(sleeps) != 1 || sleeps[0] != time.Second {
		t.Fatalf("sleeps = %#v, want one 1s sleep capped by expiry", sleeps)
	}
	if !strings.Contains(stderr, "Timed out waiting for device approval.") {
		t.Fatalf("stderr missing device timeout message: %s", stderr)
	}
}

func TestCallerConnectDevicePollRequestStopsAtDeviceExpiry(t *testing.T) {
	store := &controlPlaneSecretStore{}
	configPath := filepath.Join(t.TempDir(), "config.json")
	now := testControlNow
	polls := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/connect/device/start":
			writeEnvelope(w, fmt.Sprintf(`{"device_code":"dev_slow_pending","user_code":"SLOW-1","verification_uri":"https://app.example/caller/connect/device","verification_uri_complete":"https://app.example/caller/connect/device?user_code=SLOW-1","expires_at":%q,"poll_interval_seconds":5}`, now.Add(10*time.Millisecond).UTC().Format(time.RFC3339Nano)))
		case "/api/caller/connect/device/poll":
			polls++
			select {
			case <-r.Context().Done():
				return
			case <-time.After(50 * time.Millisecond):
				w.Header().Set("Retry-After", "5")
				w.WriteHeader(http.StatusAccepted)
				_, _ = io.WriteString(w, `{"ok":false,"request_id":"req_pending","correlation_id":"corr_pending","error":{"code":"authorization_pending","message":"Approval pending."}}`)
			}
		default:
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	sleeps := 0
	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      store,
		args:       []string{"--json", "caller", "connect", "steward-email", "--device-code"},
		now: func() time.Time {
			return now
		},
		sleep: func(context.Context, time.Duration) error {
			sleeps++
			return foundation.NewAppError(foundation.CodeTemporaryUnavailable, "test sleep should not run")
		},
	})
	if code != foundation.ExitTemporary {
		t.Fatalf("exit code = %d, want device expiry timeout; stdout: %s stderr: %s", code, stdout, stderr)
	}
	if polls != 1 {
		t.Fatalf("poll count = %d, want one in-flight poll", polls)
	}
	if sleeps != 0 {
		t.Fatalf("sleep count = %d, want request deadline before retry sleep", sleeps)
	}
	if !strings.Contains(stderr, "Timed out waiting for device approval.") {
		t.Fatalf("stderr missing device timeout message: %s", stderr)
	}
}

func TestCallerConnectDeviceStartRequiresValidExpiry(t *testing.T) {
	tests := []struct {
		name        string
		startData   string
		wantMessage string
	}{
		{
			name:        "missing",
			startData:   `{"device_code":"dev_missing","user_code":"EXP-1","verification_uri":"https://app.example/caller/connect/device","verification_uri_complete":"https://app.example/caller/connect/device?user_code=EXP-1","poll_interval_seconds":5}`,
			wantMessage: "Agent Outbox API did not return a device approval expiry.",
		},
		{
			name:        "invalid",
			startData:   `{"device_code":"dev_invalid","user_code":"EXP-1","verification_uri":"https://app.example/caller/connect/device","verification_uri_complete":"https://app.example/caller/connect/device?user_code=EXP-1","expires_at":"not-a-timestamp","poll_interval_seconds":5}`,
			wantMessage: "Agent Outbox API returned an invalid device approval expiry.",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &controlPlaneSecretStore{}
			configPath := filepath.Join(t.TempDir(), "config.json")
			polls := 0

			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/caller/connect/device/start":
					writeEnvelope(w, tt.startData)
				case "/api/caller/connect/device/poll":
					polls++
					w.WriteHeader(http.StatusBadRequest)
					_, _ = io.WriteString(w, `{"ok":false,"request_id":"req_unexpected_poll","correlation_id":"corr_unexpected_poll","error":{"code":"invalid_request","message":"Unexpected poll."}}`)
				default:
					t.Fatalf("unexpected request: %s", r.URL.Path)
				}
			}))
			defer server.Close()

			stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
				configPath: configPath,
				baseURL:    server.URL,
				store:      store,
				args:       []string{"--json", "caller", "connect", "steward-email", "--device-code"},
			})
			if code != foundation.ExitData {
				t.Fatalf("exit code = %d, want data error; stdout: %s stderr: %s", code, stdout, stderr)
			}
			if polls != 0 {
				t.Fatalf("poll count = %d, want no poll after %s expiry", polls, tt.name)
			}
			if !strings.Contains(stderr, tt.wantMessage) {
				t.Fatalf("stderr missing expiry validation message %q: %s", tt.wantMessage, stderr)
			}
		})
	}
}

func TestDeviceSetupCodeFlowStopsAtDeviceExpiry(t *testing.T) {
	now := testControlNow
	polls := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/rotate/device/start":
			assertCallerOperationStart(t, r)
			writeEnvelope(w, fmt.Sprintf(`{"device_code":"dev_rotate_expiring","user_code":"ROTATE-1","verification_uri":"https://app.example/caller/rotate/device","verification_uri_complete":"https://app.example/caller/rotate/device?user_code=ROTATE-1","expires_at":%q,"poll_interval_seconds":5}`, now.Add(time.Second).UTC().Format(time.RFC3339)))
		case "/api/caller/rotate/device/poll":
			polls++
			if polls > 1 {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = io.WriteString(w, `{"ok":false,"request_id":"req_after_expiry","correlation_id":"corr_after_expiry","error":{"code":"invalid_request","message":"Poll happened after expiry."}}`)
				return
			}
			w.Header().Set("Retry-After", "7")
			w.WriteHeader(http.StatusAccepted)
			_, _ = io.WriteString(w, `{"ok":false,"request_id":"req_pending","correlation_id":"corr_pending","error":{"code":"authorization_pending","message":"Approval pending."}}`)
		default:
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	var stderr bytes.Buffer
	var sleeps []time.Duration
	runtime := &controlPlaneRuntime{
		Client: foundation.APIClient{
			BaseURL:      server.URL,
			HTTPClient:   server.Client(),
			NewRequestID: func() string { return "req_cli" },
		},
	}
	_, err := runDeviceSetupCodeFlow(
		context.Background(),
		Options{
			Stderr: &stderr,
			Now: func() time.Time {
				return now
			},
			Sleep: func(_ context.Context, d time.Duration) error {
				sleeps = append(sleeps, d)
				now = now.Add(d)
				return nil
			},
		},
		runtime,
		foundation.CallerConfig{Name: "steward-email", CallerID: "caller_123"},
		"rotate",
		"/api/caller/rotate/device/start",
		"/api/caller/rotate/device/poll",
	)
	if err == nil {
		t.Fatalf("runDeviceSetupCodeFlow succeeded after device expiry")
	}
	appErr, ok := err.(*foundation.AppError)
	if !ok {
		t.Fatalf("error type = %T, want *AppError", err)
	}
	if appErr.Code != foundation.CodeTemporaryUnavailable {
		t.Fatalf("error code = %q, want %q", appErr.Code, foundation.CodeTemporaryUnavailable)
	}
	if polls != 1 {
		t.Fatalf("poll count = %d, want one poll before expiry", polls)
	}
	if len(sleeps) != 1 || sleeps[0] != time.Second {
		t.Fatalf("sleeps = %#v, want one 1s sleep capped by expiry", sleeps)
	}
	if !strings.Contains(stderr.String(), "user_code=ROTATE-1") {
		t.Fatalf("device setup instructions omitted user code: %s", stderr.String())
	}
}

func TestCallerConnectRejectsExistingLocalNameBeforeApproval(t *testing.T) {
	store := &controlPlaneSecretStore{keys: map[string]string{"caller_123": "old-secret"}}
	configPath := writeControlConfig(t, "http://placeholder.invalid")
	requests := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      store,
		args:       []string{"--json", "caller", "connect", "steward-email", "--device-code"},
	})
	if code != foundation.ExitConflict {
		t.Fatalf("exit code = %d, want local duplicate conflict; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for duplicate local connect")
	}
	if requests != 0 {
		t.Fatalf("duplicate local connect made %d server requests", requests)
	}
	if store.keys["caller_123"] != "old-secret" {
		t.Fatalf("duplicate local connect mutated secret store: %#v", store.keys)
	}
	cfg, err := foundation.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if len(cfg.Callers) != 1 || cfg.Callers[0].CallerID != "caller_123" {
		t.Fatalf("duplicate local connect changed config: %#v", cfg.Callers)
	}
}

func TestCallerConnectPreflightsLocalPersistenceBeforeApproval(t *testing.T) {
	store := &controlPlaneSecretStore{
		preflightErr: foundation.NewSecretStoreError("fake preflight secret-store failure"),
	}
	configPath := filepath.Join(t.TempDir(), "config.json")
	requests := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      store,
		args:       []string{"--json", "caller", "connect", "steward-email", "--device-code"},
	})
	if code != foundation.ExitSecretStore {
		t.Fatalf("exit code = %d, want preflight secret-store failure; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for preflight failure")
	}
	if requests != 0 {
		t.Fatalf("connect made %d server requests after local preflight failure", requests)
	}
	if len(store.keys) != 0 {
		t.Fatalf("preflight failure mutated secret store: %#v", store.keys)
	}
}

func TestCallerConnectPersistsResolvedBaseURLForLaterControlPlaneCommand(t *testing.T) {
	store := &controlPlaneSecretStore{}
	configPath := filepath.Join(t.TempDir(), "config.json")
	const apiKey = "aob_live_keyid_savedorigin"
	var revokeStarts int

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/connect/device/start":
			writeEnvelope(w, `{"device_code":"dev_connect","user_code":"CONNECT-1","verification_uri":"https://app.example/caller/connect/device","verification_uri_complete":"https://app.example/caller/connect/device?user_code=CONNECT-1","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/connect/device/poll":
			writeEnvelope(w, fmt.Sprintf(`{"setup_request_id":"setup_saved","caller":{"caller_id":"caller_123","caller_slug":"steward-email","display_name":"Steward Email"},"account":{"account_id":"acct_123","label":"Test","effective_tier":"free"},"credential":{"api_key":%q,"key_id":"key_saved","prefix":"aob_live","last_chars":"orig","created_at":"2026-07-02T20:00:00Z","expires_at":"2026-07-02T20:10:00Z"}}`, apiKey))
		case "/api/caller/connect/activate":
			writeEnvelope(w, `{"caller_id":"caller_123","activated_key_id":"key_saved","activated_at":"2026-07-02T20:01:00Z"}`)
		case "/api/caller/revoke/device/start":
			revokeStarts++
			assertCallerOperationStart(t, r)
			writeEnvelope(w, `{"device_code":"dev_revoke","user_code":"REVOKE-1","verification_uri":"https://app.example/caller/revoke/device","verification_uri_complete":"https://app.example/caller/revoke/device?user_code=REVOKE-1","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/revoke/device/poll":
			writeEnvelope(w, `{"setup_request_id":"setup_revoke","setup_code":"setup_revoke_code","expires_at":"2026-07-02T20:10:00Z"}`)
		case "/api/caller/revoke/confirm":
			writeEnvelope(w, `{"caller_id":"caller_123","revoked_key_ids":["key_saved"],"revoked_at":"2026-07-02T20:01:00Z"}`)
		default:
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      store,
		args:       []string{"--json", "caller", "connect", "steward-email", "--device-code"},
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("connect exit code = %d, stderr: %s", code, stderr)
	}
	if stdout == "" {
		t.Fatalf("connect stdout was empty")
	}

	cfg, err := foundation.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if cfg.BaseURL != server.URL {
		t.Fatalf("stored base_url = %q, want %q", cfg.BaseURL, server.URL)
	}

	stdout, stderr, code = executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		store:      store,
		args:       []string{"--json", "caller", "revoke", "steward-email", "--device-code"},
		httpClient: clientForOnlyOrigin(t, server.URL),
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("revoke exit code = %d, stderr: %s", code, stderr)
	}
	if revokeStarts != 1 {
		t.Fatalf("revoke starts = %d, want saved-origin command to reach fake server once", revokeStarts)
	}
	if !strings.Contains(stdout, `"revoked":true`) {
		t.Fatalf("revoke stdout missing success payload: %s", stdout)
	}
}

func TestCallerConnectAbortsWhenLocalStorageFailsAndLeavesNoActiveKey(t *testing.T) {
	const pendingKey = "aob_live_pending_connectsecret"
	store := &controlPlaneSecretStore{
		storeErr: foundation.NewSecretStoreError("fake local secure storage failure"),
	}
	configPath := filepath.Join(t.TempDir(), "config.json")
	var aborts int
	var activates int

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/connect/device/start":
			writeEnvelope(w, `{"device_code":"dev_connect","user_code":"CONNECT-1","verification_uri":"https://app.example/caller/connect/device","verification_uri_complete":"https://app.example/caller/connect/device?user_code=CONNECT-1","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/connect/device/poll":
			writeEnvelope(w, fmt.Sprintf(`{"setup_request_id":"setup_connect","caller":{"caller_id":"caller_123","caller_slug":"steward-email","display_name":"Steward Email"},"account":{"account_id":"acct_123","label":"Test","effective_tier":"free"},"credential":{"api_key":%q,"key_id":"key_pending","prefix":"aob_live","last_chars":"pend","created_at":"2026-07-02T20:00:00Z","expires_at":"2026-07-02T20:10:00Z"}}`, pendingKey))
		case "/api/caller/connect/abort":
			aborts++
			if got := r.Header.Get("Authorization"); got != "Bearer "+pendingKey {
				t.Fatalf("abort authorization = %q", got)
			}
			var body map[string]string
			decodeJSONBody(t, r, &body)
			if body["setup_request_id"] != "setup_connect" {
				t.Fatalf("abort body = %#v", body)
			}
			writeEnvelope(w, `{"caller_id":"caller_123","aborted_key_id":"key_pending","aborted_at":"2026-07-02T20:01:00Z"}`)
		case "/api/caller/connect/activate":
			activates++
			w.WriteHeader(http.StatusInternalServerError)
		default:
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      store,
		args:       []string{"--json", "caller", "connect", "steward-email", "--device-code"},
	})
	if code != foundation.ExitSecretStore {
		t.Fatalf("exit code = %d, want secret-store failure; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for failed connect")
	}
	if aborts != 1 || activates != 0 {
		t.Fatalf("aborts=%d activates=%d, want abort only", aborts, activates)
	}
	if len(store.keys) != 0 {
		t.Fatalf("failed connect left a hosted key stored locally: %#v", store.keys)
	}
	cfg, err := foundation.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if len(cfg.Callers) != 0 {
		t.Fatalf("failed connect mutated local config: %#v", cfg.Callers)
	}
	if strings.Contains(stdout, pendingKey) || strings.Contains(stderr, pendingKey) {
		t.Fatalf("failed connect leaked the pending credential")
	}
}

func TestCallerConnectAbortsWhenConfigSaveFailsAndLeavesNoActiveKey(t *testing.T) {
	const pendingKey = "aob_live_pending_connectsecret"
	store := &controlPlaneSecretStore{}

	// A regular file standing in for the config's parent directory makes saveRuntimeConfig fail
	// after the pending key has already been written to the secret store. Calling
	// storeAndActivateConnect directly bypasses the preflight guard that would otherwise reject
	// this path before any network work.
	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocker, []byte("blocker"), 0o600); err != nil {
		t.Fatalf("write blocker file: %v", err)
	}
	badConfigPath := filepath.Join(blocker, "config.json")

	var aborts int
	var activates int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/connect/abort":
			aborts++
			if got := r.Header.Get("Authorization"); got != "Bearer "+pendingKey {
				t.Fatalf("abort authorization = %q", got)
			}
			var body map[string]string
			decodeJSONBody(t, r, &body)
			if body["setup_request_id"] != "setup_connect" {
				t.Fatalf("abort body = %#v", body)
			}
			writeEnvelope(w, `{"caller_id":"caller_123","aborted_key_id":"key_pending","aborted_at":"2026-07-02T20:01:00Z"}`)
		case "/api/caller/connect/activate":
			activates++
			w.WriteHeader(http.StatusInternalServerError)
		default:
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	runtime := &controlPlaneRuntime{
		ConfigPath: badConfigPath,
		Config:     foundation.Config{Version: 1},
		Client: foundation.APIClient{
			BaseURL:      server.URL,
			NewRequestID: func() string { return "req_cli" },
		},
		Secrets: store,
	}
	result := connectExchangeData{
		SetupRequestID: "setup_connect",
		Caller:         callerData{CallerID: "caller_123", CallerSlug: "steward-email", DisplayName: "Steward Email"},
		Account:        accountData{AccountID: "acct_123", Label: "Test", EffectiveTier: "free"},
		Credential:     credentialData{APIKey: pendingKey, KeyID: "key_pending", Prefix: "aob_live", LastChars: "pend", CreatedAt: "2026-07-02T20:00:00Z", ExpiresAt: "2026-07-02T20:10:00Z"},
	}

	if _, err := storeAndActivateConnect(context.Background(), runtime, "steward-email", result); err == nil {
		t.Fatalf("storeAndActivateConnect succeeded despite config save failure")
	}
	if aborts != 1 || activates != 0 {
		t.Fatalf("aborts=%d activates=%d, want abort only", aborts, activates)
	}
	if len(store.keys) != 0 {
		t.Fatalf("config save failure left a hosted key stored locally: %#v", store.keys)
	}
}

func TestCallerConnectPreservesCredentialAfterAmbiguousActivateFailure(t *testing.T) {
	const pendingKey = "aob_live_pending_connectsecret"
	store := &controlPlaneSecretStore{}
	configPath := filepath.Join(t.TempDir(), "config.json")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/connect/device/start":
			writeEnvelope(w, `{"device_code":"dev_connect","user_code":"CONNECT-1","verification_uri":"https://app.example/caller/connect/device","verification_uri_complete":"https://app.example/caller/connect/device?user_code=CONNECT-1","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/connect/device/poll":
			writeEnvelope(w, fmt.Sprintf(`{"setup_request_id":"setup_connect","caller":{"caller_id":"caller_123","caller_slug":"steward-email","display_name":"Steward Email"},"account":{"account_id":"acct_123","label":"Test","effective_tier":"free"},"credential":{"api_key":%q,"key_id":"key_pending","prefix":"aob_live","last_chars":"pend","created_at":"2026-07-02T20:00:00Z","expires_at":"2026-07-02T20:10:00Z"}}`, pendingKey))
		case "/api/caller/connect/activate":
			if got := r.Header.Get("Authorization"); got != "Bearer "+pendingKey {
				t.Fatalf("activate authorization = %q", got)
			}
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, `not-json`)
		default:
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      store,
		args:       []string{"--json", "caller", "connect", "steward-email", "--device-code"},
	})
	if code != foundation.ExitTemporary {
		t.Fatalf("exit code = %d, want temporary activate failure; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for failed connect")
	}
	if !strings.Contains(stderr, "may already be active") {
		t.Fatalf("ambiguous activate failure did not warn that the credential may be active: %s", stderr)
	}
	if store.keys["caller_123"] != pendingKey {
		t.Fatalf("ambiguous activate failure discarded the local pending key; key=%q", store.keys["caller_123"])
	}
	cfg, err := foundation.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if len(cfg.Callers) != 1 || cfg.Callers[0].Name != "steward-email" || cfg.Callers[0].KeyID != "key_pending" {
		t.Fatalf("ambiguous activate failure did not preserve local config: %#v", cfg.Callers)
	}
	assertNoSecretLeak(t, pendingKey, stdout, stderr, configPath)
}

func TestCallerConnectRollsBackLocalStateWhenActivateDefinitivelyDidNotCommit(t *testing.T) {
	const pendingKey = "aob_live_pending_connectsecret"
	store := &controlPlaneSecretStore{}
	configPath := filepath.Join(t.TempDir(), "config.json")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/connect/device/start":
			writeEnvelope(w, `{"device_code":"dev_connect","user_code":"CONNECT-1","verification_uri":"https://app.example/caller/connect/device","verification_uri_complete":"https://app.example/caller/connect/device?user_code=CONNECT-1","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/connect/device/poll":
			writeEnvelope(w, fmt.Sprintf(`{"setup_request_id":"setup_connect","caller":{"caller_id":"caller_123","caller_slug":"steward-email","display_name":"Steward Email"},"account":{"account_id":"acct_123","label":"Test","effective_tier":"free"},"credential":{"api_key":%q,"key_id":"key_pending","prefix":"aob_live","last_chars":"pend","created_at":"2026-07-02T20:00:00Z","expires_at":"2026-07-02T20:10:00Z"}}`, pendingKey))
		case "/api/caller/connect/activate":
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = io.WriteString(w, `{"ok":false,"request_id":"req_bad_activate","correlation_id":"corr_bad_activate","error":{"code":"validation_failed","message":"Activation request was invalid."}}`)
		default:
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      store,
		args:       []string{"--json", "caller", "connect", "steward-email", "--device-code"},
	})
	if code != foundation.ExitData {
		t.Fatalf("exit code = %d, want validation failure; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for failed connect")
	}
	if len(store.keys) != 0 {
		t.Fatalf("definitive activate failure left a hosted key stored locally: %#v", store.keys)
	}
	cfg, err := foundation.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if len(cfg.Callers) != 0 {
		t.Fatalf("definitive activate failure did not roll back local config: %#v", cfg.Callers)
	}
	assertNoSecretLeak(t, pendingKey, stdout, stderr, configPath)
}

func TestCallerRotateStoresReplacementThenActivates(t *testing.T) {
	const oldKey = "aob_live_oldkey_oldsecret"
	const newKey = "aob_live_newkey_newsecret"
	store := &controlPlaneSecretStore{keys: map[string]string{"caller_123": oldKey}}
	configPath := writeControlConfig(t, "http://placeholder.invalid")
	var sawActivate bool

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/rotate/device/start":
			assertCallerOperationStart(t, r)
			writeEnvelope(w, `{"device_code":"dev_rotate","user_code":"ROTATE-1","verification_uri":"https://app.example/caller/rotate/device","verification_uri_complete":"https://app.example/caller/rotate/device?user_code=ROTATE-1","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/rotate/device/poll":
			writeEnvelope(w, `{"setup_request_id":"setup_rotate","setup_code":"setup_rotate_code","expires_at":"2026-07-02T20:10:00Z"}`)
		case "/api/caller/rotate/exchange":
			writeEnvelope(w, fmt.Sprintf(`{"caller":{"caller_id":"caller_123","caller_slug":"steward-email","display_name":"Steward Email"},"account":{"account_id":"acct_123","label":"Test","effective_tier":"free"},"replacement_credential":{"api_key":%q,"key_id":"key_new","prefix":"aob_live","last_chars":"newx","created_at":"2026-07-02T20:00:00Z","expires_at":"2026-07-02T20:10:00Z"},"replaces_credential":{"key_id":"key_old","last_chars":"oldx"}}`, newKey))
		case "/api/caller/rotate/activate":
			sawActivate = true
			if got := r.Header.Get("Authorization"); got != "Bearer "+newKey {
				t.Fatalf("activate authorization = %q", got)
			}
			if store.keys["caller_123"] != newKey {
				t.Fatalf("activate happened before local replacement store; key=%q", store.keys["caller_123"])
			}
			var body map[string]string
			decodeJSONBody(t, r, &body)
			if body["setup_request_id"] != "setup_rotate" {
				t.Fatalf("activate body = %#v", body)
			}
			writeEnvelope(w, `{"caller_id":"caller_123","activated_key_id":"key_new","revoked_key_id":"key_old","activated_at":"2026-07-02T20:01:00Z"}`)
		default:
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      store,
		args:       []string{"--json", "caller", "rotate", "--device-code"},
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if !sawActivate {
		t.Fatalf("rotate did not call activate")
	}
	if store.keys["caller_123"] != newKey {
		t.Fatalf("stored key = %q, want new key", store.keys["caller_123"])
	}
	assertNoSecretLeak(t, newKey, stdout, stderr, configPath)
	cfg, err := foundation.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if cfg.Callers[0].KeyID != "key_new" || cfg.Callers[0].KeySuffix != "newx" {
		t.Fatalf("rotated config = %#v", cfg.Callers[0])
	}
}

func TestCallerRotateAbortsWhenLocalStorageFailsAndLeavesOldKey(t *testing.T) {
	const oldKey = "aob_live_oldkey_oldsecret"
	const newKey = "aob_live_newkey_newsecret"
	store := &controlPlaneSecretStore{
		keys:     map[string]string{"caller_123": oldKey},
		storeErr: foundation.NewSecretStoreError("fake local secure storage failure"),
	}
	configPath := writeControlConfig(t, "http://placeholder.invalid")
	var aborts int
	var activates int

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/rotate/device/start":
			writeEnvelope(w, `{"device_code":"dev_rotate","user_code":"ROTATE-1","verification_uri":"https://app.example/caller/rotate/device","verification_uri_complete":"https://app.example/caller/rotate/device?user_code=ROTATE-1","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/rotate/device/poll":
			writeEnvelope(w, `{"setup_request_id":"setup_rotate","setup_code":"setup_rotate_code","expires_at":"2026-07-02T20:10:00Z"}`)
		case "/api/caller/rotate/exchange":
			writeEnvelope(w, fmt.Sprintf(`{"caller":{"caller_id":"caller_123","caller_slug":"steward-email","display_name":"Steward Email"},"account":{"account_id":"acct_123","label":"Test","effective_tier":"free"},"replacement_credential":{"api_key":%q,"key_id":"key_new","prefix":"aob_live","last_chars":"newx","created_at":"2026-07-02T20:00:00Z","expires_at":"2026-07-02T20:10:00Z"},"replaces_credential":{"key_id":"key_old","last_chars":"oldx"}}`, newKey))
		case "/api/caller/rotate/abort":
			aborts++
			if got := r.Header.Get("Authorization"); got != "Bearer "+newKey {
				t.Fatalf("abort authorization = %q", got)
			}
			writeEnvelope(w, `{"caller_id":"caller_123","aborted_key_id":"key_new","active_key_id":"key_old","aborted_at":"2026-07-02T20:01:00Z"}`)
		case "/api/caller/rotate/activate":
			activates++
			w.WriteHeader(http.StatusInternalServerError)
		default:
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      store,
		args:       []string{"--json", "caller", "rotate", "--device-code"},
	})
	if code != foundation.ExitSecretStore {
		t.Fatalf("exit code = %d, want secret-store failure; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for failed rotate")
	}
	if aborts != 1 || activates != 0 {
		t.Fatalf("aborts=%d activates=%d, want abort only", aborts, activates)
	}
	if store.keys["caller_123"] != oldKey {
		t.Fatalf("old key was not preserved locally: %q", store.keys["caller_123"])
	}
	assertNoSecretLeak(t, newKey, stdout, stderr, configPath)
}

func TestCallerRotatePreservesReplacementAfterAmbiguousActivateFailure(t *testing.T) {
	const oldKey = "aob_live_oldkey_oldsecret"
	const newKey = "aob_live_newkey_newsecret"
	store := &controlPlaneSecretStore{keys: map[string]string{"caller_123": oldKey}}
	configPath := writeControlConfig(t, "http://placeholder.invalid")
	var aborts int

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/rotate/device/start":
			writeEnvelope(w, `{"device_code":"dev_rotate","user_code":"ROTATE-1","verification_uri":"https://app.example/caller/rotate/device","verification_uri_complete":"https://app.example/caller/rotate/device?user_code=ROTATE-1","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/rotate/device/poll":
			writeEnvelope(w, `{"setup_request_id":"setup_rotate","setup_code":"setup_rotate_code","expires_at":"2026-07-02T20:10:00Z"}`)
		case "/api/caller/rotate/exchange":
			writeEnvelope(w, fmt.Sprintf(`{"caller":{"caller_id":"caller_123","caller_slug":"steward-email","display_name":"Steward Email"},"account":{"account_id":"acct_123","label":"Test","effective_tier":"free"},"replacement_credential":{"api_key":%q,"key_id":"key_new","prefix":"aob_live","last_chars":"newx","created_at":"2026-07-02T20:00:00Z","expires_at":"2026-07-02T20:10:00Z"},"replaces_credential":{"key_id":"key_old","last_chars":"oldx"}}`, newKey))
		case "/api/caller/rotate/activate":
			if got := r.Header.Get("Authorization"); got != "Bearer "+newKey {
				t.Fatalf("activate authorization = %q", got)
			}
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, `not-json`)
		case "/api/caller/rotate/abort":
			aborts++
			writeEnvelope(w, `{}`)
		default:
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      store,
		args:       []string{"--json", "caller", "rotate", "--device-code"},
	})
	if code != foundation.ExitTemporary {
		t.Fatalf("exit code = %d, want temporary activate failure; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for failed rotate")
	}
	if !strings.Contains(stderr, "may already have committed") {
		t.Fatalf("ambiguous rotate activate failure did not warn that activation may have committed: %s", stderr)
	}
	if aborts != 0 {
		t.Fatalf("ambiguous activate failure called abort %d times", aborts)
	}
	if store.keys["caller_123"] != newKey {
		t.Fatalf("ambiguous activate failure restored old key; key=%q", store.keys["caller_123"])
	}
	cfg, err := foundation.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if cfg.Callers[0].KeyID != "key_new" || cfg.Callers[0].KeySuffix != "newx" {
		t.Fatalf("ambiguous activate failure did not preserve replacement config: %#v", cfg.Callers[0])
	}
	assertNoSecretLeak(t, newKey, stdout, stderr, configPath)
}

func TestCallerRotateRestoresOldStateWhenActivateDefinitivelyDidNotCommit(t *testing.T) {
	const oldKey = "aob_live_oldkey_oldsecret"
	const newKey = "aob_live_newkey_newsecret"
	store := &controlPlaneSecretStore{keys: map[string]string{"caller_123": oldKey}}
	configPath := writeControlConfig(t, "http://placeholder.invalid")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/rotate/device/start":
			writeEnvelope(w, `{"device_code":"dev_rotate","user_code":"ROTATE-1","verification_uri":"https://app.example/caller/rotate/device","verification_uri_complete":"https://app.example/caller/rotate/device?user_code=ROTATE-1","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/rotate/device/poll":
			writeEnvelope(w, `{"setup_request_id":"setup_rotate","setup_code":"setup_rotate_code","expires_at":"2026-07-02T20:10:00Z"}`)
		case "/api/caller/rotate/exchange":
			writeEnvelope(w, fmt.Sprintf(`{"caller":{"caller_id":"caller_123","caller_slug":"steward-email","display_name":"Steward Email"},"account":{"account_id":"acct_123","label":"Test","effective_tier":"free"},"replacement_credential":{"api_key":%q,"key_id":"key_new","prefix":"aob_live","last_chars":"newx","created_at":"2026-07-02T20:00:00Z","expires_at":"2026-07-02T20:10:00Z"},"replaces_credential":{"key_id":"key_old","last_chars":"oldx"}}`, newKey))
		case "/api/caller/rotate/activate":
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = io.WriteString(w, `{"ok":false,"request_id":"req_bad_activate","correlation_id":"corr_bad_activate","error":{"code":"validation_failed","message":"Activation request was invalid."}}`)
		default:
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      store,
		args:       []string{"--json", "caller", "rotate", "--device-code"},
	})
	if code != foundation.ExitData {
		t.Fatalf("exit code = %d, want validation failure; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for failed rotate")
	}
	if store.keys["caller_123"] != oldKey {
		t.Fatalf("definitive activate failure did not restore old key; key=%q", store.keys["caller_123"])
	}
	cfg, err := foundation.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if cfg.Callers[0].KeyID != "key_old" || cfg.Callers[0].KeySuffix != "oldx" {
		t.Fatalf("definitive activate failure did not restore old config: %#v", cfg.Callers[0])
	}
	assertNoSecretLeak(t, newKey, stdout, stderr, configPath)
}

func TestCallerRevokeDeviceFlowConfirmsAndPreservesLocalState(t *testing.T) {
	store := &controlPlaneSecretStore{keys: map[string]string{"caller_123": "old-secret"}}
	configPath := writeControlConfig(t, "http://placeholder.invalid")
	var confirmed bool

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/revoke/device/start":
			assertCallerOperationStart(t, r)
			writeEnvelope(w, `{"device_code":"dev_revoke","user_code":"REVOKE-1","verification_uri":"https://app.example/caller/revoke/device","verification_uri_complete":"https://app.example/caller/revoke/device?user_code=REVOKE-1","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/revoke/device/poll":
			writeEnvelope(w, `{"setup_request_id":"setup_revoke","setup_code":"setup_revoke_code","expires_at":"2026-07-02T20:10:00Z"}`)
		case "/api/caller/revoke/confirm":
			confirmed = true
			var body map[string]string
			decodeJSONBody(t, r, &body)
			if body["setup_code"] != "setup_revoke_code" {
				t.Fatalf("revoke confirm body = %#v", body)
			}
			writeEnvelope(w, `{"caller_id":"caller_123","revoked_key_ids":["key_old"],"revoked_at":"2026-07-02T20:01:00Z"}`)
		default:
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      store,
		args:       []string{"--json", "caller", "revoke", "steward-email", "--device-code"},
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if !confirmed {
		t.Fatalf("revoke confirm was not called")
	}
	if store.keys["caller_123"] != "old-secret" {
		t.Fatalf("local caller key changed after revoke: %#v", store.keys)
	}
	cfg, err := foundation.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if len(cfg.Callers) != 1 || cfg.Callers[0].Name != "steward-email" {
		t.Fatalf("local caller config was not preserved: %#v", cfg.Callers)
	}
	if strings.Contains(stdout, "old-secret") || strings.Contains(stderr, "old-secret") {
		t.Fatalf("revoke leaked old secret")
	}
}

func TestCallerRevokeDoesNotRequireWritableSecretStore(t *testing.T) {
	configPath := writeControlConfig(t, "http://placeholder.invalid")
	var confirmed bool

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/revoke/device/start":
			assertCallerOperationStart(t, r)
			writeEnvelope(w, `{"device_code":"dev_revoke","user_code":"REVOKE-1","verification_uri":"https://app.example/caller/revoke/device","verification_uri_complete":"https://app.example/caller/revoke/device?user_code=REVOKE-1","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/revoke/device/poll":
			writeEnvelope(w, `{"setup_request_id":"setup_revoke","setup_code":"setup_revoke_code","expires_at":"2026-07-02T20:10:00Z"}`)
		case "/api/caller/revoke/confirm":
			confirmed = true
			writeEnvelope(w, `{"caller_id":"caller_123","revoked_key_ids":["key_old"],"revoked_at":"2026-07-02T20:01:00Z"}`)
		default:
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      readOnlyControlPlaneSecretStore{},
		args:       []string{"--json", "caller", "revoke", "steward-email", "--device-code"},
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if !confirmed {
		t.Fatalf("revoke confirm was not called")
	}
	if !strings.Contains(stdout, `"revoked":true`) {
		t.Fatalf("revoke stdout missing success payload: %s", stdout)
	}
}

func TestCallerListIsLocalOnlyAndFailsWhenNoLocalCallers(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	configPath := writeControlConfig(t, server.URL)
	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      &controlPlaneSecretStore{},
		args:       []string{"--json", "caller", "list"},
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("exit code = %d, stderr: %s", code, stderr)
	}
	if requests != 0 {
		t.Fatalf("caller list made %d server requests", requests)
	}
	if !strings.Contains(stdout, `"name":"steward-email"`) {
		t.Fatalf("list stdout missing local caller: %s", stdout)
	}

	badBaseURLConfigPath := writeControlConfig(t, "https://example.com/not-an-origin")
	stdout, stderr, code = executeControlCommand(t, controlCommandOptions{
		configPath: badBaseURLConfigPath,
		store:      &controlPlaneSecretStore{},
		args:       []string{"--json", "caller", "list"},
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("caller list should ignore invalid local base_url, exit code = %d, stderr: %s", code, stderr)
	}
	if requests != 0 {
		t.Fatalf("caller list with invalid base_url made %d server requests", requests)
	}
	if !strings.Contains(stdout, `"name":"steward-email"`) {
		t.Fatalf("list stdout missing local caller with invalid base_url: %s", stdout)
	}

	emptyConfigPath := filepath.Join(t.TempDir(), "config.json")
	stdout, stderr, code = executeControlCommand(t, controlCommandOptions{
		configPath: emptyConfigPath,
		baseURL:    server.URL,
		store:      &controlPlaneSecretStore{},
		args:       []string{"--json", "caller", "list"},
	})
	if code != foundation.ExitConfig {
		t.Fatalf("exit code = %d, want config for missing local callers", code)
	}
	if stdout != "" {
		t.Fatalf("stdout should stay empty for local config failure")
	}
	if !strings.Contains(stderr, "caller connect") {
		t.Fatalf("list remediation missing connect command: %s", stderr)
	}
}

func TestCallerListFailsForIncompleteLocalCallerRecords(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	configPath := filepath.Join(t.TempDir(), "config.json")
	content := fmt.Sprintf(`{
  "version": 1,
  "base_url": %q,
  "callers": [
    {
      "name": "steward-email",
      "account_id": "acct_123",
      "caller_id": "caller_123",
      "key_prefix": "aob_live"
    }
  ]
}`, server.URL)
	if err := os.WriteFile(configPath, []byte(content), 0o600); err != nil {
		t.Fatalf("write config fixture: %v", err)
	}

	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      &controlPlaneSecretStore{},
		args:       []string{"--json", "caller", "list"},
	})
	if code != foundation.ExitConfig {
		t.Fatalf("exit code = %d, want config for incomplete local caller", code)
	}
	if stdout != "" {
		t.Fatalf("stdout should stay empty for incomplete local caller")
	}
	if requests != 0 {
		t.Fatalf("caller list made %d server requests", requests)
	}
	for _, want := range []string{"incomplete", "key_id", "key_suffix", "caller connect"} {
		if !strings.Contains(stderr, want) {
			t.Fatalf("stderr missing %q: %s", want, stderr)
		}
	}
}

func TestCallerDisconnectKeepsConfigWhenSecretDeleteFails(t *testing.T) {
	deleteErr := foundation.NewSecretStoreError("fake delete failure")
	store := &controlPlaneSecretStore{
		keys:      map[string]string{"caller_123": "old-secret"},
		deleteErr: deleteErr,
	}
	configPath := writeControlConfig(t, "http://placeholder.invalid")
	requests := 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      store,
		args:       []string{"--json", "--caller", "steward-email", "caller", "disconnect"},
	})
	if code != foundation.ExitSecretStore {
		t.Fatalf("exit code = %d, want secret-store delete failure; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for failed disconnect")
	}
	if requests != 0 {
		t.Fatalf("local disconnect made %d server requests", requests)
	}
	if store.keys["caller_123"] != "old-secret" {
		t.Fatalf("failed delete changed secret store: %#v", store.keys)
	}
	cfg, err := foundation.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if len(cfg.Callers) != 1 || cfg.Callers[0].Name != "steward-email" {
		t.Fatalf("failed secret delete removed retryable config: %#v", cfg.Callers)
	}
}

func TestCallerDisconnectRevokeRunsRemoteBeforeWritableSecretStoreFailure(t *testing.T) {
	configPath := writeControlConfig(t, "http://placeholder.invalid")
	var confirmed bool

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/revoke/device/start":
			writeEnvelope(w, `{"device_code":"dev_revoke","user_code":"REVOKE-1","verification_uri":"https://app.example/caller/revoke/device","verification_uri_complete":"https://app.example/caller/revoke/device?user_code=REVOKE-1","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/revoke/device/poll":
			writeEnvelope(w, `{"setup_request_id":"setup_revoke","setup_code":"setup_revoke_code","expires_at":"2026-07-02T20:10:00Z"}`)
		case "/api/caller/revoke/confirm":
			confirmed = true
			writeEnvelope(w, `{"caller_id":"caller_123","revoked_key_ids":["key_old"],"revoked_at":"2026-07-02T20:01:00Z"}`)
		default:
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      readOnlyControlPlaneSecretStore{},
		args:       []string{"--json", "--caller", "steward-email", "caller", "disconnect", "--revoke", "--device-code"},
	})
	if code != foundation.ExitSecretStore {
		t.Fatalf("exit code = %d, want local cleanup secret-store failure after revoke; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty when post-revoke local cleanup fails")
	}
	if !confirmed {
		t.Fatalf("remote revoke did not run before writable secret-store failure")
	}
	cfg, err := foundation.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if len(cfg.Callers) != 1 || cfg.Callers[0].Name != "steward-email" {
		t.Fatalf("post-revoke cleanup failure removed retryable config: %#v", cfg.Callers)
	}
}

func TestCallerDisconnectLocalOnlyVersusRevoke(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		switch r.URL.Path {
		case "/api/caller/revoke/device/start":
			writeEnvelope(w, `{"device_code":"dev_revoke","user_code":"REVOKE-1","verification_uri":"https://app.example/caller/revoke/device","verification_uri_complete":"https://app.example/caller/revoke/device?user_code=REVOKE-1","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/revoke/device/poll":
			writeEnvelope(w, `{"setup_request_id":"setup_revoke","setup_code":"setup_revoke_code","expires_at":"2026-07-02T20:10:00Z"}`)
		case "/api/caller/revoke/confirm":
			writeEnvelope(w, `{"caller_id":"caller_123","revoked_key_ids":["key_old"],"revoked_at":"2026-07-02T20:01:00Z"}`)
		default:
			t.Fatalf("unexpected disconnect --revoke request: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	localStore := &controlPlaneSecretStore{keys: map[string]string{"caller_123": "old-secret"}}
	localConfig := writeControlConfig(t, "https://example.com/not-an-origin")
	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: localConfig,
		store:      localStore,
		args:       []string{"--json", "--caller", "steward-email", "caller", "disconnect"},
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("local disconnect exit code = %d, stderr: %s", code, stderr)
	}
	if requests != 0 {
		t.Fatalf("local disconnect made %d server requests", requests)
	}
	if _, ok := localStore.keys["caller_123"]; ok {
		t.Fatalf("local disconnect did not delete secret")
	}
	if !strings.Contains(stdout, `"revoked":false`) {
		t.Fatalf("local disconnect stdout missing revoked=false: %s", stdout)
	}

	revokeStore := &controlPlaneSecretStore{keys: map[string]string{"caller_123": "old-secret"}}
	revokeConfig := writeControlConfig(t, server.URL)
	stdout, stderr, code = executeControlCommand(t, controlCommandOptions{
		configPath: revokeConfig,
		baseURL:    server.URL,
		store:      revokeStore,
		args:       []string{"--json", "--caller", "steward-email", "caller", "disconnect", "--revoke", "--device-code"},
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("disconnect --revoke exit code = %d, stderr: %s", code, stderr)
	}
	if requests == 0 {
		t.Fatalf("disconnect --revoke did not call server revoke flow")
	}
	if _, ok := revokeStore.keys["caller_123"]; ok {
		t.Fatalf("disconnect --revoke did not delete secret")
	}
	if !strings.Contains(stdout, `"revoked":true`) || !strings.Contains(stdout, `"key_old"`) {
		t.Fatalf("disconnect --revoke stdout missing revoke result: %s", stdout)
	}
}

func TestDuplicateConnectSurfacesCallerAlreadyExistsWithoutLocalMutation(t *testing.T) {
	store := &controlPlaneSecretStore{}
	configPath := filepath.Join(t.TempDir(), "config.json")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/connect/device/start":
			writeEnvelope(w, `{"device_code":"dev_connect","user_code":"ABCD-EFGH","verification_uri":"https://app.example/caller/connect/device","verification_uri_complete":"https://app.example/caller/connect/device?user_code=ABCD-EFGH","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/connect/device/poll":
			w.WriteHeader(http.StatusConflict)
			_, _ = io.WriteString(w, `{"ok":false,"request_id":"req_dup","correlation_id":"corr_dup","error":{"code":"caller_already_exists","message":"Caller already exists for this account."}}`)
		default:
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		baseURL:    server.URL,
		store:      store,
		args:       []string{"--json", "caller", "connect", "steward-email", "--device-code"},
	})
	if code != foundation.ExitConflict {
		t.Fatalf("exit code = %d, want conflict; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for duplicate connect")
	}
	if !strings.Contains(stderr, `"code":"caller_already_exists"`) || !strings.Contains(stderr, `"request_id":"req_dup"`) {
		t.Fatalf("duplicate connect did not surface API error cleanly: %s", stderr)
	}
	if len(store.keys) != 0 {
		t.Fatalf("duplicate connect mutated local secret store: %#v", store.keys)
	}
}

type controlCommandOptions struct {
	configPath  string
	baseURL     string
	store       foundation.CallerSecretLoader
	args        []string
	httpClient  *http.Client
	openBrowser func(string) error
	sleep       func(context.Context, time.Duration) error
	now         func() time.Time
}

func executeControlCommand(t *testing.T, opts controlCommandOptions) (string, string, int) {
	t.Helper()
	fullArgs := []string{"--config", opts.configPath}
	if opts.baseURL != "" {
		fullArgs = append(fullArgs, "--base-url", opts.baseURL)
	}
	fullArgs = append(fullArgs, opts.args...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := Execute(context.Background(), Options{
		Args:         fullArgs,
		Stdout:       &stdout,
		Stderr:       &stderr,
		Env:          foundation.Env{},
		SecretStore:  opts.store,
		HTTPClient:   opts.httpClient,
		NewRequestID: func() string { return "req_cli" },
		OpenBrowser:  opts.openBrowser,
		Sleep:        opts.sleep,
		Now: func() time.Time {
			if opts.now != nil {
				return opts.now()
			}
			return testControlNow
		},
	})
	return stdout.String(), stderr.String(), code
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func clientForOnlyOrigin(t *testing.T, rawURL string) *http.Client {
	t.Helper()
	allowed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse allowed origin: %v", err)
	}
	return &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if r.URL.Scheme != allowed.Scheme || r.URL.Host != allowed.Host {
				return nil, fmt.Errorf("unexpected Agent Outbox API origin %s", r.URL.String())
			}
			return http.DefaultTransport.RoundTrip(r)
		}),
	}
}

func writeControlConfig(t *testing.T, baseURL string) string {
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
      "key_id": "key_old",
      "key_prefix": "aob_live",
      "key_suffix": "oldx"
    }
  ]
}`, baseURL)
	if err := os.WriteFile(configPath, []byte(content), 0o600); err != nil {
		t.Fatalf("write config fixture: %v", err)
	}
	return configPath
}

func assertCallerOperationStart(t *testing.T, r *http.Request) {
	t.Helper()
	var body map[string]string
	decodeJSONBody(t, r, &body)
	if body["caller_id"] != "caller_123" || body["local_caller_name"] != "steward-email" {
		t.Fatalf("operation start body = %#v", body)
	}
}

func decodeJSONBody(t *testing.T, r *http.Request, out any) {
	t.Helper()
	if err := json.NewDecoder(r.Body).Decode(out); err != nil {
		t.Fatalf("request body was not JSON: %v", err)
	}
}

func writeEnvelope(w http.ResponseWriter, data string) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"ok":true,"request_id":"req_server","data":`+data+`}`)
}

func assertNoSecretLeak(t *testing.T, secret string, stdout string, stderr string, configPath string) {
	t.Helper()
	configBytes, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config for leak check: %v", err)
	}
	for name, content := range map[string]string{
		"stdout": stdout,
		"stderr": stderr,
		"config": string(configBytes),
	} {
		if strings.Contains(content, secret) {
			t.Fatalf("%s leaked credential bytes %q: %s", name, secret, content)
		}
	}
}
