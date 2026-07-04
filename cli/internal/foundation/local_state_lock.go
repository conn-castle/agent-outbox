package foundation

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

const localStateLockFileName = ".agent-outbox.lock"

var localStateLockGuards sync.Map

type LocalStateLock struct {
	locks []*localStateFileLock
}

type localStateFileLock struct {
	path  string
	file  *os.File
	guard *sync.Mutex
}

func AcquireLocalStateLock(paths ...string) (*LocalStateLock, error) {
	lockPaths, err := localStateLockPaths(paths...)
	if err != nil {
		return nil, err
	}

	acquired := make([]*localStateFileLock, 0, len(lockPaths))
	for _, lockPath := range lockPaths {
		lock, err := acquireLocalStateFileLock(lockPath)
		if err != nil {
			releaseLocalStateFileLocks(acquired)
			return nil, err
		}
		acquired = append(acquired, lock)
	}
	return &LocalStateLock{locks: acquired}, nil
}

func (l *LocalStateLock) Close() error {
	if l == nil {
		return nil
	}
	return releaseLocalStateFileLocks(l.locks)
}

func localStateLockPaths(paths ...string) ([]string, error) {
	if len(paths) == 0 {
		return nil, errors.New("local state path is required")
	}

	seen := map[string]struct{}{}
	for _, path := range paths {
		cleaned := filepath.Clean(strings.TrimSpace(path))
		if cleaned == "" || cleaned == "." {
			return nil, errors.New("local state path is required")
		}
		lockPath := filepath.Join(filepath.Dir(cleaned), localStateLockFileName)
		seen[lockPath] = struct{}{}
	}

	lockPaths := make([]string, 0, len(seen))
	for lockPath := range seen {
		lockPaths = append(lockPaths, lockPath)
	}
	sort.Strings(lockPaths)
	return lockPaths, nil
}

func acquireLocalStateFileLock(lockPath string) (*localStateFileLock, error) {
	guard := localStateGuard(lockPath)
	guard.Lock()

	releaseGuard := true
	defer func() {
		if releaseGuard {
			guard.Unlock()
		}
	}()

	dir := filepath.Dir(lockPath)
	if err := ensureOwnerOnlyDir(dir, false); err != nil {
		return nil, fmt.Errorf("creating local state lock directory %s: %w", dir, err)
	}

	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	closeFile := true
	defer func() {
		if closeFile {
			_ = file.Close()
		}
	}()

	if err := file.Chmod(0o600); err != nil {
		return nil, err
	}
	if err := lockLocalStateFile(file); err != nil {
		return nil, err
	}

	closeFile = false
	releaseGuard = false
	return &localStateFileLock{path: lockPath, file: file, guard: guard}, nil
}

func releaseLocalStateFileLocks(locks []*localStateFileLock) error {
	var result error
	for i := len(locks) - 1; i >= 0; i-- {
		lock := locks[i]
		if lock == nil {
			continue
		}
		if lock.file != nil {
			if err := unlockLocalStateFile(lock.file); err != nil {
				result = errors.Join(result, fmt.Errorf("unlocking local state lock %s: %w", lock.path, err))
			}
			if err := lock.file.Close(); err != nil {
				result = errors.Join(result, fmt.Errorf("closing local state lock %s: %w", lock.path, err))
			}
		}
		if lock.guard != nil {
			lock.guard.Unlock()
		}
	}
	return result
}

func localStateGuard(lockPath string) *sync.Mutex {
	value, _ := localStateLockGuards.LoadOrStore(lockPath, &sync.Mutex{})
	return value.(*sync.Mutex)
}
