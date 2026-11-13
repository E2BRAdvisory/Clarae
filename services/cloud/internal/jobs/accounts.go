package jobs

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"clarae/services/cloud/internal/audit"
	"clarae/services/cloud/internal/jobs/jobsdb"
	"clarae/services/cloud/internal/keycloak"
	"clarae/services/cloud/internal/privacy"
	"clarae/services/cloud/internal/users"
)

// IdentityDisabler disables an account at the identity provider; implemented
// by keycloak.Admin.
type IdentityDisabler interface {
	SetEnabled(ctx context.Context, sub string, enabled bool) error
}

// WithIdentityProvider lets the account purge disable the Keycloak account
// once more before the subject is forgotten (the deletion already tried, and
// tolerates an unconfigured or failing Admin API).
func (r *Runner) WithIdentityProvider(kc IdentityDisabler) *Runner {
	r.kc = kc
	return r
}

// PurgeDeletedAccounts finishes the deletion of accounts that were deleted longer
// ago than privacy.account_purge_days (default 30; ADR-0021): every vault they
// still own is purged (releasing blob references, which the blob GC then removes),
// the personal data is anonymised again (idempotent: both deletion paths already
// anonymise through privacy.DeleteAccount, but rows deleted by an administrator
// before that change were only soft-deleted), and the row becomes a permanent tombstone whose id
// keeps audit entries and revisions in other users' vaults consistent. The
// fingerprint of the Keycloak subject is kept (users.RecordPurgedSubject): a
// later login with the same identity is refused instead of creating a new
// account, which matters when the Keycloak account could not be disabled.
func (r *Runner) PurgeDeletedAccounts(ctx context.Context) (int, error) {
	retention := time.Duration(r.setting(ctx, "privacy.account_purge_days", 30)) * 24 * time.Hour
	q := jobsdb.New(r.db.Pool)
	ids, err := q.ListUsersToPurge(ctx, ptrTime(r.now().Add(-retention)))
	if err != nil {
		return 0, err
	}
	purged := 0
	var errs []error
	for _, id := range ids {
		// One account failing must not hold back the others: it is logged,
		// reported and retried on the next run (it is not marked purged).
		if err := r.purgeAccount(ctx, q, id); err != nil {
			if ctx.Err() != nil {
				return purged, ctx.Err()
			}
			if errors.Is(err, errPurgeBusy) {
				continue
			}
			r.log.Error().Err(err).Str("user", id.String()).Msg("purge of a deleted account failed")
			errs = append(errs, fmt.Errorf("account %s: %w", id, err))
			continue
		}
		purged++
	}
	return purged, errors.Join(errs...)
}

// purgeAccount purges every vault of one deleted account and then marks it purged.
func (r *Runner) purgeAccount(ctx context.Context, q *jobsdb.Queries, id uuid.UUID) error {
	vaultIDs, err := q.ListAllVaultIDsOfOwner(ctx, id)
	if err != nil {
		return err
	}
	for _, v := range vaultIDs {
		// The account retention governs: no need to wait for the vault retention.
		if _, err := r.purgeVault(ctx, v, nil); err != nil {
			return fmt.Errorf("purge vault %s: %w", v, err)
		}
	}
	if left, err := q.ListAllVaultIDsOfOwner(ctx, id); err != nil || len(left) > 0 {
		// A vault purge was postponed (logged): the next run finishes it.
		return cmp.Or(err, errPurgeBusy)
	}
	u, err := users.GetUserByID(ctx, r.db.Pool, id)
	if err != nil {
		return err
	}
	subject := u.KeycloakSub
	if strings.HasPrefix(subject, purgedSubjectPrefix) {
		subject = "" // already replaced: nothing left to block or disable
	}
	identity := r.disableIdentity(ctx, id, subject)
	return r.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := jobsdb.New(tx)
		if err := privacy.Anonymise(ctx, tx, id); err != nil {
			return err
		}
		if subject != "" {
			if err := users.RecordPurgedSubject(ctx, tx, subject); err != nil {
				return err
			}
		}
		if err := q.MarkUserPurged(ctx, id); err != nil {
			return err
		}
		return audit.Record(ctx, tx, id, "account.purge", "user", id.String(), map[string]any{"vaults": len(vaultIDs), "identity_provider": identity})
	})
}

// purgedSubjectPrefix starts the keycloak_sub that MarkUserPurged writes.
const purgedSubjectPrefix = "purged:"

// Outcomes of disableIdentity, recorded in the audit entry of the purge.
const (
	identityDisabled      = "disabled"
	identityNotFound      = "not_found"
	identityNotConfigured = "not_configured"
	identityFailed        = "failed"
)

// disableIdentity disables the Keycloak account of a purged subject and
// reports the outcome. When it cannot (no Admin API, or an error), the
// account may still sign in at the identity provider: the purged subject
// fingerprint is then what keeps it out, and the warning tells the operator
// to disable it by hand.
func (r *Runner) disableIdentity(ctx context.Context, id uuid.UUID, subject string) string {
	if subject == "" {
		return identityNotFound
	}
	err := keycloak.ErrDisabled
	if r.kc != nil {
		err = r.kc.SetEnabled(ctx, subject, false)
	}
	outcome := identityFailed
	switch {
	case err == nil:
		return identityDisabled
	case errors.Is(err, keycloak.ErrNotFound):
		return identityNotFound
	case errors.Is(err, keycloak.ErrDisabled):
		outcome = identityNotConfigured
	}
	r.log.Warn().Err(err).Str("user_id", id.String()).Str("identity_provider", outcome).
		Msg("account purge: the Keycloak account could not be disabled; sign-ins with it stay refused, disable or delete it in Keycloak")
	return outcome
}
