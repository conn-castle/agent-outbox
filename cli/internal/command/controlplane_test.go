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
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"agent-outbox/internal/foundation"
)

var testControlNow = time.Date(2026, 7, 2, 20, 0, 0, 0, time.UTC)

type controlPlaneSecretStore struct {
	keys     map[string]string
	storeErr error
	// failStoreKey makes only stores of this key value fail, so a later rollback store can fail
	// after an earlier store succeeded.
	failStoreKey string
	// onStore runs after each successful store, letting a test break later local writes.
	onStore   func(callerAPIKey string)
	deleteErr error
	// onDelete runs before each delete, letting a test vary failures and commit side effects.
	onDelete     func(callerID string)
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
	if s.failStoreKey != "" && callerAPIKey == s.failStoreKey {
		return foundation.NewSecretStoreError("fake credential write failure")
	}
	if s.keys == nil {
		s.keys = map[string]string{}
	}
	s.keys[callerID] = callerAPIKey
	if s.onStore != nil {
		s.onStore(callerAPIKey)
	}
	return nil
}

func (s *controlPlaneSecretStore) DeleteCallerKey(callerID string) error {
	if s.onDelete != nil {
		s.onDelete(callerID)
	}
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
		}, nil)
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
	}, "connect", func(string) (browserStartData, *foundation.APIResponse, error) {
		return browserStartData{
			ApprovalURL:    "https://app.example/caller/connect/approve?setup=setup_expired",
			SetupRequestID: "setup_expired",
			ExpiresAt:      time.Now().Add(-time.Minute).UTC().Format(time.RFC3339),
		}, nil, nil
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
					w.Header().Set("X-Correlation-ID", "corr_contract")
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
			if code != foundation.ExitTemporary {
				t.Fatalf("exit code = %d, want temporary error; stdout: %s stderr: %s", code, stdout, stderr)
			}
			assertAPIResponseInvalid(t, stdout, stderr, code)
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

func TestCallerConnectRejectsServerThatDiffersFromExistingCallersBeforeApproval(t *testing.T) {
	const existingServer = "https://app.example"
	store := &controlPlaneSecretStore{keys: map[string]string{"caller_123": "existing-secret"}}
	configPath := writeControlConfig(t, existingServer)
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
		args:       []string{"--json", "caller", "connect", "second-caller", "--device-code"},
	})
	if code != foundation.ExitConfig {
		t.Fatalf("exit code = %d, want config failure; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for rejected connect")
	}
	if !strings.Contains(stderr, "--config") {
		t.Fatalf("rejected connect did not point to a separate config: %s", stderr)
	}
	if requests != 0 {
		t.Fatalf("rejected connect made %d server requests", requests)
	}
	if len(store.keys) != 1 || store.keys["caller_123"] != "existing-secret" {
		t.Fatalf("rejected connect mutated secret store: %#v", store.keys)
	}
	cfg, err := foundation.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if cfg.BaseURL != existingServer || len(cfg.Callers) != 1 || cfg.Callers[0].CallerID != "caller_123" {
		t.Fatalf("rejected connect changed config: base_url=%q callers=%#v", cfg.BaseURL, cfg.Callers)
	}
}

func TestCallerConnectAddsCallerOnExistingCallersServer(t *testing.T) {
	const pendingKey = "aob_live_keyid_secondcaller"
	store := &controlPlaneSecretStore{keys: map[string]string{"caller_123": "existing-secret"}}
	var configPath string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/connect/device/start":
			writeEnvelope(w, `{"device_code":"dev_connect","user_code":"CONNECT-1","verification_uri":"https://app.example/caller/connect/device","verification_uri_complete":"https://app.example/caller/connect/device?user_code=CONNECT-1","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/connect/device/poll":
			writeEnvelope(w, fmt.Sprintf(`{"setup_request_id":"setup_second","caller":{"caller_id":"caller_456","caller_slug":"second-caller","display_name":"Second Caller"},"account":{"account_id":"acct_123","label":"Test","effective_tier":"free"},"credential":{"api_key":%q,"key_id":"key_second","prefix":"aob_live","last_chars":"ller","created_at":"2026-07-02T20:00:00Z","expires_at":"2026-07-02T20:10:00Z"}}`, pendingKey))
		case "/api/caller/connect/activate":
			writeEnvelope(w, `{"caller_id":"caller_456","activated_key_id":"key_second","activated_at":"2026-07-02T20:01:00Z"}`)
		default:
			t.Fatalf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()
	configPath = writeControlConfig(t, server.URL)

	_, stderr, code := executeControlCommand(t, controlCommandOptions{
		configPath: configPath,
		store:      store,
		args:       []string{"--json", "caller", "connect", "second-caller", "--device-code"},
		httpClient: clientForOnlyOrigin(t, server.URL),
	})
	if code != foundation.ExitSuccess {
		t.Fatalf("connect exit code = %d, stderr: %s", code, stderr)
	}
	if store.keys["caller_123"] != "existing-secret" || store.keys["caller_456"] != pendingKey {
		t.Fatalf("secret store = %#v, want existing and new caller keys", store.keys)
	}
	cfg, err := foundation.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if cfg.BaseURL != server.URL || len(cfg.Callers) != 2 {
		t.Fatalf("config after connect: base_url=%q callers=%#v", cfg.BaseURL, cfg.Callers)
	}
}

func TestCallerConnectAbortsWhenConcurrentConnectBindsConfigToAnotherServer(t *testing.T) {
	const pendingKey = "aob_live_pending_racesecret"
	const otherServer = "https://other.example"
	store := &controlPlaneSecretStore{}
	configPath := filepath.Join(t.TempDir(), "config.json")
	var aborts int
	var activates int

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/connect/device/start":
			writeEnvelope(w, `{"device_code":"dev_connect","user_code":"CONNECT-1","verification_uri":"https://app.example/caller/connect/device","verification_uri_complete":"https://app.example/caller/connect/device?user_code=CONNECT-1","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/connect/device/poll":
			// Another process connects a caller on a different server while approval is pending.
			concurrent, err := os.ReadFile(writeControlConfig(t, otherServer))
			if err != nil {
				t.Fatalf("read concurrent config fixture: %v", err)
			}
			if err := os.WriteFile(configPath, concurrent, 0o600); err != nil {
				t.Fatalf("write concurrent config: %v", err)
			}
			writeEnvelope(w, fmt.Sprintf(`{"setup_request_id":"setup_race","caller":{"caller_id":"caller_456","caller_slug":"second-caller","display_name":"Second Caller"},"account":{"account_id":"acct_123","label":"Test","effective_tier":"free"},"credential":{"api_key":%q,"key_id":"key_pending","prefix":"aob_live","last_chars":"cret","created_at":"2026-07-02T20:00:00Z","expires_at":"2026-07-02T20:10:00Z"}}`, pendingKey))
		case "/api/caller/connect/abort":
			aborts++
			if got := r.Header.Get("Authorization"); got != "Bearer "+pendingKey {
				t.Fatalf("abort authorization = %q", got)
			}
			writeEnvelope(w, `{"caller_id":"caller_456","aborted_key_id":"key_pending","aborted_at":"2026-07-02T20:01:00Z"}`)
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
		args:       []string{"--json", "caller", "connect", "second-caller", "--device-code"},
	})
	if code != foundation.ExitConfig {
		t.Fatalf("exit code = %d, want config failure; stderr: %s", code, stderr)
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
	if cfg.BaseURL != otherServer || len(cfg.Callers) != 1 || cfg.Callers[0].CallerID != "caller_123" {
		t.Fatalf("failed connect changed concurrent config: base_url=%q callers=%#v", cfg.BaseURL, cfg.Callers)
	}
}

func TestCallerConnectAcceptsEquivalentOrigins(t *testing.T) {
	for _, tc := range []struct {
		name       string
		stored     string
		requested  string
		saved      string
		initialize bool
	}{
		{name: "host_case", stored: "https://app.example", requested: "https://App.Example"},
		{name: "host_case_reverse", stored: "https://App.Example", requested: "https://app.example"},
		{name: "https_default_port", stored: "https://app.example", requested: "https://app.example:443"},
		{name: "https_default_port_reverse", stored: "https://app.example:443", requested: "https://app.example"},
		{name: "http_default_port", stored: "http://localhost", requested: "http://localhost:80"},
		{name: "http_default_port_reverse", stored: "http://localhost:80", requested: "http://localhost"},
		{name: "https_padded_default_port", stored: "https://app.example", requested: "https://app.example:0443"},
		{name: "https_padded_default_port_reverse", stored: "https://app.example:0443", requested: "https://app.example"},
		{name: "https_padded_explicit_default_port", stored: "https://app.example:443", requested: "https://app.example:0443"},
		{name: "https_padded_explicit_default_port_reverse", stored: "https://app.example:0443", requested: "https://app.example:443"},
		{name: "http_padded_default_port", stored: "http://localhost", requested: "http://localhost:080"},
		{name: "http_padded_default_port_reverse", stored: "http://localhost:080", requested: "http://localhost"},
		{name: "padded_nondefault_port", stored: "https://app.example:8443", requested: "https://app.example:08443"},
		{name: "padded_nondefault_port_reverse", stored: "https://app.example:08443", requested: "https://app.example:8443"},
		{name: "padded_zero_port", stored: "https://app.example:0", requested: "https://app.example:000"},
		{name: "same_unicode_host_ascii_case", stored: "https://straße.example", requested: "https://straße.EXAMPLE"},
		{name: "combined", stored: "https://App.Example:443", requested: "https://app.example"},
		{name: "combined_reverse", stored: "https://app.example", requested: "https://App.Example:443"},
		{name: "ipv6_host_case", stored: "https://[2001:db8::abcd]", requested: "https://[2001:DB8::ABCD]:443"},
		{name: "ipv6_expanded", stored: "https://[2001:db8::1]", requested: "https://[2001:0db8:0:0:0:0:0:1]"},
		{name: "ipv6_expanded_reverse", stored: "https://[2001:0db8:0:0:0:0:0:1]", requested: "https://[2001:db8::1]"},
		{name: "ipv6_loopback_expanded", stored: "http://[::1]", requested: "http://[0:0:0:0:0:0:0:1]:080"},
		{name: "ipv6_mapped_spelling", stored: "https://[::ffff:192.0.2.1]", requested: "https://[0:0:0:0:0:ffff:c000:201]"},
		{name: "ipv6_same_zone", stored: "https://[fe80::1%25Eth0]", requested: "https://[fe80::1%25Eth0]"},
		{name: "ipv6_zone_expanded", stored: "https://[fe80::1%25Eth0]", requested: "https://[fe80:0:0:0:0:0:0:1%25Eth0]:0443"},
		{name: "ipv6_zone_expanded_reverse", stored: "https://[fe80:0:0:0:0:0:0:1%25Eth0]:0443", requested: "https://[fe80::1%25Eth0]"},
		{name: "ipv6_zone_escape_spelling", stored: "https://[fe80::1%25Eth0]", requested: "https://[fe80::1%25Et%68%30]", saved: "https://[fe80::1%25Eth0]"},
		{name: "initialize_ipv6_zone", requested: "https://[fe80::1%25Eth0]", initialize: true},
		{name: "same_nondefault_port", stored: "https://App.Example:8443", requested: "https://app.example:8443"},
		{name: "trailing_slash", stored: "https://app.example", requested: "https://app.example/", saved: "https://app.example"},
		{name: "default_config_origin", requested: foundation.DefaultBaseURL},
		{name: "default_config_origin_explicit_port", requested: foundation.DefaultBaseURL + ":443"},
		{name: "initialize_empty_config", requested: "https://App.Example:443", initialize: true},
		{name: "initialize_invalid_stored_url", stored: "invalid", requested: "https://App.Example:443", initialize: true},
	} {
		for _, selection := range []string{"flag", "env"} {
			t.Run(tc.name+"/"+selection, func(t *testing.T) {
				configPath := writeControlConfig(t, tc.stored)
				existing, err := foundation.LoadConfig(configPath)
				if err != nil {
					t.Fatal(err)
				}
				store := &controlPlaneSecretStore{keys: map[string]string{"caller_123": "existing-secret"}}
				if tc.initialize {
					existing.Callers = nil
					store.keys = map[string]string{}
					if err := foundation.SaveConfig(configPath, existing); err != nil {
						t.Fatal(err)
					}
				}
				wantURL := tc.saved
				if wantURL == "" {
					wantURL = tc.requested
				}
				const pendingKey = "aob_live_pending_originsecret"
				var requests []string
				opts := controlCommandOptions{
					configPath: configPath,
					store:      store,
					args:       []string{"--json", "caller", "connect", "second-caller", "--device-code"},
					sleep:      func(context.Context, time.Duration) error { return nil },
					httpClient: mockConnectOriginClient(t, wantURL, pendingKey, func(r *http.Request) {
						requests = append(requests, r.URL.Path)
						if r.URL.Path == "/api/caller/connect/activate" {
							// Observe durable state at the external activation boundary.
							assertConnectOriginState(t, configPath, wantURL, existing.Callers, store, pendingKey)
						}
					}),
				}
				if selection == "flag" {
					opts.baseURL = tc.requested
					// The flag must continue taking precedence over the environment.
					opts.env = foundation.Env{foundation.EnvBaseURL: "https://other.example"}
				} else {
					opts.env = foundation.Env{foundation.EnvBaseURL: tc.requested}
				}
				stdout, stderr, code := executeControlCommand(t, opts)
				if code != foundation.ExitSuccess || !strings.Contains(stdout, `"connected":true`) {
					t.Fatalf("connect exit=%d requests=%v, want success; stdout=%s stderr=%s", code, requests, stdout, stderr)
				}
				wantRequests := []string{"/api/caller/connect/device/start", "/api/caller/connect/device/poll", "/api/caller/connect/activate"}
				if !reflect.DeepEqual(requests, wantRequests) {
					t.Fatalf("requests = %v, want %v", requests, wantRequests)
				}
				assertConnectOriginState(t, configPath, wantURL, existing.Callers, store, pendingKey)
				assertNoSecretLeak(t, pendingKey, stdout, stderr, configPath)
			})
		}
	}
}

func TestCallerConnectRejectsDistinctOrInvalidOriginsBeforeApproval(t *testing.T) {
	for _, tc := range []struct {
		name      string
		stored    string
		requested string
		message   string
	}{
		{name: "hostname", stored: "https://app.example", requested: "https://other.example"},
		{name: "unicode_sharp_s", stored: "https://straße.example", requested: "https://STRAẞE.example"},
		{name: "unicode_sharp_s_reverse", stored: "https://STRAẞE.example", requested: "https://straße.example"},
		{name: "unicode_final_sigma", stored: "https://οδός.example", requested: "https://ΟΔΌΣ.example"},
		{name: "unicode_final_sigma_reverse", stored: "https://ΟΔΌΣ.example", requested: "https://οδός.example"},
		{name: "scheme", stored: "http://localhost", requested: "https://localhost"},
		{name: "nondefault_port", stored: "https://app.example:8443", requested: "https://app.example:9443"},
		{name: "default_vs_nondefault_port", stored: "https://app.example", requested: "https://app.example:8443"},
		{name: "zero_vs_https_default_port", stored: "https://app.example:0", requested: "https://app.example"},
		{name: "https_default_vs_zero_port", stored: "https://app.example", requested: "https://app.example:0"},
		{name: "zero_vs_http_default_port", stored: "http://localhost:0", requested: "http://localhost"},
		{name: "4430_vs_443_port", stored: "https://app.example:4430", requested: "https://app.example:443"},
		{name: "844_vs_8440_port", stored: "https://app.example:844", requested: "https://app.example:8440"},
		{name: "loopback_alias", stored: "https://localhost", requested: "https://127.0.0.1"},
		{name: "ipv6_zone_case", stored: "https://[fe80::1%25Eth0]", requested: "https://[fe80::1%25eth0]"},
		{name: "ipv6_address", stored: "https://[2001:db8::1]", requested: "https://[2001:0db8:0:0:0:0:0:2]"},
		{name: "ipv6_expanded_different_port", stored: "https://[2001:db8::1]", requested: "https://[2001:0db8:0:0:0:0:0:1]:8443"},
		{name: "ipv6_expanded_different_scheme", stored: "http://[::1]", requested: "https://[0:0:0:0:0:0:0:1]"},
		{name: "ipv6_zone_case_expanded", stored: "https://[fe80::1%25Eth0]", requested: "https://[fe80:0:0:0:0:0:0:1%25eth0]"},
		{name: "ipv6_zone_missing", stored: "https://[fe80::1%25Eth0]", requested: "https://[fe80:0:0:0:0:0:0:1]"},
		{name: "ipv6_zone_missing_reverse", stored: "https://[fe80::1]", requested: "https://[fe80:0:0:0:0:0:0:1%25Eth0]"},
		{name: "ipv6_zone_literal_escape", stored: "https://[fe80::1%25Eth0]", requested: "https://[fe80::1%25%2545th0]"},
		{name: "ipv6_mapped_vs_ipv4", stored: "https://[::ffff:192.0.2.1]", requested: "https://192.0.2.1"},
		{name: "default_config_origin", requested: "https://other.example"},
		{name: "invalid_stored_url", stored: "invalid", requested: "https://app.example", message: "Local config base_url"},
		{name: "stored_path_prefix", stored: "https://app.example/api", requested: "https://app.example", message: "Local config base_url"},
		{name: "requested_path_prefix", stored: "https://app.example", requested: "https://app.example/api", message: "must not include a path"},
	} {
		for _, selection := range []string{"flag", "env"} {
			t.Run(tc.name+"/"+selection, func(t *testing.T) {
				configPath := writeControlConfig(t, tc.stored)
				before, err := os.ReadFile(configPath)
				if err != nil {
					t.Fatal(err)
				}
				store := &controlPlaneSecretStore{keys: map[string]string{"caller_123": "existing-secret"}}
				requests := 0
				opts := controlCommandOptions{
					configPath: configPath,
					store:      store,
					args:       []string{"--json", "caller", "connect", "second-caller", "--device-code"},
					httpClient: mockConnectOriginClient(t, tc.requested, "aob_live_pending_rejectedsecret", func(*http.Request) {
						requests++
					}),
				}
				if selection == "flag" {
					opts.baseURL = tc.requested
				} else {
					opts.env = foundation.Env{foundation.EnvBaseURL: tc.requested}
				}
				stdout, stderr, code := executeControlCommand(t, opts)
				message := tc.message
				if message == "" {
					message = "separate --config"
				}
				if code != foundation.ExitConfig || stdout != "" || !strings.Contains(stderr, `"code":"config_error"`) || !strings.Contains(stderr, message) {
					t.Errorf("exit=%d requests=%d stdout=%s stderr=%s, want config_error with %q", code, requests, stdout, stderr, message)
				}
				if requests != 0 {
					t.Errorf("rejected connect made %d requests before approval", requests)
				}
				after, err := os.ReadFile(configPath)
				if err != nil || !bytes.Equal(before, after) {
					t.Fatalf("rejected connect changed config; read error: %v", err)
				}
				if len(store.keys) != 1 || store.keys["caller_123"] != "existing-secret" {
					t.Fatalf("rejected connect changed credentials: %#v", store.keys)
				}
			})
		}
	}
}

func TestCallerConnectRechecksConfigOriginBeforeActivation(t *testing.T) {
	for _, tc := range []struct {
		name       string
		requested  string
		concurrent string
		accept     bool
	}{
		{name: "same_spelling", requested: "https://app.example", concurrent: "https://app.example", accept: true},
		{name: "host_case", requested: "https://app.example", concurrent: "https://App.Example", accept: true},
		{name: "host_case_reverse", requested: "https://App.Example", concurrent: "https://app.example", accept: true},
		{name: "default_port", requested: "https://app.example", concurrent: "https://app.example:443", accept: true},
		{name: "default_port_reverse", requested: "https://app.example:443", concurrent: "https://app.example", accept: true},
		{name: "http_default_port", requested: "http://localhost", concurrent: "http://localhost:80", accept: true},
		{name: "padded_default_port", requested: "https://app.example:0443", concurrent: "https://app.example", accept: true},
		{name: "padded_nondefault_port", requested: "https://app.example:8443", concurrent: "https://app.example:08443", accept: true},
		{name: "ipv6_expanded", requested: "https://[2001:db8::1]", concurrent: "https://[2001:0db8:0:0:0:0:0:1]", accept: true},
		{name: "ipv6_expanded_reverse", requested: "https://[2001:0db8:0:0:0:0:0:1]", concurrent: "https://[2001:db8::1]", accept: true},
		{name: "ipv6_same_zone", requested: "https://[fe80::1%25Eth0]", concurrent: "https://[fe80::1%25Eth0]", accept: true},
		{name: "ipv6_zone_expanded", requested: "https://[fe80::1%25Eth0]", concurrent: "https://[fe80:0:0:0:0:0:0:1%25Eth0]:0443", accept: true},
		{name: "ipv6_zone_expanded_reverse", requested: "https://[fe80:0:0:0:0:0:0:1%25Eth0]:0443", concurrent: "https://[fe80::1%25Eth0]", accept: true},
		{name: "ipv6_zone_escape_spelling", requested: "https://[fe80::1%25Eth0]", concurrent: "https://[fe80::1%25Et%68%30]", accept: true},
		{name: "ipv6_zone_case", requested: "https://[fe80::1%25Eth0]", concurrent: "https://[fe80:0:0:0:0:0:0:1%25eth0]"},
		{name: "ipv6_zone_literal_escape", requested: "https://[fe80::1%25Eth0]", concurrent: "https://[fe80::1%25%2545th0]"},
		{name: "ipv6_zone_removed", requested: "https://[fe80::1%25Eth0]", concurrent: "https://[fe80:0:0:0:0:0:0:1]"},
		{name: "ipv6_address", requested: "https://[2001:db8::1]", concurrent: "https://[2001:0db8:0:0:0:0:0:2]"},
		{name: "ipv6_zone_missing", requested: "https://[fe80::1]", concurrent: "https://[fe80:0:0:0:0:0:0:1%25Eth0]"},
		{name: "ipv6_mapped_vs_ipv4", requested: "https://[::ffff:192.0.2.1]", concurrent: "https://192.0.2.1"},
		{name: "hostname", requested: "https://app.example", concurrent: "https://other.example"},
		{name: "unicode_sharp_s", requested: "https://STRAẞE.example", concurrent: "https://straße.example"},
		{name: "unicode_final_sigma", requested: "https://ΟΔΌΣ.example", concurrent: "https://οδός.example"},
		{name: "scheme", requested: "https://localhost", concurrent: "http://localhost"},
		{name: "port", requested: "https://app.example", concurrent: "https://app.example:8443"},
		{name: "invalid_stored_url", requested: "https://app.example", concurrent: "invalid"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			configPath := filepath.Join(t.TempDir(), "config.json")
			concurrentPath := writeControlConfig(t, tc.concurrent)
			concurrentBytes, err := os.ReadFile(concurrentPath)
			if err != nil {
				t.Fatal(err)
			}
			concurrent, err := foundation.LoadConfig(concurrentPath)
			if err != nil {
				t.Fatal(err)
			}
			store := &controlPlaneSecretStore{}
			const pendingKey = "aob_live_pending_rechecksecret"
			var requests []string
			client := mockConnectOriginClient(t, tc.requested, pendingKey, func(r *http.Request) {
				requests = append(requests, r.URL.Path)
				switch r.URL.Path {
				case "/api/caller/connect/device/poll":
					// Approval has begun; another process adds a caller before the locked reload.
					if err := os.WriteFile(configPath, concurrentBytes, 0o600); err != nil {
						t.Fatal(err)
					}
					store.keys = map[string]string{"caller_123": "existing-secret"}
				case "/api/caller/connect/activate":
					if !tc.accept {
						t.Fatal("distinct concurrent origin must never activate")
					}
					assertConnectOriginState(t, configPath, tc.requested, concurrent.Callers, store, pendingKey)
				}
			})
			stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
				configPath: configPath,
				baseURL:    tc.requested,
				store:      store,
				args:       []string{"--json", "caller", "connect", "second-caller", "--device-code"},
				httpClient: client,
				sleep:      func(context.Context, time.Duration) error { return nil },
			})
			lastRequest := "/api/caller/connect/abort"
			if tc.accept {
				if code != foundation.ExitSuccess || !strings.Contains(stdout, `"connected":true`) {
					t.Fatalf("connect exit=%d requests=%v, want success; stdout=%s stderr=%s", code, requests, stdout, stderr)
				}
				lastRequest = "/api/caller/connect/activate"
				assertConnectOriginState(t, configPath, tc.requested, concurrent.Callers, store, pendingKey)
			} else {
				if code != foundation.ExitConfig || stdout != "" || !strings.Contains(stderr, `"code":"config_error"`) {
					t.Fatalf("exit=%d stdout=%s stderr=%s, want config_error", code, stdout, stderr)
				}
				after, err := os.ReadFile(configPath)
				if err != nil || !bytes.Equal(concurrentBytes, after) {
					t.Fatalf("refused connect changed concurrent config; read error: %v", err)
				}
				if len(store.keys) != 1 || store.keys["caller_123"] != "existing-secret" {
					t.Fatalf("refused connect changed credentials or left pending secret: %#v", store.keys)
				}
			}
			wantRequests := []string{"/api/caller/connect/device/start", "/api/caller/connect/device/poll", lastRequest}
			if !reflect.DeepEqual(requests, wantRequests) {
				t.Fatalf("requests = %v, want %v", requests, wantRequests)
			}
			assertNoSecretLeak(t, pendingKey, stdout, stderr, configPath)
		})
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

	if _, err := storeAndActivateConnect(context.Background(), runtime, "steward-email", result, nil); err == nil {
		t.Fatalf("storeAndActivateConnect succeeded despite config save failure")
	}
	if aborts != 1 || activates != 0 {
		t.Fatalf("aborts=%d activates=%d, want abort only", aborts, activates)
	}
	if len(store.keys) != 0 {
		t.Fatalf("config save failure left a hosted key stored locally: %#v", store.keys)
	}
}

func TestCallerConnectReportsFinalCredentialRollbackOutcomeWhenConfigSaveFails(t *testing.T) {
	for _, tc := range []struct {
		name               string
		firstDeleteCommits bool
		retryErr           error
	}{
		{name: "retry succeeds"},
		{name: "first delete commits before reporting failure", firstDeleteCommits: true},
		{name: "retry fails", retryErr: foundation.NewSecretStoreError("fake final credential delete failure")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const pendingKey = "aob_live_pending_connectsecret"
			configPath := filepath.Join(t.TempDir(), "config.json")
			store := &controlPlaneSecretStore{}
			var deletes int
			store.onDelete = func(callerID string) {
				deletes++
				if deletes == 1 {
					store.deleteErr = foundation.NewSecretStoreError("fake initial credential delete failure")
					if tc.firstDeleteCommits {
						delete(store.keys, callerID)
					}
					return
				}
				store.deleteErr = tc.retryErr
			}
			store.onStore = func(callerAPIKey string) {
				if callerAPIKey == pendingKey {
					blockConfigWrites(t, configPath)
				}
			}
			var aborts int

			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/caller/connect/device/start":
					writeEnvelope(w, `{"device_code":"dev_connect","user_code":"CONNECT-1","verification_uri":"https://app.example/caller/connect/device","verification_uri_complete":"https://app.example/caller/connect/device?user_code=CONNECT-1","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
				case "/api/caller/connect/device/poll":
					writeEnvelope(w, fmt.Sprintf(`{"setup_request_id":"setup_connect","caller":{"caller_id":"caller_123","caller_slug":"steward-email","display_name":"Steward Email"},"account":{"account_id":"acct_123","label":"Test","effective_tier":"free"},"credential":{"api_key":%q,"key_id":"key_pending","prefix":"aob_live","last_chars":"pend","created_at":"2026-07-02T20:00:00Z","expires_at":"2026-07-02T20:10:00Z"}}`, pendingKey))
				case "/api/caller/connect/abort":
					aborts++
					writeEnvelope(w, `{"caller_id":"caller_123","aborted_key_id":"key_pending","aborted_at":"2026-07-02T20:01:00Z"}`)
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
			if code != foundation.ExitConfig {
				t.Fatalf("exit code = %d, want config failure; stderr: %s", code, stderr)
			}
			if stdout != "" {
				t.Fatalf("stdout should be empty for failed connect")
			}
			var envelope struct {
				OK    bool                 `json:"ok"`
				Error *foundation.AppError `json:"error"`
			}
			stderrLines := strings.Split(strings.TrimSpace(stderr), "\n")
			if err := json.Unmarshal([]byte(stderrLines[len(stderrLines)-1]), &envelope); err != nil {
				t.Fatalf("decode error envelope: %v; stderr: %s", err, stderr)
			}
			if envelope.OK || envelope.Error == nil || envelope.Error.Code != foundation.CodeConfig {
				t.Fatalf("error envelope did not preserve the config failure: %#v", envelope)
			}
			if !strings.Contains(envelope.Error.Message, "Could not write local Agent Outbox config.") {
				t.Fatalf("stderr did not report the config save failure: %s", stderr)
			}
			if tc.retryErr != nil {
				if !strings.Contains(envelope.Error.Message, "Local credential rollback also failed (fake final credential delete failure).") {
					t.Fatalf("stderr did not report the final credential deletion failure: %s", stderr)
				}
				if store.keys["caller_123"] != pendingKey {
					t.Fatalf("failed deletion unexpectedly removed the pending key")
				}
			} else {
				if strings.Contains(envelope.Error.Message, "rollback also failed") || strings.Contains(envelope.Error.Message, "inconsistent") {
					t.Fatalf("successful credential cleanup was reported as failed: %s", stderr)
				}
				if len(store.keys) != 0 {
					t.Fatalf("successful cleanup left a pending key stored locally")
				}
			}
			if strings.Contains(stderr, "fake initial credential delete failure") {
				t.Fatalf("stderr reported the superseded initial deletion failure: %s", stderr)
			}
			if aborts != 1 {
				t.Fatalf("aborts = %d, want 1", aborts)
			}
			if deletes != 2 {
				t.Fatalf("deletes = %d, want the initial rollback and abort cleanup retry", deletes)
			}
			if strings.Contains(stdout+stderr, pendingKey) {
				t.Fatalf("command output leaked the caller key")
			}
		})
	}
}

func TestCallerConnectReportsCredentialRollbackFailureWhenActivateDefinitivelyDidNotCommit(t *testing.T) {
	const pendingKey = "aob_live_pending_connectsecret"
	store := &controlPlaneSecretStore{deleteErr: foundation.NewSecretStoreError("fake credential delete failure")}
	configPath := filepath.Join(t.TempDir(), "config.json")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/caller/connect/device/start":
			writeEnvelope(w, `{"device_code":"dev_connect","user_code":"CONNECT-1","verification_uri":"https://app.example/caller/connect/device","verification_uri_complete":"https://app.example/caller/connect/device?user_code=CONNECT-1","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/connect/device/poll":
			writeEnvelope(w, fmt.Sprintf(`{"setup_request_id":"setup_connect","caller":{"caller_id":"caller_123","caller_slug":"steward-email","display_name":"Steward Email"},"account":{"account_id":"acct_123","label":"Test","effective_tier":"free"},"credential":{"api_key":%q,"key_id":"key_pending","prefix":"aob_live","last_chars":"pend","created_at":"2026-07-02T20:00:00Z","expires_at":"2026-07-02T20:10:00Z"}}`, pendingKey))
		case "/api/caller/connect/activate":
			w.WriteHeader(definitiveActivateFailures[0].status)
			_, _ = io.WriteString(w, definitiveActivateFailures[0].body)
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
	if code != definitiveActivateFailures[0].wantExit {
		t.Fatalf("exit code = %d, want %d; stderr: %s", code, definitiveActivateFailures[0].wantExit, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for failed connect")
	}
	if !strings.Contains(stderr, "Activation request was invalid.") ||
		!strings.Contains(stderr, "Local credential rollback also failed (fake credential delete failure).") {
		t.Fatalf("stderr did not report both the activate and the credential rollback failure: %s", stderr)
	}
	if strings.Contains(stderr, "Local config rollback also failed") {
		t.Fatalf("successful config rollback was reported as failed: %s", stderr)
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

// definitiveActivateFailures are validated activate error responses that prove the hosted
// activation did not commit, so the CLI must roll back its local key and config.
var definitiveActivateFailures = []struct {
	name     string
	status   int
	body     string
	wantExit int
}{
	{
		name:     "validation failed",
		status:   http.StatusUnprocessableEntity,
		body:     `{"ok":false,"request_id":"req_bad_activate","correlation_id":"corr_bad_activate","error":{"code":"validation_failed","message":"Activation request was invalid."}}`,
		wantExit: foundation.ExitData,
	},
	{
		name:     "rate limited",
		status:   http.StatusTooManyRequests,
		body:     `{"ok":false,"request_id":"req_limited_activate","correlation_id":"corr_limited_activate","error":{"code":"rate_limit_exceeded","message":"Too many activation requests.","retry_after_seconds":30}}`,
		wantExit: foundation.ExitTemporary,
	},
}

func TestCallerConnectRollsBackLocalStateWhenActivateDefinitivelyDidNotCommit(t *testing.T) {
	for _, tc := range definitiveActivateFailures {
		t.Run(tc.name, func(t *testing.T) {
			assertCallerConnectRollsBackAfterActivateFailure(t, tc.status, tc.body, tc.wantExit)
		})
	}
}

func assertCallerConnectRollsBackAfterActivateFailure(t *testing.T, status int, body string, wantExit int) {
	t.Helper()
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
			w.WriteHeader(status)
			_, _ = io.WriteString(w, body)
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
	if code != wantExit {
		t.Fatalf("exit code = %d, want %d; stderr: %s", code, wantExit, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for failed connect")
	}
	if strings.Contains(stderr, "may already be active") {
		t.Fatalf("definitive activate failure warned that the credential may be active: %s", stderr)
	}
	if strings.Contains(stderr, "rollback also failed") {
		t.Fatalf("successful local rollback reported a rollback failure: %s", stderr)
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
	for _, tc := range definitiveActivateFailures {
		t.Run(tc.name, func(t *testing.T) {
			assertCallerRotateRestoresOldStateAfterActivateFailure(t, tc.status, tc.body, tc.wantExit)
		})
	}
}

func assertCallerRotateRestoresOldStateAfterActivateFailure(t *testing.T, status int, body string, wantExit int) {
	t.Helper()
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
			w.WriteHeader(status)
			_, _ = io.WriteString(w, body)
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
	if code != wantExit {
		t.Fatalf("exit code = %d, want %d; stderr: %s", code, wantExit, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for failed rotate")
	}
	if strings.Contains(stderr, "may already have committed") {
		t.Fatalf("definitive activate failure warned that activation may have committed: %s", stderr)
	}
	if strings.Contains(stderr, "rollback also failed") {
		t.Fatalf("successful local rollback reported a rollback failure: %s", stderr)
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

func TestCallerRotateReportsCredentialRollbackFailureWhenConfigSaveFails(t *testing.T) {
	const oldKey = "aob_live_oldkey_oldsecret"
	const newKey = "aob_live_newkey_newsecret"
	configPath := writeControlConfig(t, "http://placeholder.invalid")
	store := &controlPlaneSecretStore{keys: map[string]string{"caller_123": oldKey}, failStoreKey: oldKey}
	store.onStore = func(callerAPIKey string) {
		if callerAPIKey == newKey {
			blockConfigWrites(t, configPath)
		}
	}
	var aborts int

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
			writeEnvelope(w, `{"caller_id":"caller_123","aborted_key_id":"key_new","aborted_at":"2026-07-02T20:01:00Z"}`)
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
	if code != foundation.ExitConfig {
		t.Fatalf("exit code = %d, want config failure; stderr: %s", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for failed rotate")
	}
	if !strings.Contains(stderr, "Could not write local Agent Outbox config.") ||
		!strings.Contains(stderr, "Local credential rollback also failed (fake credential write failure).") {
		t.Fatalf("stderr did not report both the config save and the credential rollback failure: %s", stderr)
	}
	if aborts != 1 {
		t.Fatalf("aborts = %d, want 1", aborts)
	}
	if strings.Contains(stdout+stderr, newKey) {
		t.Fatalf("command output leaked the caller key")
	}
}

func TestCallerRotateReportsLocalRollbackFailuresWhenActivateDefinitivelyDidNotCommit(t *testing.T) {
	t.Run("credential rollback fails", func(t *testing.T) {
		assertCallerRotateReportsLocalRollbackFailures(t, true, false)
	})
	t.Run("config rollback fails", func(t *testing.T) {
		assertCallerRotateReportsLocalRollbackFailures(t, false, true)
	})
	t.Run("credential and config rollback fail", func(t *testing.T) {
		assertCallerRotateReportsLocalRollbackFailures(t, true, true)
	})
}

func assertCallerRotateReportsLocalRollbackFailures(t *testing.T, credentialRollbackFails bool, configRollbackFails bool) {
	t.Helper()
	const oldKey = "aob_live_oldkey_oldsecret"
	const newKey = "aob_live_newkey_newsecret"
	store := &controlPlaneSecretStore{keys: map[string]string{"caller_123": oldKey}}
	if credentialRollbackFails {
		store.failStoreKey = oldKey
	}
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
			if configRollbackFails {
				blockConfigWrites(t, configPath)
			}
			w.WriteHeader(definitiveActivateFailures[1].status)
			_, _ = io.WriteString(w, definitiveActivateFailures[1].body)
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
	if code != definitiveActivateFailures[1].wantExit {
		t.Fatalf("exit code = %d, want %d; stderr: %s", code, definitiveActivateFailures[1].wantExit, stderr)
	}
	if stdout != "" {
		t.Fatalf("stdout should be empty for failed rotate")
	}
	if !strings.Contains(stderr, "Too many activation requests.") {
		t.Fatalf("stderr did not report the activate failure: %s", stderr)
	}
	if got := strings.Contains(stderr, "Local credential rollback also failed (fake credential write failure)."); got != credentialRollbackFails {
		t.Fatalf("credential rollback failure reported = %v, want %v; stderr: %s", got, credentialRollbackFails, stderr)
	}
	if got := strings.Contains(stderr, "Local config rollback also failed (Could not write local Agent Outbox config.)."); got != configRollbackFails {
		t.Fatalf("config rollback failure reported = %v, want %v; stderr: %s", got, configRollbackFails, stderr)
	}
	if strings.Contains(stdout+stderr, newKey) {
		t.Fatalf("command output leaked the caller key")
	}
	if configRollbackFails {
		return
	}
	cfg, err := foundation.LoadConfig(configPath)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if cfg.Callers[0].KeyID != "key_old" {
		t.Fatalf("definitive activate failure did not restore old config: %#v", cfg.Callers[0])
	}
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

func TestCallerDeviceStartRejectsInvalidResponseBeforeInstructionsOrPoll(t *testing.T) {
	const valid = `{"device_code":"dev_123","verification_uri":"https://app.example/approve","verification_uri_complete":"https://app.example/approve?code=123","expires_at":"2026-07-02T20:10:00Z"}`
	for _, operation := range []string{"connect", "rotate", "revoke"} {
		for _, tt := range []struct{ name, from, to string }{
			{"missing device code", `"device_code":"dev_123"`, `"device_code":""`},
			{"blank device code", `"device_code":"dev_123"`, `"device_code":" "`},
			{"missing verification URIs", `"verification_uri":"https://app.example/approve","verification_uri_complete":"https://app.example/approve?code=123"`, `"verification_uri":"","verification_uri_complete":" "`},
			{"missing expiry", `"expires_at":"2026-07-02T20:10:00Z"`, `"expires_at":""`},
			{"invalid expiry", `"expires_at":"2026-07-02T20:10:00Z"`, `"expires_at":"invalid"`},
		} {
			t.Run(operation+"/"+tt.name, func(t *testing.T) {
				requests := 0
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					requests++
					if r.URL.Path != "/api/caller/"+operation+"/device/start" {
						t.Errorf("unexpected request: %s", r.URL.Path)
						w.WriteHeader(http.StatusInternalServerError)
						return
					}
					w.Header().Set("X-Correlation-ID", "corr_contract")
					writeEnvelope(w, strings.Replace(valid, tt.from, tt.to, 1))
				}))
				defer server.Close()
				args := []string{"--json", "caller", operation}
				configPath := writeControlConfig(t, server.URL)
				if operation == "connect" {
					configPath = filepath.Join(t.TempDir(), "config.json")
				}
				if operation != "rotate" {
					args = append(args, "steward-email")
				}
				stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
					configPath: configPath, baseURL: server.URL, store: &controlPlaneSecretStore{},
					args: append(args, "--device-code"),
				})
				assertAPIResponseInvalid(t, stdout, stderr, code)
				if requests != 1 || strings.Contains(stderr, "approval:") {
					t.Fatalf("invalid start printed instructions or continued: requests=%d stderr=%s", requests, stderr)
				}
			})
		}
	}
}

func TestCallerBrowserStartRejectsInvalidResponseBeforeOpeningBrowser(t *testing.T) {
	const valid = `{"approval_url":"https://app.example/approve","setup_request_id":"setup_123","expires_at":"2099-07-02T20:10:00Z"}`
	for _, operation := range []string{"connect", "rotate", "revoke"} {
		for _, tt := range []struct{ name, from, to string }{
			{"missing approval URL", `"approval_url":"https://app.example/approve"`, `"approval_url":""`},
			{"missing setup request id", `"setup_request_id":"setup_123"`, `"setup_request_id":" "`},
			{"missing expiry", `"expires_at":"2099-07-02T20:10:00Z"`, `"expires_at":""`},
			{"invalid expiry", `"expires_at":"2099-07-02T20:10:00Z"`, `"expires_at":"invalid"`},
		} {
			t.Run(operation+"/"+tt.name, func(t *testing.T) {
				requests, opens := 0, 0
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					requests++
					if r.URL.Path != "/api/caller/"+operation+"/browser/start" {
						t.Errorf("unexpected request: %s", r.URL.Path)
						w.WriteHeader(http.StatusInternalServerError)
						return
					}
					w.Header().Set("X-Correlation-ID", "corr_contract")
					writeEnvelope(w, strings.Replace(valid, tt.from, tt.to, 1))
				}))
				defer server.Close()
				args := []string{"--json", "caller", operation}
				configPath := writeControlConfig(t, server.URL)
				if operation == "connect" {
					configPath = filepath.Join(t.TempDir(), "config.json")
				}
				if operation != "rotate" {
					args = append(args, "steward-email")
				}
				stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
					configPath: configPath, baseURL: server.URL, store: &controlPlaneSecretStore{},
					args:        append(args, "--browser"),
					openBrowser: func(string) error { opens++; return nil },
				})
				assertAPIResponseInvalid(t, stdout, stderr, code)
				if requests != 1 || opens != 0 {
					t.Fatalf("invalid browser start continued: requests=%d opens=%d", requests, opens)
				}
			})
		}
	}
}

func TestCallerDevicePollRequiresSetupCodeAndRequestID(t *testing.T) {
	for _, operation := range []string{"rotate", "revoke"} {
		for _, data := range []string{`{"setup_request_id":"setup_123"}`, `{"setup_code":"setup_code_123","setup_request_id":" "}`} {
			t.Run(operation+"/"+data, func(t *testing.T) {
				requests := 0
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					requests++
					switch r.URL.Path {
					case "/api/caller/" + operation + "/device/start":
						writeEnvelope(w, `{"device_code":"dev_123","verification_uri":"https://app.example/approve","expires_at":"2026-07-02T20:10:00Z"}`)
					case "/api/caller/" + operation + "/device/poll":
						w.Header().Set("X-Correlation-ID", "corr_contract")
						writeEnvelope(w, data)
					default:
						t.Errorf("unexpected request: %s", r.URL.Path)
						w.WriteHeader(http.StatusInternalServerError)
					}
				}))
				defer server.Close()
				configPath := writeControlConfig(t, server.URL)
				args := []string{"--json", "caller", operation}
				if operation == "revoke" {
					args = append(args, "steward-email")
				}
				stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
					configPath: configPath, baseURL: server.URL, store: &controlPlaneSecretStore{},
					args: append(args, "--device-code"),
				})
				assertAPIResponseInvalid(t, stdout, stderr, code)
				if requests != 2 {
					t.Fatalf("requests = %d, want start and poll only", requests)
				}
			})
		}
	}
}

func TestCallerConnectRejectsInvalidExchangeBeforeLocalPersistence(t *testing.T) {
	const pendingKey = "aob_live_pending_contract_secret"
	const valid = `{"setup_request_id":"setup_123","caller":{"caller_id":"caller_123"},"account":{"account_id":"acct_123"},"credential":{"api_key":"aob_live_pending_contract_secret","key_id":"key_pending","prefix":"aob_live","last_chars":"pend"}}`
	for _, flow := range []string{"device", "browser"} {
		for _, tt := range []struct {
			name, from, to string
			wantAborts     int
		}{
			{"missing api key", `"api_key":"aob_live_pending_contract_secret"`, `"api_key":""`, 0},
			{"missing setup request id", `"setup_request_id":"setup_123"`, `"setup_request_id":""`, 0},
			{"missing caller id", `"caller_id":"caller_123"`, `"caller_id":""`, 1},
			{"missing account id", `"account_id":"acct_123"`, `"account_id":" "`, 1},
			{"missing key id", `"key_id":"key_pending"`, `"key_id":""`, 1},
			{"missing prefix", `"prefix":"aob_live"`, `"prefix":""`, 1},
			{"missing suffix", `"last_chars":"pend"`, `"last_chars":" "`, 1},
		} {
			t.Run(flow+"/"+tt.name, func(t *testing.T) {
				aborts, activates, stores, deletes := 0, 0, 0, 0
				store := &controlPlaneSecretStore{
					onStore: func(string) { stores++ }, onDelete: func(string) { deletes++ },
				}
				callbackURL := ""
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					switch r.URL.Path {
					case "/api/caller/connect/device/start":
						writeEnvelope(w, `{"device_code":"dev_123","verification_uri_complete":"https://app.example/approve?code=123","expires_at":"2026-07-02T20:10:00Z"}`)
					case "/api/caller/connect/browser/start":
						var body map[string]string
						decodeJSONBody(t, r, &body)
						callbackURL = body["callback_url"]
						writeEnvelope(w, `{"approval_url":"https://app.example/approve","setup_request_id":"setup_123","expires_at":"2099-07-02T20:10:00Z"}`)
					case "/api/caller/connect/device/poll", "/api/caller/connect/exchange":
						w.Header().Set("X-Correlation-ID", "corr_contract")
						writeEnvelope(w, strings.Replace(valid, tt.from, tt.to, 1))
					case "/api/caller/connect/abort":
						aborts++
						if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+pendingKey {
							t.Errorf("abort must POST with the pending key bearer")
						}
						var body map[string]string
						decodeJSONBody(t, r, &body)
						if body["setup_request_id"] != "setup_123" {
							t.Errorf("abort setup request id = %q", body["setup_request_id"])
						}
						// A failed abort must preserve the original invalid-response error and metadata.
						w.WriteHeader(http.StatusServiceUnavailable)
					case "/api/caller/connect/activate":
						activates++
						w.WriteHeader(http.StatusInternalServerError)
					default:
						t.Errorf("unexpected request: %s", r.URL.Path)
						w.WriteHeader(http.StatusInternalServerError)
					}
				}))
				defer server.Close()
				configPath := filepath.Join(t.TempDir(), "config.json")
				flowFlag := "--device-code"
				if flow == "browser" {
					flowFlag = "--browser"
				}
				stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
					configPath: configPath, baseURL: server.URL, store: store,
					args: []string{"--json", "caller", "connect", "steward-email", flowFlag},
					openBrowser: func(string) error {
						resp, err := http.Get(callbackURL + "?status=approved&setup_request_id=setup_123&setup_code=setup_code_123")
						if err == nil {
							_ = resp.Body.Close()
						}
						return err
					},
				})
				assertAPIResponseInvalid(t, stdout, stderr, code)
				if aborts != tt.wantAborts || activates != 0 || stores != 0 || deletes != 0 || len(store.keys) != 0 {
					t.Fatalf("aborts=%d activates=%d stores=%d deletes=%d keys=%d", aborts, activates, stores, deletes, len(store.keys))
				}
				cfg, err := foundation.LoadConfig(configPath)
				if err != nil || len(cfg.Callers) != 0 {
					t.Fatalf("invalid response changed config: callers=%#v err=%v", cfg.Callers, err)
				}
				if strings.Contains(stdout+stderr, pendingKey) {
					t.Fatal("command output leaked the pending key")
				}
			})
		}
	}
}

func TestCallerRotateRejectsInvalidExchangeAndPreservesLocalState(t *testing.T) {
	const replacementKey = "aob_live_replacement_contract_secret"
	const oldKey = "aob_live_old_contract_secret"
	const valid = `{"caller":{"caller_id":"caller_123"},"account":{"account_id":"acct_123"},"replacement_credential":{"api_key":"aob_live_replacement_contract_secret","key_id":"key_new","prefix":"aob_live","last_chars":"newx"}}`
	for _, tt := range []struct {
		name, from, to string
		wantAborts     int
	}{
		{"missing api key", `"api_key":"aob_live_replacement_contract_secret"`, `"api_key":""`, 0},
		{"mismatched caller id", `"caller_id":"caller_123"`, `"caller_id":"caller_other"`, 1},
		{"missing caller id", `"caller_id":"caller_123"`, `"caller_id":""`, 1},
		{"missing account id", `"account_id":"acct_123"`, `"account_id":""`, 1},
		{"mismatched account id", `"account_id":"acct_123"`, `"account_id":"acct_other"`, 1},
		{"missing key id", `"key_id":"key_new"`, `"key_id":" "`, 1},
		{"missing prefix", `"prefix":"aob_live"`, `"prefix":""`, 1},
		{"missing suffix", `"last_chars":"newx"`, `"last_chars":""`, 1},
	} {
		t.Run(tt.name, func(t *testing.T) {
			aborts, activates, stores, deletes := 0, 0, 0, 0
			store := &controlPlaneSecretStore{
				keys:    map[string]string{"caller_123": oldKey},
				onStore: func(string) { stores++ }, onDelete: func(string) { deletes++ },
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/caller/rotate/device/start":
					writeEnvelope(w, `{"device_code":"dev_123","verification_uri":"https://app.example/approve","expires_at":"2026-07-02T20:10:00Z"}`)
				case "/api/caller/rotate/device/poll":
					writeEnvelope(w, `{"setup_request_id":"setup_123","setup_code":"setup_code_123"}`)
				case "/api/caller/rotate/exchange":
					w.Header().Set("X-Correlation-ID", "corr_contract")
					writeEnvelope(w, strings.Replace(valid, tt.from, tt.to, 1))
				case "/api/caller/rotate/abort":
					aborts++
					if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+replacementKey {
						t.Errorf("abort must POST with the replacement key bearer")
					}
					var body map[string]string
					decodeJSONBody(t, r, &body)
					if body["setup_request_id"] != "setup_123" {
						t.Errorf("abort setup request id = %q", body["setup_request_id"])
					}
					w.WriteHeader(http.StatusServiceUnavailable)
				case "/api/caller/rotate/activate":
					activates++
					w.WriteHeader(http.StatusInternalServerError)
				default:
					t.Errorf("unexpected request: %s", r.URL.Path)
					w.WriteHeader(http.StatusInternalServerError)
				}
			}))
			defer server.Close()
			configPath := writeControlConfig(t, server.URL)
			before, err := os.ReadFile(configPath)
			if err != nil {
				t.Fatal(err)
			}
			stdout, stderr, code := executeControlCommand(t, controlCommandOptions{
				configPath: configPath, baseURL: server.URL, store: store,
				args: []string{"--json", "caller", "rotate", "--device-code"},
			})
			assertAPIResponseInvalid(t, stdout, stderr, code)
			if aborts != tt.wantAborts || activates != 0 || stores != 0 || deletes != 0 || len(store.keys) != 1 || store.keys["caller_123"] != oldKey {
				t.Fatalf("invalid rotation changed local state: aborts=%d activates=%d stores=%d deletes=%d", aborts, activates, stores, deletes)
			}
			after, err := os.ReadFile(configPath)
			if err != nil || !bytes.Equal(before, after) {
				t.Fatalf("invalid rotation changed config: err=%v", err)
			}
			cfg, err := foundation.LoadConfig(configPath)
			if err != nil || len(cfg.Callers) != 1 || cfg.Callers[0].KeyID != "key_old" || cfg.Callers[0].KeySuffix != "oldx" {
				t.Fatalf("invalid rotation changed caller record: callers=%#v err=%v", cfg.Callers, err)
			}
			assertNoSecretLeak(t, replacementKey, stdout, stderr, configPath)
		})
	}
}

func assertAPIResponseInvalid(t *testing.T, stdout, stderr string, code int) {
	t.Helper()
	if code != foundation.ExitTemporary || stdout != "" {
		t.Fatalf("exit=%d, want 75 with empty stdout; stdout=%s stderr=%s", code, stdout, stderr)
	}
	for _, fragment := range []string{`"code":"api_response_invalid"`, `"http_status":200`, `"request_id":"req_server"`, `"correlation_id":"corr_contract"`} {
		if !strings.Contains(stderr, fragment) {
			t.Fatalf("stderr missing %s: %s", fragment, stderr)
		}
	}
}

type controlCommandOptions struct {
	configPath  string
	baseURL     string
	env         foundation.Env
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
		Env:          opts.env,
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

// mockConnectOriginClient supplies local HTTP responses without network or DNS access.
func mockConnectOriginClient(t *testing.T, origin, pendingKey string, observe func(*http.Request)) *http.Client {
	t.Helper()
	allowed, err := url.Parse(origin)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Scheme != allowed.Scheme || r.URL.Host != allowed.Host || r.Method != http.MethodPost {
			t.Fatalf("unexpected connect request: %s %s", r.Method, r.URL)
		}
		wantAuth := ""
		if r.URL.Path == "/api/caller/connect/activate" || r.URL.Path == "/api/caller/connect/abort" {
			wantAuth = "Bearer " + pendingKey
			var body map[string]string
			decodeJSONBody(t, r, &body)
			if body["setup_request_id"] != "setup_origin" {
				t.Fatalf("connect confirmation body = %#v", body)
			}
		}
		if got := r.Header.Get("Authorization"); got != wantAuth {
			t.Fatalf("connect authorization = %q, want %q", got, wantAuth)
		}
		observe(r)
		w := httptest.NewRecorder()
		switch r.URL.Path {
		case "/api/caller/connect/device/start":
			writeEnvelope(w, `{"device_code":"dev_origin","user_code":"CONNECT-1","verification_uri":"https://app.example/caller/connect/device","verification_uri_complete":"https://app.example/caller/connect/device?user_code=CONNECT-1","expires_at":"2026-07-02T20:10:00Z","poll_interval_seconds":5}`)
		case "/api/caller/connect/device/poll":
			writeEnvelope(w, fmt.Sprintf(`{"setup_request_id":"setup_origin","caller":{"caller_id":"caller_456","caller_slug":"second-caller","display_name":"Second Caller"},"account":{"account_id":"acct_123","label":"Test","effective_tier":"free"},"credential":{"api_key":%q,"key_id":"key_origin","prefix":"aob_live","last_chars":"cret","created_at":"2026-07-02T20:00:00Z","expires_at":"2026-07-02T20:10:00Z"}}`, pendingKey))
		case "/api/caller/connect/activate":
			writeEnvelope(w, `{"caller_id":"caller_456","activated_key_id":"key_origin","activated_at":"2026-07-02T20:01:00Z"}`)
		case "/api/caller/connect/abort":
			writeEnvelope(w, `{"caller_id":"caller_456","aborted_key_id":"key_origin","aborted_at":"2026-07-02T20:01:00Z"}`)
		default:
			t.Fatalf("unexpected connect route: %s", r.URL.Path)
		}
		return w.Result(), nil
	})}
}

func assertConnectOriginState(t *testing.T, configPath, baseURL string, existing []foundation.CallerConfig, store *controlPlaneSecretStore, pendingKey string) {
	t.Helper()
	cfg, err := foundation.LoadConfig(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BaseURL != baseURL || len(cfg.Callers) != len(existing)+1 {
		t.Fatalf("connect config = %#v, want URL %q and %d callers", cfg, baseURL, len(existing)+1)
	}
	for i, caller := range existing {
		if cfg.Callers[i] != caller || store.keys[caller.CallerID] != "existing-secret" {
			t.Fatalf("existing caller or credential changed: %#v keys=%#v", cfg.Callers, store.keys)
		}
	}
	added := cfg.Callers[len(existing)]
	if added.Name != "second-caller" || added.CallerID != "caller_456" || added.KeyID != "key_origin" || store.keys["caller_456"] != pendingKey || len(store.keys) != len(cfg.Callers) {
		t.Fatalf("new caller/config not persisted before activation: %#v keys=%#v", cfg.Callers, store.keys)
	}
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

// blockConfigWrites replaces the config file with a non-empty directory so the next atomic config
// rename fails while earlier config reads and the local state lock keep working.
func blockConfigWrites(t *testing.T, configPath string) {
	t.Helper()
	if err := os.RemoveAll(configPath); err != nil {
		t.Fatalf("remove config: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(configPath, "blocker"), 0o700); err != nil {
		t.Fatalf("block config writes: %v", err)
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
