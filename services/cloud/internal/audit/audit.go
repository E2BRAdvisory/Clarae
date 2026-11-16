// Package audit appends rows to audit_log (§3.5.5): every state-changing
// administrative or sharing action leaves a trace of who did what to what,
// and from which client address.
package audit

import (
	"context"
	"encoding/json"
	"errors"
	"net/netip"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"clarae/services/cloud/internal/audit/auditdb"
	"clarae/services/cloud/internal/db"
)

type clientIPKey struct{}

// WithClientIP returns a context carrying the client address that Record
// stores in audit_log.ip. The HTTP layer sets it once per request with the
// address resolved through the trusted proxies, so modules never parse
// headers themselves. An unparsable address is ignored (the row gets NULL).
func WithClientIP(ctx context.Context, ip string) context.Context {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return ctx
	}
	return context.WithValue(ctx, clientIPKey{}, a.Unmap())
}

// WithoutClientIP drops the client address from ctx, for the rows that must not keep it: the record
// of an erasure (art. 17) is written after the user's audit trail was anonymised.
func WithoutClientIP(ctx context.Context) context.Context {
	return context.WithValue(ctx, clientIPKey{}, nil)
}

// ClientIP returns the address set by WithClientIP (false when none: jobs,
// gRPC, tests).
func ClientIP(ctx context.Context) (netip.Addr, bool) {
	a, ok := ctx.Value(clientIPKey{}).(netip.Addr)
	return a, ok
}

// Record writes one audit row through tx, so it commits with the change it describes.
func Record(ctx context.Context, tx db.DBTX, actor uuid.UUID, action, targetType, targetID string, details any) error {
	var raw []byte
	if details != nil {
		b, err := json.Marshal(details)
		if err != nil {
			return err
		}
		raw = b
	}
	var ip *netip.Addr
	if a, ok := ClientIP(ctx); ok {
		ip = &a
	}
	return auditdb.New(tx).InsertAudit(ctx, auditdb.InsertAuditParams{
		ActorID: &actor, Action: action, TargetType: &targetType, TargetID: &targetID, Details: raw, Ip: ip,
	})
}

// Summary is the size of the log: how many rows it holds and when the oldest one was written.
type Summary struct {
	Rows int64
	// First is the time of the oldest row; zero when the log is empty.
	First time.Time
}

// Summarize reads the size of the log. The service writes it to its own log at start: the oldest row
// never moves forward, so a date that jumped to the day of the upgrade shows that the database was
// recreated.
func Summarize(ctx context.Context, q db.DBTX) (Summary, error) {
	queries := auditdb.New(q)
	n, err := queries.CountAudit(ctx)
	if err != nil {
		return Summary{}, err
	}
	first, err := queries.OldestAudit(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return Summary{Rows: n}, nil
	}
	if err != nil {
		return Summary{}, err
	}
	return Summary{Rows: n, First: first}, nil
}
