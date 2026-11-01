// Package audit appends rows to audit_log (§3.5.5): every state-changing
// administrative or sharing action leaves a trace of who did what to what,
// and from which client address.
package audit

import (
	"context"
	"encoding/json"
	"net/netip"

	"github.com/google/uuid"

	"memobrain/services/cloud/internal/audit/auditdb"
	"memobrain/services/cloud/internal/db"
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
