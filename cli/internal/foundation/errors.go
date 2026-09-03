package foundation

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	ExitSuccess     = 0
	ExitGeneral     = 1
	ExitUsage       = 64
	ExitData        = 65
	ExitNotFound    = 66
	ExitUnavailable = 69
	ExitSoftware    = 70
	ExitConflict    = 73
	ExitSecretStore = 74
	ExitTemporary   = 75
	ExitPermission  = 77
	ExitConfig      = 78
)

type ErrorCode string

const (
	CodeInvalidRequest           ErrorCode = "invalid_request"
	CodeInvalidJSON              ErrorCode = "invalid_json"
	CodeRequestTooLarge          ErrorCode = "request_too_large"
	CodeValidationFailed         ErrorCode = "validation_failed"
	CodeUnsupportedIcon          ErrorCode = "unsupported_icon"
	CodeUnsafeHTML               ErrorCode = "unsafe_html"
	CodeUnsafeColor              ErrorCode = "unsafe_color"
	CodeInvalidActionResponse    ErrorCode = "invalid_action_response"
	CodeUpgradeRequired          ErrorCode = "upgrade_required"
	CodeAuthenticationRequired   ErrorCode = "authentication_required"
	CodeInvalidCallerCredentials ErrorCode = "invalid_caller_credentials"
	CodeAuthorizationFailed      ErrorCode = "authorization_failed"
	CodeNotFound                 ErrorCode = "not_found"
	CodeCallerAlreadyExists      ErrorCode = "caller_already_exists"
	CodePendingContentConflict   ErrorCode = "pending_content_conflict"
	CodeAnsweredUnacknowledged   ErrorCode = "answered_unacknowledged"
	CodeInputNotPending          ErrorCode = "input_not_pending"
	CodeStaleInputRevision       ErrorCode = "stale_input_revision"
	CodeOutputAlreadyRead        ErrorCode = "output_already_read"
	CodeRateLimitExceeded        ErrorCode = "rate_limit_exceeded"
	CodeQuotaLimitExceeded       ErrorCode = "quota_limit_exceeded"
	CodeStorageLimitExceeded     ErrorCode = "storage_limit_exceeded"
	CodeRetentionLimitExceeded   ErrorCode = "retention_limit_exceeded"
	CodeBillingGraceExpired      ErrorCode = "billing_grace_expired"
	CodeAuthorizationPending     ErrorCode = "authorization_pending"
	CodeTemporaryUnavailable     ErrorCode = "temporary_unavailable"
	CodeInternalError            ErrorCode = "internal_error"
	CodeAPIUnavailable           ErrorCode = "api_unavailable"
	CodeAPIResponseInvalid       ErrorCode = "api_response_invalid"
	CodeLocalIO                  ErrorCode = "local_io_error"
	CodeUsage                    ErrorCode = "usage_error"
	CodeConfig                   ErrorCode = "config_error"
	CodeCallerSelectionConflict  ErrorCode = "caller_selection_conflict"
	CodeAmbiguousCaller          ErrorCode = "ambiguous_caller"
	CodeUnknownCaller            ErrorCode = "unknown_caller"
	CodeSecretStore              ErrorCode = "secret_store_error"
)

var exitCodeByErrorCode = map[ErrorCode]int{
	CodeInvalidRequest:           ExitUsage,
	CodeInvalidJSON:              ExitData,
	CodeRequestTooLarge:          ExitData,
	CodeValidationFailed:         ExitData,
	CodeUnsupportedIcon:          ExitData,
	CodeUnsafeHTML:               ExitData,
	CodeUnsafeColor:              ExitData,
	CodeInvalidActionResponse:    ExitData,
	CodeUpgradeRequired:          ExitUnavailable,
	CodeAuthenticationRequired:   ExitPermission,
	CodeInvalidCallerCredentials: ExitPermission,
	CodeAuthorizationFailed:      ExitPermission,
	CodeNotFound:                 ExitNotFound,
	CodeCallerAlreadyExists:      ExitConflict,
	CodePendingContentConflict:   ExitConflict,
	CodeAnsweredUnacknowledged:   ExitConflict,
	CodeInputNotPending:          ExitConflict,
	CodeStaleInputRevision:       ExitConflict,
	CodeOutputAlreadyRead:        ExitConflict,
	CodeRateLimitExceeded:        ExitTemporary,
	CodeQuotaLimitExceeded:       ExitTemporary,
	CodeStorageLimitExceeded:     ExitTemporary,
	CodeRetentionLimitExceeded:   ExitTemporary,
	CodeBillingGraceExpired:      ExitUnavailable,
	CodeAuthorizationPending:     ExitTemporary,
	CodeTemporaryUnavailable:     ExitTemporary,
	CodeInternalError:            ExitSoftware,
	CodeAPIUnavailable:           ExitTemporary,
	CodeAPIResponseInvalid:       ExitTemporary,
	CodeLocalIO:                  ExitTemporary,
	CodeUsage:                    ExitUsage,
	CodeConfig:                   ExitConfig,
	CodeCallerSelectionConflict:  ExitConfig,
	CodeAmbiguousCaller:          ExitConfig,
	CodeUnknownCaller:            ExitConfig,
	CodeSecretStore:              ExitSecretStore,
}

type FieldError struct {
	Path    string `json:"path,omitempty"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

type LimitMetadata struct {
	LimitName       string  `json:"limit_name,omitempty"`
	LimitReasonCode string  `json:"limit_reason_code,omitempty"`
	LimitReason     string  `json:"limit_reason,omitempty"`
	LimitResetsAt   *string `json:"limit_resets_at,omitempty"`
}

type UpgradeMetadata struct {
	Message string `json:"message"`
	URL     string `json:"url"`
}

type AppError struct {
	Code              ErrorCode        `json:"code"`
	Message           string           `json:"message"`
	HTTPStatus        int              `json:"http_status,omitempty"`
	UpstreamErrorCode ErrorCode        `json:"upstream_error_code,omitempty"`
	Fields            []FieldError     `json:"fields,omitempty"`
	ErrorID           string           `json:"error_id,omitempty"`
	RequestID         string           `json:"request_id,omitempty"`
	CorrelationID     string           `json:"correlation_id,omitempty"`
	RetryAfterSeconds *int             `json:"retry_after_seconds,omitempty"`
	Limit             *LimitMetadata   `json:"limit,omitempty"`
	Upgrade           *UpgradeMetadata `json:"upgrade,omitempty"`
	WriteOutcome      string           `json:"write_outcome,omitempty"`
	ExitCode          int              `json:"-"`
	cause             error
}

func (e *AppError) Error() string {
	if e == nil {
		return ""
	}
	if e.Message != "" {
		return e.Message
	}
	return string(e.Code)
}

func (e *AppError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.cause
}

func NewAppError(code ErrorCode, message string) *AppError {
	return &AppError{Code: code, Message: message}
}

func NewUsageError(message string) *AppError {
	return &AppError{Code: CodeUsage, Message: message, ExitCode: ExitUsage}
}

func WrapConfigError(message string, err error) *AppError {
	return &AppError{Code: CodeConfig, Message: message, ExitCode: ExitConfig, cause: err}
}

func NewSecretStoreError(message string) *AppError {
	return &AppError{Code: CodeSecretStore, Message: message, ExitCode: ExitSecretStore}
}

func WrapSecretStoreError(message string, err error) *AppError {
	return &AppError{Code: CodeSecretStore, Message: message, ExitCode: ExitSecretStore, cause: err}
}

func ExitCodeFor(err error) int {
	if err == nil {
		return ExitSuccess
	}

	var appErr *AppError
	if errors.As(err, &appErr) {
		if appErr.ExitCode != 0 {
			return appErr.ExitCode
		}
		if code, ok := exitCodeByErrorCode[appErr.Code]; ok {
			return code
		}
	}

	return ExitGeneral
}

func RenderError(w io.Writer, jsonMode bool, err error) {
	if w == nil || err == nil {
		return
	}

	appErr := normalizeError(err)
	if jsonMode {
		payload := map[string]any{
			"ok":    false,
			"error": appErr,
		}
		if appErr.RequestID != "" {
			payload["request_id"] = appErr.RequestID
		}
		if appErr.CorrelationID != "" {
			payload["correlation_id"] = appErr.CorrelationID
		}
		encoder := json.NewEncoder(w)
		encoder.SetEscapeHTML(false)
		_ = encoder.Encode(payload)
		return
	}

	_, _ = fmt.Fprintf(w, "%s: %s\n", appErr.Code, appErr.Message)
	if appErr.RequestID != "" || appErr.CorrelationID != "" {
		_, _ = fmt.Fprintf(w, "request_id=%s correlation_id=%s\n", appErr.RequestID, appErr.CorrelationID)
	}
}

func normalizeError(err error) *AppError {
	var appErr *AppError
	if errors.As(err, &appErr) {
		return appErr
	}
	return &AppError{
		Code:    CodeInternalError,
		Message: "Unexpected local CLI failure.",
		cause:   err,
	}
}
