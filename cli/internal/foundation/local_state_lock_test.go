package foundation

import (
	"path/filepath"
	"testing"
	"time"
)

func TestLocalStateLockSerializesSameProcessCriticalSection(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "config.json")

	first, err := AcquireLocalStateLock(statePath)
	if err != nil {
		t.Fatalf("AcquireLocalStateLock first failed: %v", err)
	}

	acquired := make(chan struct{})
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		close(started)
		second, err := AcquireLocalStateLock(statePath)
		if err != nil {
			done <- err
			return
		}
		close(acquired)
		done <- second.Close()
	}()

	<-started
	select {
	case <-acquired:
		t.Fatalf("second lock acquired while first lock was held")
	case <-time.After(50 * time.Millisecond):
	}

	if err := first.Close(); err != nil {
		t.Fatalf("closing first lock: %v", err)
	}

	select {
	case <-acquired:
	case <-time.After(time.Second):
		t.Fatalf("second lock did not acquire after first lock closed")
	}
	if err := <-done; err != nil {
		t.Fatalf("second lock failed: %v", err)
	}
}

func TestLocalStateLockDeduplicatesSharedStateDirectory(t *testing.T) {
	dir := t.TempDir()
	lock, err := AcquireLocalStateLock(
		filepath.Join(dir, "config.json"),
		filepath.Join(dir, "secrets.v1.enc"),
	)
	if err != nil {
		t.Fatalf("AcquireLocalStateLock failed: %v", err)
	}
	defer func() {
		if err := lock.Close(); err != nil {
			t.Fatalf("closing lock: %v", err)
		}
	}()

	if len(lock.locks) != 1 {
		t.Fatalf("lock count = %d, want 1 for shared directory", len(lock.locks))
	}
}
