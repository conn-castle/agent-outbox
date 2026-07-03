package foundation

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"

	keyring "github.com/zalando/go-keyring"
)

const (
	masterKeyBytes       = 32
	keyringService       = "dev.agent-outbox.cli"
	keyringMasterAccount = "master-key"
	secretsFileVersion   = 1
	secretsAADBase       = "agent-outbox/secrets.v1/"
	secretsEntryKeyInfo  = "agent-outbox/secrets.v1/entry-key"
)

var ErrSecretNotFound = errors.New("secret not found")

type CallerSecretLoader interface {
	LoadCallerKey(callerID string) (string, error)
}

type CallerSecretStore interface {
	CallerSecretLoader
	StoreCallerKey(callerID string, callerAPIKey string) error
	DeleteCallerKey(callerID string) error
}

type OSKeyring interface {
	Get(service string, account string) (string, error)
	Set(service string, account string, value string) error
}

type GoKeyring struct{}

func (GoKeyring) Get(service string, account string) (string, error) {
	value, err := keyring.Get(service, account)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrSecretNotFound
	}
	return value, err
}

func (GoKeyring) Set(service string, account string, value string) error {
	return keyring.Set(service, account, value)
}

func LoadOrCreateMasterKey(store OSKeyring, random io.Reader) ([]byte, error) {
	if store == nil {
		return nil, NewSecretStoreError("OS credential store is not available.")
	}
	if random == nil {
		random = rand.Reader
	}

	encoded, err := store.Get(keyringService, keyringMasterAccount)
	if err == nil {
		key, decodeErr := base64.StdEncoding.DecodeString(encoded)
		if decodeErr != nil || len(key) != masterKeyBytes {
			return nil, NewSecretStoreError("OS credential-store master key is invalid.")
		}
		return key, nil
	}
	if !errors.Is(err, ErrSecretNotFound) {
		return nil, WrapSecretStoreError("Could not read OS credential-store master key.", err)
	}

	key := make([]byte, masterKeyBytes)
	if _, err := io.ReadFull(random, key); err != nil {
		return nil, WrapSecretStoreError("Could not generate local secret-store master key.", err)
	}
	if err := store.Set(keyringService, keyringMasterAccount, base64.StdEncoding.EncodeToString(key)); err != nil {
		return nil, WrapSecretStoreError("Could not write OS credential-store master key.", err)
	}
	return key, nil
}

func LoadMasterKey(store OSKeyring) ([]byte, error) {
	if store == nil {
		return nil, NewSecretStoreError("OS credential store is not available.")
	}

	encoded, err := store.Get(keyringService, keyringMasterAccount)
	if err != nil {
		if errors.Is(err, ErrSecretNotFound) {
			return nil, WrapSecretStoreError("OS credential-store master key was not found; run agent-outbox caller connect <caller> or restore local credentials.", err)
		}
		return nil, WrapSecretStoreError("Could not read OS credential-store master key.", err)
	}
	key, decodeErr := base64.StdEncoding.DecodeString(encoded)
	if decodeErr != nil || len(key) != masterKeyBytes {
		return nil, NewSecretStoreError("OS credential-store master key is invalid.")
	}
	return key, nil
}

type EncryptedCallerSecretStore struct {
	Path      string
	MasterKey []byte
	Random    io.Reader
}

type secretsManifest struct {
	Version int                        `json:"version"`
	Entries map[string]encryptedRecord `json:"entries"`
}

type encryptedRecord struct {
	Nonce      []byte `json:"nonce"`
	Ciphertext []byte `json:"ciphertext"`
}

func NewEncryptedCallerSecretStore(path string, masterKey []byte) (*EncryptedCallerSecretStore, error) {
	if len(masterKey) != masterKeyBytes {
		return nil, NewSecretStoreError("Local secret-store master key is invalid.")
	}
	if strings.TrimSpace(path) == "" {
		return nil, NewAppError(CodeConfig, "Local secret-store path is required.")
	}
	return &EncryptedCallerSecretStore{
		Path:      path,
		MasterKey: append([]byte(nil), masterKey...),
		Random:    rand.Reader,
	}, nil
}

func (s *EncryptedCallerSecretStore) StoreCallerKey(callerID string, callerAPIKey string) error {
	if strings.TrimSpace(callerID) == "" {
		return NewAppError(CodeConfig, "Caller id is required for local secret storage.")
	}
	if callerAPIKey == "" {
		return NewAppError(CodeConfig, "Caller API key is required for local secret storage.")
	}

	manifest, err := s.loadManifest()
	if err != nil {
		return err
	}
	entryKey, err := s.entryKey(callerID)
	if err != nil {
		return err
	}
	record, err := s.encrypt(callerID, []byte(callerAPIKey))
	if err != nil {
		return err
	}
	manifest.Entries[entryKey] = record
	return s.persistManifest(manifest)
}

func (s *EncryptedCallerSecretStore) LoadCallerKey(callerID string) (string, error) {
	manifest, err := s.loadManifest()
	if err != nil {
		return "", err
	}
	entryKey, err := s.entryKey(callerID)
	if err != nil {
		return "", err
	}
	record, ok := manifest.Entries[entryKey]
	if !ok {
		return "", WrapSecretStoreError("Local caller secret is missing; run agent-outbox caller rotate <caller> or reconnect the caller.", ErrSecretNotFound)
	}
	plaintext, err := s.decrypt(callerID, record)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

func (s *EncryptedCallerSecretStore) DeleteCallerKey(callerID string) error {
	manifest, err := s.loadManifest()
	if err != nil {
		return err
	}
	entryKey, err := s.entryKey(callerID)
	if err != nil {
		return err
	}
	if _, ok := manifest.Entries[entryKey]; !ok {
		return WrapSecretStoreError("Local caller secret is missing; run agent-outbox caller rotate <caller> or reconnect the caller.", ErrSecretNotFound)
	}
	delete(manifest.Entries, entryKey)
	return s.persistManifest(manifest)
}

func (s *EncryptedCallerSecretStore) loadManifest() (*secretsManifest, error) {
	if err := validateMasterKey(s.MasterKey); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(s.Path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &secretsManifest{Version: secretsFileVersion, Entries: map[string]encryptedRecord{}}, nil
		}
		return nil, WrapSecretStoreError("Could not read local encrypted secrets file.", err)
	}
	if len(data) == 0 {
		return nil, NewSecretStoreError("Local encrypted secrets file is empty.")
	}
	var manifest secretsManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, WrapSecretStoreError("Local encrypted secrets file is not valid JSON.", err)
	}
	if manifest.Version != secretsFileVersion {
		return nil, NewSecretStoreError("Local encrypted secrets file version is not supported.")
	}
	if manifest.Entries == nil {
		manifest.Entries = map[string]encryptedRecord{}
	}
	return &manifest, nil
}

func (s *EncryptedCallerSecretStore) persistManifest(manifest *secretsManifest) error {
	data, err := json.Marshal(manifest)
	if err != nil {
		return WrapSecretStoreError("Could not serialize local encrypted secrets file.", err)
	}
	data = append(data, '\n')
	if err := writeOwnerOnlyFile(s.Path, data, 0o600, false); err != nil {
		return WrapSecretStoreError("Could not write local encrypted secrets file.", err)
	}
	return nil
}

func (s *EncryptedCallerSecretStore) PreflightWritable() error {
	if _, err := s.loadManifest(); err != nil {
		return err
	}
	if err := preflightOwnerOnlyFile(s.Path, 0o600, false); err != nil {
		return WrapSecretStoreError("Could not prepare local encrypted secrets file for writing.", err)
	}
	return nil
}

func (s *EncryptedCallerSecretStore) entryKey(callerID string) (string, error) {
	subKey, err := hkdf.Expand(sha256.New, s.MasterKey, secretsEntryKeyInfo, sha256.Size)
	if err != nil {
		return "", WrapSecretStoreError("Could not derive local secret-store entry key.", err)
	}
	mac := hmac.New(sha256.New, subKey)
	mac.Write([]byte(callerID))
	return hex.EncodeToString(mac.Sum(nil)), nil
}

func (s *EncryptedCallerSecretStore) encrypt(callerID string, plaintext []byte) (encryptedRecord, error) {
	aead, err := s.aead()
	if err != nil {
		return encryptedRecord{}, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(s.Random, nonce); err != nil {
		return encryptedRecord{}, WrapSecretStoreError("Could not generate local secret-store nonce.", err)
	}
	return encryptedRecord{
		Nonce:      nonce,
		Ciphertext: aead.Seal(nil, nonce, plaintext, []byte(secretsAADBase+callerID)),
	}, nil
}

func (s *EncryptedCallerSecretStore) decrypt(callerID string, record encryptedRecord) ([]byte, error) {
	aead, err := s.aead()
	if err != nil {
		return nil, err
	}
	if len(record.Nonce) != aead.NonceSize() {
		return nil, NewSecretStoreError("Local encrypted secrets file contains an invalid nonce.")
	}
	plaintext, err := aead.Open(nil, record.Nonce, record.Ciphertext, []byte(secretsAADBase+callerID))
	if err != nil {
		return nil, WrapSecretStoreError("Could not decrypt local caller secret.", err)
	}
	return plaintext, nil
}

func (s *EncryptedCallerSecretStore) aead() (cipher.AEAD, error) {
	if err := validateMasterKey(s.MasterKey); err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(s.MasterKey)
	if err != nil {
		return nil, WrapSecretStoreError("Could not create local secret-store cipher.", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, WrapSecretStoreError("Could not create local secret-store cipher mode.", err)
	}
	return aead, nil
}

func validateMasterKey(masterKey []byte) error {
	if len(masterKey) != masterKeyBytes {
		return NewSecretStoreError("Local secret-store master key is invalid.")
	}
	return nil
}
