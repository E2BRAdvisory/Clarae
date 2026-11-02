package privacy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"memobrain/services/cloud/internal/api"
	"memobrain/services/cloud/internal/auth"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/shared/syncproto"
)

// HTTP implements the GDPR endpoints of the generated strict server.
type HTTP struct{ svc *Service }

// NewHTTP binds the handlers to the service.
func NewHTTP(s *Service) *HTTP { return &HTTP{svc: s} }

// exportResponse streams the export as a downloadable JSON file.
type exportResponse struct {
	data Export
	// audit calls fn with each entry of the audit log (Service.EachAuditEntry).
	audit func(fn func(map[string]any) error) error
}

func (r exportResponse) VisitExportMyDataResponse(w http.ResponseWriter) error {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="memobrain-account-%s.json"`, r.data.GeneratedAt.Format("20060102")))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	return r.write(w)
}

// write produces the document: every member but audit_log at once, then the
// audit_log entry by entry as its last member. A database error midway
// truncates the document: the client sees invalid JSON, as with any
// interrupted transfer, never a silently shortened log.
func (r exportResponse) write(w io.Writer) error {
	head, err := json.MarshalIndent(r.data, "", "  ")
	if err != nil {
		return err
	}
	// Reopen the object to append audit_log.
	head, ok := bytes.CutSuffix(head, []byte("\n}"))
	if !ok {
		return fmt.Errorf("privacy: unexpected export document %.20q", head)
	}
	bw := bufio.NewWriterSize(w, 64<<10)
	_, _ = bw.Write(head)
	_, _ = bw.WriteString(",\n  \"audit_log\": [")
	n := 0
	err = r.audit(func(e map[string]any) error {
		b, err := json.MarshalIndent(e, "    ", "  ")
		if err != nil {
			return err
		}
		if n > 0 {
			_ = bw.WriteByte(',')
		}
		n++
		_, _ = bw.WriteString("\n    ")
		_, err = bw.Write(b)
		return err
	})
	if err != nil {
		_ = bw.Flush()
		return err
	}
	if n > 0 {
		_, _ = bw.WriteString("\n  ")
	}
	_, _ = bw.WriteString("]\n}\n")
	return bw.Flush()
}

// ExportMyData implements GET /me/export.
func (h *HTTP) ExportMyData(ctx context.Context, _ api.ExportMyDataRequestObject) (api.ExportMyDataResponseObject, error) {
	p := auth.MustPrincipal(ctx)
	data, err := h.svc.Export(ctx, p.UserID)
	if err != nil {
		return nil, err
	}
	return exportResponse{data: data, audit: func(fn func(map[string]any) error) error {
		return h.svc.EachAuditEntry(ctx, p.UserID, fn)
	}}, nil
}

// DeleteMyAccount implements DELETE /me.
func (h *HTTP) DeleteMyAccount(ctx context.Context, req api.DeleteMyAccountRequestObject) (api.DeleteMyAccountResponseObject, error) {
	p := auth.MustPrincipal(ctx)
	if req.Body == nil || req.Body.Confirm == "" {
		return nil, httpproblem.Errorf(syncproto.CodeValidationFailed, "confirm is required")
	}
	ack := req.Body.AcknowledgeDataLoss != nil && *req.Body.AcknowledgeDataLoss
	if err := h.svc.Delete(ctx, p.UserID, DeleteRequest{Confirm: req.Body.Confirm, AcknowledgeDataLoss: ack}); err != nil {
		return nil, err
	}
	return api.DeleteMyAccount204Response{}, nil
}
