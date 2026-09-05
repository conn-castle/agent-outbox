package foundation

import "testing"

func TestExitCodeMappingUsesDocumentedTaxonomy(t *testing.T) {
	tests := map[ErrorCode]int{
		CodeInvalidRequest:          ExitUsage,
		CodeValidationFailed:        ExitData,
		CodeAuthenticationRequired:  ExitPermission,
		CodeNotFound:                ExitNotFound,
		CodePendingContentConflict:  ExitConflict,
		CodeRateLimitExceeded:       ExitTemporary,
		CodeTemporaryUnavailable:    ExitTemporary,
		CodeAPIUnavailable:          ExitTemporary,
		CodeAPIResponseInvalid:      ExitTemporary,
		CodeLocalIO:                 ExitTemporary,
		CodeInternalError:           ExitSoftware,
		CodeAmbiguousCaller:         ExitConfig,
		CodeCallerSelectionConflict: ExitConfig,
		CodeSecretStore:             ExitSecretStore,
	}

	for code, want := range tests {
		if got := ExitCodeFor(NewAppError(code, "fixture")); got != want {
			t.Fatalf("exit code for %q = %d, want %d", code, got, want)
		}
	}
}
