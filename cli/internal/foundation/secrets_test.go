package foundation

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testCallerAPIKey = "aob_live_testkey_secret_fixture"

func TestFileCallerSecretStorePersistsOwnerOnlyCredentials(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-outbox", "credentials.json")
	store, err := NewFileCallerSecretStore(path, true)
	if err != nil {
		t.Fatalf("NewFileCallerSecretStore failed: %v", err)
	}
	if err := store.StoreCallerKey("caller_123", testCallerAPIKey); err != nil {
		t.Fatalf("StoreCallerKey failed: %v", err)
	}

	loaded, err := store.LoadCallerKey("caller_123")
	if err != nil {
		t.Fatalf("LoadCallerKey failed: %v", err)
	}
	if loaded != testCallerAPIKey {
		t.Fatalf("loaded caller credential differs from stored value")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading credentials: %v", err)
	}
	for _, want := range []string{`"version": 1`, `"caller_123"`, `"api_key"`, testCallerAPIKey} {
		if !strings.Contains(string(data), want) {
			t.Fatalf("credentials file missing %q: %s", want, data)
		}
	}

	stat, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat credentials: %v", err)
	}
	if got := stat.Mode().Perm(); got != 0o600 {
		t.Fatalf("credentials mode = %#o, want 0600", got)
	}
	dirStat, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatalf("stat credentials directory: %v", err)
	}
	if got := dirStat.Mode().Perm(); got != 0o700 {
		t.Fatalf("credentials directory mode = %#o, want 0700", got)
	}
}

func TestFileCallerSecretStoreDoesNotChmodExplicitParent(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "explicit-config")
	if err := os.Mkdir(parent, 0o755); err != nil {
		t.Fatalf("mkdir explicit parent: %v", err)
	}
	if err := os.Chmod(parent, 0o755); err != nil {
		t.Fatalf("chmod explicit parent: %v", err)
	}
	store, err := NewFileCallerSecretStore(filepath.Join(parent, "credentials.json"), false)
	if err != nil {
		t.Fatalf("NewFileCallerSecretStore failed: %v", err)
	}
	if err := store.StoreCallerKey("caller_123", testCallerAPIKey); err != nil {
		t.Fatalf("StoreCallerKey failed: %v", err)
	}
	stat, err := os.Stat(parent)
	if err != nil {
		t.Fatalf("stat explicit parent: %v", err)
	}
	if got := stat.Mode().Perm(); got != 0o755 {
		t.Fatalf("explicit parent mode = %#o, want unchanged 0755", got)
	}
}

func TestFileCallerSecretStoreReadDoesNotCreateMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-outbox", "credentials.json")
	store, err := NewFileCallerSecretStore(path, true)
	if err != nil {
		t.Fatalf("NewFileCallerSecretStore failed: %v", err)
	}

	_, err = store.LoadCallerKey("caller_123")
	if !errors.Is(err, ErrSecretNotFound) {
		t.Fatalf("LoadCallerKey error = %v, want ErrSecretNotFound", err)
	}
	if _, statErr := os.Stat(path); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("read path created credentials file: %v", statErr)
	}
}

func TestFileCallerSecretStoreRejectsInsecureFilePermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	data := []byte("{\"version\":1,\"callers\":{}}\n")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write credentials fixture: %v", err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatalf("chmod credentials fixture: %v", err)
	}
	store, err := NewFileCallerSecretStore(path, false)
	if err != nil {
		t.Fatalf("NewFileCallerSecretStore failed: %v", err)
	}

	_, err = store.LoadCallerKey("caller_123")
	if err == nil || !strings.Contains(err.Error(), "chmod 600") {
		t.Fatalf("insecure permissions error = %v", err)
	}
}

func TestFileCallerSecretStoreRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target.json")
	path := filepath.Join(root, "credentials.json")
	if err := os.WriteFile(target, []byte("{\"version\":1,\"callers\":{}}\n"), 0o600); err != nil {
		t.Fatalf("write credentials target: %v", err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatalf("symlink credentials fixture: %v", err)
	}
	store, err := NewFileCallerSecretStore(path, false)
	if err != nil {
		t.Fatalf("NewFileCallerSecretStore failed: %v", err)
	}

	_, err = store.LoadCallerKey("caller_123")
	if err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("symlink error = %v", err)
	}
}

func TestFileCallerSecretStoreMutationsUseLocalStateLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-outbox", "credentials.json")
	store, err := NewFileCallerSecretStore(path, true)
	if err != nil {
		t.Fatalf("NewFileCallerSecretStore failed: %v", err)
	}
	held, err := AcquireLocalStateLock(path)
	if err != nil {
		t.Fatalf("AcquireLocalStateLock failed: %v", err)
	}

	storeReady := make(chan error, 1)
	go func() {
		storeReady <- store.StoreCallerKey("caller_123", testCallerAPIKey)
	}()
	select {
	case err := <-storeReady:
		t.Fatalf("StoreCallerKey returned while lock held: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := held.Close(); err != nil {
		t.Fatalf("closing held lock: %v", err)
	}
	select {
	case err := <-storeReady:
		if err != nil {
			t.Fatalf("StoreCallerKey failed after lock release: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatalf("StoreCallerKey did not finish after lock release")
	}
}

func TestFileCallerSecretStoreDeleteAndHeldLockOperations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	store, err := NewFileCallerSecretStore(path, false)
	if err != nil {
		t.Fatalf("NewFileCallerSecretStore failed: %v", err)
	}
	if err := store.StoreCallerKeyWithHeldLocalStateLock("caller_123", testCallerAPIKey); err != nil {
		t.Fatalf("StoreCallerKeyWithHeldLocalStateLock failed: %v", err)
	}
	if err := store.DeleteCallerKeyWithHeldLocalStateLock("caller_123"); err != nil {
		t.Fatalf("DeleteCallerKeyWithHeldLocalStateLock failed: %v", err)
	}
	if _, err := store.LoadCallerKey("caller_123"); !errors.Is(err, ErrSecretNotFound) {
		t.Fatalf("deleted caller load error = %v, want ErrSecretNotFound", err)
	}
}

func TestFileCallerSecretStoreErrorsUseDistinctCodeAndExit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	store, err := NewFileCallerSecretStore(path, false)
	if err != nil {
		t.Fatalf("NewFileCallerSecretStore failed: %v", err)
	}
	_, err = store.LoadCallerKey("caller_123")
	var appErr *AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("missing credential error is not AppError: %v", err)
	}
	if appErr.Code != CodeSecretStore || ExitCodeFor(err) != ExitSecretStore {
		t.Fatalf("missing credential code/exit = %q/%d", appErr.Code, ExitCodeFor(err))
	}
}
