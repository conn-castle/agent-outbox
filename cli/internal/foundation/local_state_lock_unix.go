//go:build !windows

package foundation

import (
	"os"

	"golang.org/x/sys/unix"
)

func lockLocalStateFile(file *os.File) error {
	for {
		err := unix.Flock(int(file.Fd()), unix.LOCK_EX)
		if err == unix.EINTR {
			continue
		}
		return err
	}
}

func unlockLocalStateFile(file *os.File) error {
	for {
		err := unix.Flock(int(file.Fd()), unix.LOCK_UN)
		if err == unix.EINTR {
			continue
		}
		return err
	}
}
