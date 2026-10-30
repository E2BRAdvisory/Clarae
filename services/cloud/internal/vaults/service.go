// Package vaults owns the vaults and vault_key_envelopes tables: lifecycle
// (create, rename, soft delete, restore), the manifest of current files and
// the wrapped keys of private vaults (§2.6.1, M2-WP1). Other modules obtain
// access decisions through Open and never touch these tables.
package vaults

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"memobrain/services/cloud/internal/access"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/settings"
	"memobrain/services/cloud/internal/vaults/vaultsdb"
	"memobrain/shared/syncproto"
)

// Vault kinds (D-02). The kind never changes after creation.
const (
	KindPrivate = "private"
	KindShared  = "shared"
)

// Envelope kinds.
const (
	EnvelopePassphrase = "passphrase"
	EnvelopeRecovery   = "recovery"
)

// WrappedVMKSize is nonce (12) + VMK (32) + GCM tag (16).
const WrappedVMKSize = 12 + 32 + 16

// Argon2id bounds enforced on stored envelopes: the minimum protects users
// from a client that would weaken the KDF, the maximum stops a hostile client
// from planting parameters that make every other device run out of memory.
const (
	minT, maxT       = 3, 12
	minMKiB, maxMKiB = 64 * 1024, 1024 * 1024
	minP, maxP       = 4, 16
)

// DeletedRetention is how long a soft-deleted vault can be restored; the
// purge job reads the setting vaults.deleted_retention_days.
const defaultDeletedRetention = 30 * 24 * time.Hour

// Service implements the vaults and vaultkeys modules.
type Service struct {
	db    *db.DB
	authz access.Authorizer
}

// NewService binds the module to the database.
func NewService(d *db.DB) *Service { return &Service{db: d} }

// WithAuthorizer lets Tree serve share scopes (M4); without one only owners are served.
func (s *Service) WithAuthorizer(a access.Authorizer) *Service {
	s.authz = a
	return s
}

// KDF is the "kdf" object of an envelope.
type KDF struct {
	Alg  string `json:"alg"`
	T    int    `json:"t,omitempty"`
	MKiB int    `json:"m_kib,omitempty"`
	P    int    `json:"p,omitempty"`
	Salt string `json:"salt"`
}

// EnvelopeInput is a wrapped VMK as sent by a client.
type EnvelopeInput struct {
	Kind       string
	KDF        KDF
	WrappedVMK []byte
}

// ValidateEnvelope checks format and lengths; the server never sees keys, so
// this is all it can check (§3.8.5).
func ValidateEnvelope(e EnvelopeInput) error {
	salt, err := base64.StdEncoding.DecodeString(e.KDF.Salt)
	if err != nil || len(salt) < 8 || len(salt) > 64 {
		return errors.New("kdf.salt must be base64 of 8..64 bytes")
	}
	if len(e.WrappedVMK) != WrappedVMKSize {
		return fmt.Errorf("wrapped_vmk must be %d bytes", WrappedVMKSize)
	}
	switch e.Kind {
	case EnvelopePassphrase:
		k := e.KDF
		if k.Alg != "argon2id" {
			return errors.New("passphrase envelope requires kdf.alg argon2id")
		}
		if k.T < minT || k.T > maxT || k.MKiB < minMKiB || k.MKiB > maxMKiB || k.P < minP || k.P > maxP {
			return fmt.Errorf("argon2id parameters out of range (t %d..%d, m_kib %d..%d, p %d..%d)", minT, maxT, minMKiB, maxMKiB, minP, maxP)
		}
	case EnvelopeRecovery:
		if e.KDF.Alg != "hkdf-sha256" {
			return errors.New("recovery envelope requires kdf.alg hkdf-sha256")
		}
	default:
		return fmt.Errorf("unknown envelope kind %q", e.Kind)
	}
	return nil
}

// ValidateName enforces the vault name rules.
func ValidateName(name string) (string, error) {
	n := strings.TrimSpace(name)
	if n == "" || utf8.RuneCountInString(n) > 120 {
		return "", errors.New("name must be 1..120 characters")
	}
	for _, r := range n {
		if r < 0x20 || r == 0x7f {
			return "", errors.New("name contains control characters")
		}
	}
	return n, nil
}

func isUnique(err error, constraint string) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505" && (constraint == "" || pg.ConstraintName == constraint)
}

// Create makes a vault owned by ownerID. Private vaults need both envelopes,
// shared vaults none.
func (s *Service) Create(ctx context.Context, ownerID uuid.UUID, name, kind string, envs []EnvelopeInput) (vaultsdb.Vault, error) {
	n, err := ValidateName(name)
	if err != nil {
		return vaultsdb.Vault{}, httpproblem.Errorf(syncproto.CodeValidationFailed, "%v", err)
	}
	switch kind {
	case KindPrivate:
		have := map[string]bool{}
		for _, e := range envs {
			if err := ValidateEnvelope(e); err != nil {
				return vaultsdb.Vault{}, httpproblem.Errorf(syncproto.CodeValidationFailed, "key_envelopes: %v", err)
			}
			if have[e.Kind] {
				return vaultsdb.Vault{}, httpproblem.Errorf(syncproto.CodeValidationFailed, "key_envelopes: duplicate %s envelope", e.Kind)
			}
			have[e.Kind] = true
		}
		if !have[EnvelopePassphrase] || !have[EnvelopeRecovery] {
			return vaultsdb.Vault{}, httpproblem.Errorf(syncproto.CodeValidationFailed, "a private vault requires both the passphrase and the recovery envelope")
		}
	case KindShared:
		if len(envs) > 0 {
			return vaultsdb.Vault{}, httpproblem.Errorf(syncproto.CodeValidationFailed, "key_envelopes are only allowed on private vaults")
		}
	default:
		return vaultsdb.Vault{}, httpproblem.Errorf(syncproto.CodeValidationFailed, "kind must be private or shared")
	}
	id, err := uuid.NewV7()
	if err != nil {
		return vaultsdb.Vault{}, err
	}
	var v vaultsdb.Vault
	err = s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := vaultsdb.New(tx)
		var err error
		v, err = q.CreateVault(ctx, vaultsdb.CreateVaultParams{ID: id, OwnerID: ownerID, Name: n, Kind: kind})
		if err != nil {
			return err
		}
		for _, e := range envs {
			kdf, _ := json.Marshal(e.KDF)
			eid, err := uuid.NewV7()
			if err != nil {
				return err
			}
			if _, err := q.UpsertEnvelope(ctx, vaultsdb.UpsertEnvelopeParams{ID: eid, VaultID: id, Kind: e.Kind, Kdf: kdf, WrappedVmk: e.WrappedVMK}); err != nil {
				return err
			}
		}
		return nil
	})
	if isUnique(err, "vaults_owner_name_uq") {
		return vaultsdb.Vault{}, httpproblem.Errorf(syncproto.CodeNameInUse, "you already have a vault named %q", n)
	}
	return v, err
}

// Open returns the vault when userID may use it. In M2 only the owner can;
// shares and mounts extend this in M4. Unknown, foreign and (unless
// allowDeleted) soft-deleted vaults are indistinguishable: NOT_FOUND (§3.7).
func (s *Service) Open(ctx context.Context, userID, vaultID uuid.UUID) (vaultsdb.Vault, error) {
	return s.open(ctx, vaultsdb.New(s.db.Pool), userID, vaultID, false)
}

// OpenTx is Open inside a transaction.
func (s *Service) OpenTx(ctx context.Context, q *vaultsdb.Queries, userID, vaultID uuid.UUID) (vaultsdb.Vault, error) {
	return s.open(ctx, q, userID, vaultID, false)
}

func (s *Service) open(ctx context.Context, q *vaultsdb.Queries, userID, vaultID uuid.UUID, allowDeleted bool) (vaultsdb.Vault, error) {
	v, err := q.GetVault(ctx, vaultID)
	if errors.Is(err, pgx.ErrNoRows) {
		return vaultsdb.Vault{}, httpproblem.NotFound("vault")
	}
	if err != nil {
		return vaultsdb.Vault{}, err
	}
	if v.OwnerID != userID || (v.DeletedAt != nil && !allowDeleted) {
		return vaultsdb.Vault{}, httpproblem.NotFound("vault")
	}
	return v, nil
}

// List returns the caller's vaults.
func (s *Service) List(ctx context.Context, userID uuid.UUID) ([]vaultsdb.Vault, error) {
	return vaultsdb.New(s.db.Pool).ListOwnedVaults(ctx, userID)
}

// Rename changes the vault name (owner).
func (s *Service) Rename(ctx context.Context, userID, vaultID uuid.UUID, name string) (vaultsdb.Vault, error) {
	n, err := ValidateName(name)
	if err != nil {
		return vaultsdb.Vault{}, httpproblem.Errorf(syncproto.CodeValidationFailed, "%v", err)
	}
	if _, err := s.Open(ctx, userID, vaultID); err != nil {
		return vaultsdb.Vault{}, err
	}
	v, err := vaultsdb.New(s.db.Pool).RenameVault(ctx, vaultsdb.RenameVaultParams{ID: vaultID, Name: n})
	if isUnique(err, "vaults_owner_name_uq") {
		return vaultsdb.Vault{}, httpproblem.Errorf(syncproto.CodeNameInUse, "you already have a vault named %q", n)
	}
	return v, err
}

// Delete soft-deletes the vault; the data stays until the purge job.
func (s *Service) Delete(ctx context.Context, userID, vaultID uuid.UUID) error {
	if _, err := s.Open(ctx, userID, vaultID); err != nil {
		return err
	}
	_, err := vaultsdb.New(s.db.Pool).SoftDeleteVault(ctx, vaultID)
	return err
}

// Restore undoes a soft delete inside the retention period.
func (s *Service) Restore(ctx context.Context, userID, vaultID uuid.UUID) (vaultsdb.Vault, error) {
	q := vaultsdb.New(s.db.Pool)
	v, err := s.open(ctx, q, userID, vaultID, true)
	if err != nil {
		return vaultsdb.Vault{}, err
	}
	if v.DeletedAt == nil {
		return vaultsdb.Vault{}, httpproblem.Errorf(syncproto.CodeValidationFailed, "vault is not deleted")
	}
	retention := defaultDeletedRetention
	if days, err := s.settingInt(ctx, "vaults.deleted_retention_days"); err == nil && days > 0 {
		retention = time.Duration(days) * 24 * time.Hour
	}
	if time.Since(*v.DeletedAt) > retention {
		return vaultsdb.Vault{}, httpproblem.NotFound("vault")
	}
	r, err := q.RestoreVault(ctx, vaultID)
	if isUnique(err, "vaults_owner_name_uq") {
		return vaultsdb.Vault{}, httpproblem.Errorf(syncproto.CodeNameInUse, "another vault is already named %q: rename it first", v.Name)
	}
	return r, err
}

func (s *Service) settingInt(ctx context.Context, key string) (int, error) {
	raw, ok, err := settings.Get(ctx, s.db.Pool, key)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, pgx.ErrNoRows
	}
	var n int
	return n, json.Unmarshal(raw, &n)
}

// TreeEntry is one current file of the manifest.
type TreeEntry struct {
	ID   uuid.UUID
	Path string
	Kind string
	Rev  int32
	Hash string
	Size int64
}

// Tree returns the manifest of current files and the changelog position it
// reflects, read in one snapshot so a client can continue with
// changes?since=asOfSeq without gaps or duplicates.
func (s *Service) Tree(ctx context.Context, userID, vaultID uuid.UUID) (entries []TreeEntry, asOfSeq int64, err error) {
	tx, err := s.db.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := vaultsdb.New(tx)
	v, err := s.open(ctx, q, userID, vaultID, false)
	if err != nil {
		return nil, 0, err
	}
	rows, err := q.ListTree(ctx, vaultID)
	if err != nil {
		return nil, 0, err
	}
	entries = make([]TreeEntry, 0, len(rows))
	for _, r := range rows {
		h := ""
		if r.BlobHash != nil {
			h = *r.BlobHash
		}
		entries = append(entries, TreeEntry{ID: r.ID, Path: r.Path, Kind: r.Kind, Rev: r.CurrentRev, Hash: h, Size: r.Size})
	}
	return entries, v.LastSeq, nil
}

// TreeScoped is Tree through an optional share scope: the manifest of the files the share
// covers, with paths relative to its root (§3.4.7). An empty scope is the owner's own tree.
func (s *Service) TreeScoped(ctx context.Context, userID, vaultID uuid.UUID, scope string) ([]TreeEntry, int64, error) {
	if scope == "" {
		return s.Tree(ctx, userID, vaultID)
	}
	if s.authz == nil {
		return nil, 0, httpproblem.Errorf(syncproto.CodeValidationFailed, "shares are not available")
	}
	acc, err := s.authz.Authorize(ctx, userID, vaultID, scope, access.Viewer)
	if err != nil {
		return nil, 0, err
	}
	entries, asOf, err := s.Tree(ctx, acc.Vault.OwnerID, vaultID)
	if err != nil {
		return nil, 0, err
	}
	out := make([]TreeEntry, 0, len(entries))
	for _, e := range entries {
		if acc.Scope.ContainsFile(e.ID, e.Path) {
			e.Path = acc.Scope.Rel(e.Path)
			out = append(out, e)
		}
	}
	return out, asOf, nil
}

// Envelope is a stored key envelope.
type Envelope struct {
	Kind       string
	KDF        KDF
	WrappedVMK []byte
	CreatedAt  time.Time
}

func toEnvelope(e vaultsdb.VaultKeyEnvelope) (Envelope, error) {
	var k KDF
	if err := json.Unmarshal(e.Kdf, &k); err != nil {
		return Envelope{}, err
	}
	return Envelope{Kind: e.Kind, KDF: k, WrappedVMK: e.WrappedVmk, CreatedAt: e.CreatedAt}, nil
}

func requirePrivate(v vaultsdb.Vault) error {
	if v.Kind != KindPrivate {
		return httpproblem.Errorf(syncproto.CodeValidationFailed, "key envelopes exist only on private vaults")
	}
	return nil
}

// Envelopes lists the envelopes of a private vault (owner).
func (s *Service) Envelopes(ctx context.Context, userID, vaultID uuid.UUID) ([]Envelope, error) {
	v, err := s.Open(ctx, userID, vaultID)
	if err != nil {
		return nil, err
	}
	if err := requirePrivate(v); err != nil {
		return nil, err
	}
	rows, err := vaultsdb.New(s.db.Pool).ListEnvelopes(ctx, vaultID)
	if err != nil {
		return nil, err
	}
	out := make([]Envelope, 0, len(rows))
	for _, r := range rows {
		e, err := toEnvelope(r)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, nil
}

// PutEnvelope replaces one envelope (change passphrase, new recovery key).
func (s *Service) PutEnvelope(ctx context.Context, userID, vaultID uuid.UUID, in EnvelopeInput) (Envelope, error) {
	v, err := s.Open(ctx, userID, vaultID)
	if err != nil {
		return Envelope{}, err
	}
	if err := requirePrivate(v); err != nil {
		return Envelope{}, err
	}
	if err := ValidateEnvelope(in); err != nil {
		return Envelope{}, httpproblem.Errorf(syncproto.CodeValidationFailed, "%v", err)
	}
	kdf, _ := json.Marshal(in.KDF)
	id, err := uuid.NewV7()
	if err != nil {
		return Envelope{}, err
	}
	row, err := vaultsdb.New(s.db.Pool).UpsertEnvelope(ctx, vaultsdb.UpsertEnvelopeParams{ID: id, VaultID: vaultID, Kind: in.Kind, Kdf: kdf, WrappedVmk: in.WrappedVMK})
	if err != nil {
		return Envelope{}, err
	}
	return toEnvelope(row)
}
