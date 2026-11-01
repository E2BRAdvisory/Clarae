package notify

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// NOTIFY channels besides vault_changed (M4-WP2/WP3).
const (
	// ChannelShare carries a JSON ShareEvent.
	ChannelShare = "share_changed"
	// ChannelConfig carries the new configuration revision.
	ChannelConfig = "config_changed"
	// ChannelAccount carries a JSON AccountEvent (M5: suspension, quota).
	ChannelAccount = "account_changed"
)

// Kinds of account events (§3.6 AccountChanged).
const (
	AccountSuspended    = "suspended"
	AccountActivated    = "activated"
	AccountQuotaChanged = "quota_changed"
)

// EndsStream reports whether sending ev must close the notification stream
// it travels on. A suspension (account deletion publishes the same kind)
// revokes the access the token was granted when the stream opened, so both
// transports deliver the event and then stop: gRPC with PERMISSION_DENIED,
// SSE by ending the response. Reconnecting fails the suspension check.
func EndsStream(ev Event) bool {
	return ev.Kind == KindAccount && ev.AccountKind == AccountSuspended
}

// AccountEvent says that the account of one user changed.
type AccountEvent struct {
	User uuid.UUID `json:"u"`
	Kind string    `json:"k"`
}

// PublishAccount announces an account change when the surrounding transaction commits.
func PublishAccount(ctx context.Context, tx pgx.Tx, ev AccountEvent) error {
	b, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, "SELECT pg_notify($1, $2)", ChannelAccount, string(b))
	return err
}

// ParseAccount decodes a ChannelAccount payload.
func ParseAccount(payload string) (AccountEvent, bool) {
	var ev AccountEvent
	if json.Unmarshal([]byte(payload), &ev) != nil || ev.User == uuid.Nil || ev.Kind == "" {
		return AccountEvent{}, false
	}
	return ev, true
}

// Kinds of share events (§3.6 ShareChanged).
const (
	ShareGranted = "granted"
	ShareRevoked = "revoked"
	ShareUpdated = "updated"
)

// ShareEvent says that a share changed for some users. When Users is empty the
// hub resolves the recipients (everyone with a grant on the share, and its owner);
// a removed grant lists its former recipients explicitly because they no longer
// have a row to be found by.
type ShareEvent struct {
	Kind  string      `json:"k"`
	Share uuid.UUID   `json:"s"`
	Users []uuid.UUID `json:"u,omitempty"`
}

// notifyPayloadLimit keeps one NOTIFY well under PostgreSQL's 8000 byte cap.
const usersPerNotify = 100

// PublishShare emits the event inside the transaction that changed the share, so it is
// delivered only if the change commits. A long recipient list is split.
func PublishShare(ctx context.Context, tx pgx.Tx, ev ShareEvent) error {
	users := ev.Users
	for first := true; first || len(users) > 0; first = false {
		chunk := users
		if len(chunk) > usersPerNotify {
			chunk = chunk[:usersPerNotify]
		}
		users = users[len(chunk):]
		b, err := json.Marshal(ShareEvent{Kind: ev.Kind, Share: ev.Share, Users: chunk})
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "SELECT pg_notify($1, $2)", ChannelShare, string(b)); err != nil {
			return err
		}
	}
	return nil
}

// PublishConfig announces a new configuration revision.
func PublishConfig(ctx context.Context, tx pgx.Tx, revision int64) error {
	_, err := tx.Exec(ctx, "SELECT pg_notify($1, $2)", ChannelConfig, strconv.FormatInt(revision, 10))
	return err
}

// ParseShare decodes a ChannelShare payload.
func ParseShare(payload string) (ShareEvent, bool) {
	var ev ShareEvent
	if json.Unmarshal([]byte(payload), &ev) != nil || ev.Share == uuid.Nil || ev.Kind == "" {
		return ShareEvent{}, false
	}
	return ev, true
}
