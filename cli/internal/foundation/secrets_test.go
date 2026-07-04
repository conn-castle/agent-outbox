package foundation

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeOSKeyring struct {
	values map[string]string
	err    error
	sets   int
	onGet  func()
}

func (f *fakeOSKeyring) Get(service string, account string) (string, error) {
	if f.onGet != nil {
		f.onGet()
	}
	if f.err != nil {
		return "", f.err
	}
	if f.values == nil {
		f.values = map[string]string{}
	}
	value, ok := f.values[service+"\x00"+account]
	if !ok {
		return "", ErrSecretNotFound
	}
	return value, nil
}

func (f *fakeOSKeyring) Set(service string, account string, value string) error {
	if f.err != nil {
		return f.err
	}
	f.sets++
	if f.values == nil {
		f.values = map[string]string{}
	}
	f.values[service+"\x00"+account] = value
	return nil
}

func TestLoadOrCreateMasterKeyUsesFakeCredentialStore(t *testing.T) {
	store := &fakeOSKeyring{}
	random := bytes.NewReader(bytes.Repeat([]byte{7}, masterKeyBytes))

	key, err := LoadOrCreateMasterKey(store, random)
	if err != nil {
		t.Fatalf("LoadOrCreateMasterKey create failed: %v", err)
	}
	if len(key) != masterKeyBytes {
		t.Fatalf("master key length = %d, want %d", len(key), masterKeyBytes)
	}

	loaded, err := LoadOrCreateMasterKey(store, nil)
	if err != nil {
		t.Fatalf("LoadOrCreateMasterKey load failed: %v", err)
	}
	if !bytes.Equal(loaded, key) {
		t.Fatalf("loaded master key differs from stored key")
	}
}

func TestLoadMasterKeyDoesNotCreateMissingKey(t *testing.T) {
	store := &fakeOSKeyring{}

	_, err := LoadMasterKey(store)
	if !errors.Is(err, ErrSecretNotFound) {
		t.Fatalf("LoadMasterKey missing key error = %v, want ErrSecretNotFound", err)
	}
	if store.sets != 0 {
		t.Fatalf("LoadMasterKey created keyring state with %d Set calls", store.sets)
	}
	if len(store.values) != 0 {
		t.Fatalf("LoadMasterKey wrote keyring values: %#v", store.values)
	}
}

func TestEncryptedCallerSecretStoreFromOSKeyringUsesLocalStateLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-outbox", "secrets.v1.enc")
	held, err := AcquireLocalStateLock(path)
	if err != nil {
		t.Fatalf("AcquireLocalStateLock failed: %v", err)
	}

	getStarted := make(chan struct{})
	storeReady := make(chan error, 1)
	store := &fakeOSKeyring{onGet: func() {
		select {
		case <-getStarted:
		default:
			close(getStarted)
		}
	}}
	go func() {
		_, err := NewEncryptedCallerSecretStoreFromOSKeyring(path, store, bytes.NewReader(bytes.Repeat([]byte{7}, masterKeyBytes)))
		storeReady <- err
	}()

	select {
	case <-getStarted:
		t.Fatalf("OS keyring was read while local-state lock was held")
	case err := <-storeReady:
		t.Fatalf("secret store returned while local-state lock was held: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	if err := held.Close(); err != nil {
		t.Fatalf("closing held lock: %v", err)
	}

	select {
	case err := <-storeReady:
		if err != nil {
			t.Fatalf("NewEncryptedCallerSecretStoreFromOSKeyring failed after lock release: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatalf("secret store did not finish after local-state lock release")
	}
	if store.sets != 1 {
		t.Fatalf("keyring Set calls = %d, want 1", store.sets)
	}
}

func TestEncryptedCallerSecretStoreKeepsPlaintextOutOfFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "agent-outbox", "secrets.v1.enc")
	masterKey := bytes.Repeat([]byte{3}, masterKeyBytes)
	store, err := NewEncryptedCallerSecretStore(path, masterKey)
	if err != nil {
		t.Fatalf("NewEncryptedCallerSecretStore failed: %v", err)
	}
	store.Random = bytes.NewReader(bytes.Repeat([]byte{9}, 128))

	callerID := "caller_123"
	callerKey := "aob_live_secret_fixture"
	if err := store.StoreCallerKey(callerID, callerKey); err != nil {
		t.Fatalf("StoreCallerKey failed: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading encrypted store: %v", err)
	}
	if strings.Contains(string(data), callerKey) || strings.Contains(string(data), callerID) {
		t.Fatalf("encrypted store contains plaintext caller material")
	}

	stat, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat encrypted store: %v", err)
	}
	if got := stat.Mode().Perm(); got != 0o600 {
		t.Fatalf("encrypted store mode = %#o, want 0600", got)
	}

	dirStat, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatalf("stat encrypted store dir: %v", err)
	}
	if got := dirStat.Mode().Perm(); got != 0o700 {
		t.Fatalf("encrypted store dir mode = %#o, want 0700", got)
	}

	loaded, err := store.LoadCallerKey(callerID)
	if err != nil {
		t.Fatalf("LoadCallerKey failed: %v", err)
	}
	if loaded != callerKey {
		t.Fatalf("loaded caller key did not round-trip")
	}

	if err := store.DeleteCallerKey(callerID); err != nil {
		t.Fatalf("DeleteCallerKey failed: %v", err)
	}
	if _, err := store.LoadCallerKey(callerID); !errors.Is(err, ErrSecretNotFound) {
		t.Fatalf("missing caller key error = %v", err)
	}
}

func TestEncryptedCallerSecretStoreMutationsUseLocalStateLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-outbox", "secrets.v1.enc")
	lock, err := AcquireLocalStateLock(path)
	if err != nil {
		t.Fatalf("AcquireLocalStateLock failed: %v", err)
	}

	store, err := NewEncryptedCallerSecretStore(path, bytes.Repeat([]byte{3}, masterKeyBytes))
	if err != nil {
		t.Fatalf("NewEncryptedCallerSecretStore failed: %v", err)
	}
	store.Random = bytes.NewReader(bytes.Repeat([]byte{9}, 128))

	done := make(chan error, 1)
	go func() {
		done <- store.StoreCallerKey("caller_123", "aob_live_secret_fixture")
	}()

	select {
	case err := <-done:
		t.Fatalf("StoreCallerKey completed while local-state lock was held: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	if err := lock.Close(); err != nil {
		t.Fatalf("closing lock: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("StoreCallerKey failed after lock release: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatalf("StoreCallerKey did not complete after lock release")
	}

	loaded, err := store.LoadCallerKey("caller_123")
	if err != nil {
		t.Fatalf("LoadCallerKey failed: %v", err)
	}
	if loaded != "aob_live_secret_fixture" {
		t.Fatalf("loaded caller key = %q, want stored fixture", loaded)
	}
}

func TestSecretStoreErrorsUseDistinctCodeAndExit(t *testing.T) {
	store := &fakeOSKeyring{err: errors.New("keyring unavailable")}

	_, err := LoadOrCreateMasterKey(store, nil)
	appErr, ok := err.(*AppError)
	if !ok {
		t.Fatalf("error type = %T, want *AppError", err)
	}
	if appErr.Code != CodeSecretStore {
		t.Fatalf("error code = %q, want %q", appErr.Code, CodeSecretStore)
	}
	if got := ExitCodeFor(err); got != ExitSecretStore {
		t.Fatalf("exit code = %d, want %d", got, ExitSecretStore)
	}

	secretStore, err := NewEncryptedCallerSecretStore(
		filepath.Join(t.TempDir(), "secrets.v1.enc"),
		bytes.Repeat([]byte{3}, masterKeyBytes),
	)
	if err != nil {
		t.Fatalf("NewEncryptedCallerSecretStore failed: %v", err)
	}
	_, err = secretStore.LoadCallerKey("missing-caller")
	if !errors.Is(err, ErrSecretNotFound) {
		t.Fatalf("missing caller key does not preserve sentinel: %v", err)
	}
	appErr, ok = err.(*AppError)
	if !ok {
		t.Fatalf("missing caller key error type = %T, want *AppError", err)
	}
	if appErr.Code != CodeSecretStore {
		t.Fatalf("missing caller key code = %q, want %q", appErr.Code, CodeSecretStore)
	}
	if got := ExitCodeFor(err); got != ExitSecretStore {
		t.Fatalf("missing caller key exit code = %d, want %d", got, ExitSecretStore)
	}
}
