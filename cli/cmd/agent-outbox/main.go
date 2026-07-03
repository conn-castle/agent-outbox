package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"agent-outbox/internal/command"
	"agent-outbox/internal/foundation"
)

func main() {
	// Cancel in-flight requests and poll waits when the user interrupts the CLI;
	// every command call and Options.Sleep already accept this context.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := command.Execute(ctx, command.Options{
		Args:   os.Args[1:],
		Stdout: os.Stdout,
		Stderr: os.Stderr,
		Env:    foundation.EnvFromOS(),
	})
	stop()
	os.Exit(code)
}
