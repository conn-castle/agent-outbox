package foundation

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const CredentialsVersion = 1

var ErrSecretNotFound = errors.New("secret not found")

type CallerSecretLoader interface {
	LoadCallerKey(callerID string) (string, error)
}

type CallerSecretStore interface {
	CallerSecretLoader
	StoreCallerKey(callerID string, callerAPIKey string) error
	DeleteCallerKey(callerID string) error
}

type credentialsFile struct {
	Version int                         `json:"version"`
	Callers map[string]callerCredential `json:"callers"`
}

type callerCredential struct {
	APIKey string `json:"api_key"`
}

type FileCallerSecretStore struct {
	Path                string
	ChmodExistingParent bool
}

func NewFileCallerSecretStore(path string, chmodExistingParent bool) (*FileCallerSecretStore, error) {
	if strings.TrimSpace(path) == "" {
		return nil, NewAppError(CodeConfig, "Local credentials path is required.")
	}
	return &FileCallerSecretStore{
		Path:                filepath.Clean(path),
		ChmodExistingParent: chmodExistingParent,
	}, nil
}

func (s *FileCallerSecretStore) StoreCallerKey(callerID string, callerAPIKey string) error {
	lock, err := AcquireLocalStateLock(s.Path)
	if err != nil {
		return WrapSecretStoreError("Could not lock local credentials file.", err)
	}
	if err := s.StoreCallerKeyWithHeldLocalStateLock(callerID, callerAPIKey); err != nil {
		_ = lock.Close()
		return err
	}
	if err := lock.Close(); err != nil {
		return WrapSecretStoreError("Could not unlock local credentials file.", err)
	}
	return nil
}

func (s *FileCallerSecretStore) StoreCallerKeyWithHeldLocalStateLock(callerID string, callerAPIKey string) error {
	callerID = strings.TrimSpace(callerID)
	if callerID == "" {
		return NewAppError(CodeConfig, "Caller id is required for local credential storage.")
	}
	if callerAPIKey == "" {
		return NewAppError(CodeConfig, "Caller API key is required for local credential storage.")
	}

	credentials, err := s.load(true)
	if err != nil {
		return err
	}
	credentials.Callers[callerID] = callerCredential{APIKey: callerAPIKey}
	return s.persist(credentials)
}

func (s *FileCallerSecretStore) LoadCallerKey(callerID string) (string, error) {
	callerID = strings.TrimSpace(callerID)
	if callerID == "" {
		return "", NewAppError(CodeConfig, "Caller id is required for local credential loading.")
	}

	credentials, err := s.load(false)
	if err != nil {
		return "", err
	}
	credential, ok := credentials.Callers[callerID]
	if !ok {
		return "", WrapSecretStoreError("Local caller credential is missing; run agent-outbox caller rotate --caller <caller> or connect a new caller.", ErrSecretNotFound)
	}
	if strings.TrimSpace(credential.APIKey) == "" {
		return "", NewSecretStoreError("Local caller credential is empty; run agent-outbox caller rotate --caller <caller>.")
	}
	return credential.APIKey, nil
}

func (s *FileCallerSecretStore) DeleteCallerKey(callerID string) error {
	lock, err := AcquireLocalStateLock(s.Path)
	if err != nil {
		return WrapSecretStoreError("Could not lock local credentials file.", err)
	}
	if err := s.DeleteCallerKeyWithHeldLocalStateLock(callerID); err != nil {
		_ = lock.Close()
		return err
	}
	if err := lock.Close(); err != nil {
		return WrapSecretStoreError("Could not unlock local credentials file.", err)
	}
	return nil
}

func (s *FileCallerSecretStore) DeleteCallerKeyWithHeldLocalStateLock(callerID string) error {
	callerID = strings.TrimSpace(callerID)
	if callerID == "" {
		return NewAppError(CodeConfig, "Caller id is required for local credential deletion.")
	}

	credentials, err := s.load(false)
	if err != nil {
		return err
	}
	if _, ok := credentials.Callers[callerID]; !ok {
		return WrapSecretStoreError("Local caller credential is missing.", ErrSecretNotFound)
	}
	delete(credentials.Callers, callerID)
	return s.persist(credentials)
}

func (s *FileCallerSecretStore) LocalStateLockFiles() []string {
	return []string{s.Path}
}

func (s *FileCallerSecretStore) PreflightWritable() error {
	if _, err := s.load(true); err != nil {
		return err
	}
	if err := preflightOwnerOnlyFile(s.Path, 0o600, s.ChmodExistingParent); err != nil {
		return WrapSecretStoreError("Could not prepare local credentials file for writing.", err)
	}
	return nil
}

func (s *FileCallerSecretStore) load(allowMissing bool) (*credentialsFile, error) {
	stat, err := os.Lstat(s.Path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			if allowMissing {
				return newCredentialsFile(), nil
			}
			return nil, WrapSecretStoreError("Local credentials file was not found; run agent-outbox caller connect <caller> or agent-outbox caller rotate --caller <caller>.", ErrSecretNotFound)
		}
		return nil, WrapSecretStoreError("Could not inspect local credentials file.", err)
	}
	if err := validateCredentialsFile(stat); err != nil {
		return nil, err
	}

	data, err := os.ReadFile(s.Path)
	if err != nil {
		return nil, WrapSecretStoreError("Could not read local credentials file.", err)
	}
	if len(data) == 0 {
		return nil, NewSecretStoreError("Local credentials file is empty.")
	}

	var credentials credentialsFile
	if err := json.Unmarshal(data, &credentials); err != nil {
		return nil, WrapSecretStoreError("Local credentials file is not valid JSON.", err)
	}
	if credentials.Version != CredentialsVersion {
		return nil, NewSecretStoreError("Local credentials file version is not supported.")
	}
	if credentials.Callers == nil {
		credentials.Callers = map[string]callerCredential{}
	}
	return &credentials, nil
}

func (s *FileCallerSecretStore) persist(credentials *credentialsFile) error {
	data, err := json.MarshalIndent(credentials, "", "  ")
	if err != nil {
		return WrapSecretStoreError("Could not serialize local credentials file.", err)
	}
	data = append(data, '\n')
	if err := writeOwnerOnlyFile(s.Path, data, 0o600, s.ChmodExistingParent); err != nil {
		return WrapSecretStoreError("Could not write local credentials file.", err)
	}
	return nil
}

func newCredentialsFile() *credentialsFile {
	return &credentialsFile{
		Version: CredentialsVersion,
		Callers: map[string]callerCredential{},
	}
}

func validateCredentialsFile(stat os.FileInfo) error {
	if stat.Mode()&os.ModeSymlink != 0 {
		return NewSecretStoreError("Local credentials path must not be a symbolic link.")
	}
	if !stat.Mode().IsRegular() {
		return NewSecretStoreError("Local credentials path is not a regular file.")
	}
	if stat.Mode().Perm()&0o077 != 0 {
		return NewSecretStoreError("Local credentials file must not be readable or writable by other users; run chmod 600 on the file.")
	}
	if systemStat, ok := stat.Sys().(*syscall.Stat_t); ok && systemStat.Uid != uint32(os.Geteuid()) {
		return NewSecretStoreError("Local credentials file must be owned by the current user.")
	}
	return nil
}
