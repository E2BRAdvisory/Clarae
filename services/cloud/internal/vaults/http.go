package vaults

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"memobrain/services/cloud/internal/api"
	"memobrain/services/cloud/internal/auth"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/vaults/vaultsdb"
	"memobrain/shared/syncproto"
)

// HTTP implements the vault endpoints of the generated strict server.
type HTTP struct{ svc *Service }

// NewHTTP binds the handlers to the service.
func NewHTTP(s *Service) *HTTP { return &HTTP{svc: s} }

// ToAPI converts a vault row to its API representation.
func ToAPI(v vaultsdb.Vault) api.Vault {
	return api.Vault{
		Id:         v.ID,
		OwnerId:    v.OwnerID,
		Name:       v.Name,
		Kind:       api.VaultKind(v.Kind),
		LastSeq:    v.LastSeq,
		TotalBytes: v.TotalBytes,
		FileCount:  int(v.FileCount),
		CreatedAt:  v.CreatedAt,
		DeletedAt:  v.DeletedAt,
	}
}

// ListVaults implements GET /vaults (include_deleted adds the restorable soft-deleted vaults).
func (h *HTTP) ListVaults(ctx context.Context, req api.ListVaultsRequestObject) (api.ListVaultsResponseObject, error) {
	includeDeleted := req.Params.IncludeDeleted != nil && *req.Params.IncludeDeleted
	rows, err := h.svc.List(ctx, auth.MustPrincipal(ctx).UserID, includeDeleted)
	if err != nil {
		return nil, err
	}
	items := make([]api.Vault, 0, len(rows))
	for _, v := range rows {
		items = append(items, ToAPI(v))
	}
	return api.ListVaults200JSONResponse{Items: items, Mounts: []api.Vault{}}, nil
}

// CreateVault implements POST /vaults. A retry carrying the Idempotency-Key
// of an attempt that succeeded gets that attempt's vault, with 201 again.
func (h *HTTP) CreateVault(ctx context.Context, req api.CreateVaultRequestObject) (api.CreateVaultResponseObject, error) {
	if req.Body == nil {
		return nil, httpproblem.Errorf(syncproto.CodeValidationFailed, "body is required")
	}
	var envs []EnvelopeInput
	if req.Body.KeyEnvelopes != nil {
		for _, e := range *req.Body.KeyEnvelopes {
			envs = append(envs, fromAPIEnvelope(e))
		}
	}
	v, err := h.svc.Create(ctx, auth.MustPrincipal(ctx).UserID, deref(req.Params.IdempotencyKey), req.Body.Name, string(req.Body.Kind), envs)
	if err != nil {
		return nil, err
	}
	return api.CreateVault201JSONResponse(ToAPI(v)), nil
}

// GetVault implements GET /vaults/{vaultId}.
func (h *HTTP) GetVault(ctx context.Context, req api.GetVaultRequestObject) (api.GetVaultResponseObject, error) {
	v, err := h.svc.Open(ctx, auth.MustPrincipal(ctx).UserID, req.VaultId)
	if err != nil {
		return nil, err
	}
	return api.GetVault200JSONResponse(ToAPI(v)), nil
}

// UpdateVault implements PATCH /vaults/{vaultId}.
func (h *HTTP) UpdateVault(ctx context.Context, req api.UpdateVaultRequestObject) (api.UpdateVaultResponseObject, error) {
	if req.Body == nil {
		return nil, httpproblem.Errorf(syncproto.CodeValidationFailed, "body is required")
	}
	v, err := h.svc.Rename(ctx, auth.MustPrincipal(ctx).UserID, req.VaultId, req.Body.Name)
	if err != nil {
		return nil, err
	}
	return api.UpdateVault200JSONResponse(ToAPI(v)), nil
}

// DeleteVault implements DELETE /vaults/{vaultId}.
func (h *HTTP) DeleteVault(ctx context.Context, req api.DeleteVaultRequestObject) (api.DeleteVaultResponseObject, error) {
	if err := h.svc.Delete(ctx, auth.MustPrincipal(ctx).UserID, req.VaultId); err != nil {
		return nil, err
	}
	return api.DeleteVault204Response{}, nil
}

// RestoreVault implements POST /vaults/{vaultId}:restore.
func (h *HTTP) RestoreVault(ctx context.Context, req api.RestoreVaultRequestObject) (api.RestoreVaultResponseObject, error) {
	v, err := h.svc.Restore(ctx, auth.MustPrincipal(ctx).UserID, req.VaultId)
	if err != nil {
		return nil, err
	}
	return api.RestoreVault200JSONResponse(ToAPI(v)), nil
}

// GetVaultTree implements GET /vaults/{vaultId}/tree. The manifest is
// streamed: the snapshot stays open while the response is written, and is
// closed when the request ends even if the response is never written.
func (h *HTTP) GetVaultTree(ctx context.Context, req api.GetVaultTreeRequestObject) (api.GetVaultTreeResponseObject, error) {
	t, err := h.svc.OpenTree(ctx, auth.MustPrincipal(ctx).UserID, req.VaultId, deref(req.Params.Scope))
	if err != nil {
		return nil, err
	}
	context.AfterFunc(ctx, t.Close)
	return treeResponse{ctx: ctx, tree: t}, nil
}

// treeResponse writes the Tree document ({"as_of_seq":…,"as_of_id":…,"items":[…]}) entry
// by entry. A database error midway truncates the document: the client sees
// invalid JSON and retries, as with any interrupted transfer.
type treeResponse struct {
	ctx  context.Context
	tree *TreeStream
}

func (r treeResponse) VisitGetVaultTreeResponse(w http.ResponseWriter) error {
	defer r.tree.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	bw := bufio.NewWriterSize(w, 64<<10)
	head := fmt.Sprintf(`{"as_of_seq":%d,`, r.tree.AsOfSeq)
	if r.tree.AsOfID != uuid.Nil {
		head += fmt.Sprintf(`"as_of_id":%q,`, r.tree.AsOfID.String())
	}
	if _, err := bw.WriteString(head + `"items":[`); err != nil {
		return err
	}
	first := true
	err := r.tree.Each(r.ctx, func(e TreeEntry) error {
		b, err := json.Marshal(api.TreeEntry{Path: e.Path, FileId: e.ID, Rev: int(e.Rev), Hash: e.Hash, Size: e.Size, Kind: e.Kind})
		if err != nil {
			return err
		}
		if !first {
			if err := bw.WriteByte(','); err != nil {
				return err
			}
		}
		first = false
		_, err = bw.Write(b)
		return err
	})
	if err != nil {
		_ = bw.Flush()
		return err
	}
	if _, err := bw.WriteString("]}\n"); err != nil {
		return err
	}
	return bw.Flush()
}

// GetKeyEnvelopes implements GET /vaults/{vaultId}/key-envelopes.
func (h *HTTP) GetKeyEnvelopes(ctx context.Context, req api.GetKeyEnvelopesRequestObject) (api.GetKeyEnvelopesResponseObject, error) {
	envs, err := h.svc.Envelopes(ctx, auth.MustPrincipal(ctx).UserID, req.VaultId)
	if err != nil {
		return nil, err
	}
	items := make([]api.KeyEnvelope, 0, len(envs))
	for _, e := range envs {
		items = append(items, toAPIEnvelope(e))
	}
	return api.GetKeyEnvelopes200JSONResponse{Items: items}, nil
}

// PutKeyEnvelope implements PUT /vaults/{vaultId}/key-envelopes/{kind}.
func (h *HTTP) PutKeyEnvelope(ctx context.Context, req api.PutKeyEnvelopeRequestObject) (api.PutKeyEnvelopeResponseObject, error) {
	if req.Body == nil {
		return nil, httpproblem.Errorf(syncproto.CodeValidationFailed, "body is required")
	}
	if string(req.Body.Kind) != string(req.Kind) {
		return nil, httpproblem.Errorf(syncproto.CodeValidationFailed, "body kind %q does not match the path", req.Body.Kind)
	}
	e, err := h.svc.PutEnvelope(ctx, auth.MustPrincipal(ctx).UserID, req.VaultId, fromAPIEnvelope(*req.Body))
	if err != nil {
		return nil, err
	}
	return api.PutKeyEnvelope200JSONResponse(toAPIEnvelope(e)), nil
}

func fromAPIEnvelope(e api.KeyEnvelopeInput) EnvelopeInput {
	k := KDF{Alg: string(e.Kdf.Alg), Salt: e.Kdf.Salt}
	if e.Kdf.T != nil {
		k.T = *e.Kdf.T
	}
	if e.Kdf.MKib != nil {
		k.MKiB = *e.Kdf.MKib
	}
	if e.Kdf.P != nil {
		k.P = *e.Kdf.P
	}
	return EnvelopeInput{Kind: string(e.Kind), KDF: k, WrappedVMK: e.WrappedVmk}
}

func toAPIEnvelope(e Envelope) api.KeyEnvelope {
	kdf := api.KdfParams{Alg: api.KdfParamsAlg(e.KDF.Alg), Salt: e.KDF.Salt}
	if e.KDF.T != 0 {
		kdf.T = &e.KDF.T
	}
	if e.KDF.MKiB != 0 {
		kdf.MKib = &e.KDF.MKiB
	}
	if e.KDF.P != 0 {
		kdf.P = &e.KDF.P
	}
	return api.KeyEnvelope{Kind: api.KeyEnvelopeKind(e.Kind), Kdf: kdf, WrappedVmk: e.WrappedVMK, CreatedAt: e.CreatedAt}
}

var _ = openapi_types.UUID{}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
