package sync

import (
	"context"
	"errors"
	"fmt"

	"memobrain/apps/desktop/internal/sync/transport"
)

// Lifecycle of the account's cloud vaults (§2.6.1, ADR-0037 §2): rename, soft
// delete, the list of deleted vaults and restore. The server owns the vault;
// on this device a delete only disconnects the folders linked to it, whose
// files stay where they are (D-04).

// DeletedCloudVaults lists the account's soft-deleted vaults that can still be
// restored (deleted within the server's retention period; DeletedAt is set).
func (m *Manager) DeletedCloudVaults(ctx context.Context) ([]transport.Vault, error) {
	c, _, err := m.client()
	if err != nil {
		return nil, err
	}
	return c.ListDeletedVaults(ctx)
}

// RenameCloudVault renames a cloud vault (owner). The open vaults linked to it
// on this device record the new name in their link (Settings > Sync, and the
// title of a browser copy, whose folder is named by cloud id); a folder on disk
// is never renamed.
func (m *Manager) RenameCloudVault(ctx context.Context, cloudID, name string) (transport.Vault, error) {
	c, _, err := m.client()
	if err != nil {
		return transport.Vault{}, err
	}
	v, err := c.RenameVault(ctx, cloudID, name)
	if err != nil {
		return transport.Vault{}, err
	}
	for _, mv := range m.ownLinks(ctx, cloudID) {
		if err := mv.db.SetMeta(ctx, MetaVaultName, v.Name); err != nil {
			m.log.Warn().Err(err).Str("vault", mv.localID).Msg("sync: could not record the new vault name")
			continue
		}
		m.publish(mv)
	}
	return v, nil
}

// DeleteCloudVault soft-deletes a cloud vault (owner): the server keeps it,
// restorable, for its retention period. Once the server has accepted, every
// open vault of this device linked to it is disconnected like Unlink does:
// the files stay on disk, only the link and the synchronization state go. It
// returns the local ids of the vaults it disconnected.
func (m *Manager) DeleteCloudVault(ctx context.Context, cloudID string) ([]string, error) {
	c, _, err := m.client()
	if err != nil {
		return nil, err
	}
	if err := c.DeleteVault(ctx, cloudID); err != nil {
		return nil, err
	}
	var (
		unlinked []string
		errs     []error
	)
	for _, mv := range m.ownLinks(ctx, cloudID) {
		if err := m.Unlink(ctx, mv.localID); err != nil {
			errs = append(errs, fmt.Errorf("disconnect %s: %w", mv.localID, err))
			continue
		}
		unlinked = append(unlinked, mv.localID)
	}
	return unlinked, errors.Join(errs...)
}

// RestoreCloudVault undoes a soft delete within the retention period. The
// folders disconnected by the delete stay disconnected: connecting one again
// is the usual "connect to an existing vault".
func (m *Manager) RestoreCloudVault(ctx context.Context, cloudID string) (transport.Vault, error) {
	c, _, err := m.client()
	if err != nil {
		return transport.Vault{}, err
	}
	return c.RestoreVault(ctx, cloudID)
}

// ownLinks returns the open vaults linked to a cloud vault of the account's
// own (mounts of a share are not: their owner's actions reach them as a
// revocation). The link is read from each vault's sync.db, so a vault whose
// engine is not running is found as well.
func (m *Manager) ownLinks(ctx context.Context, cloudID string) []*managed {
	m.mu.Lock()
	all := make([]*managed, 0, len(m.vaults))
	for _, mv := range m.vaults {
		all = append(all, mv)
	}
	m.mu.Unlock()
	var out []*managed
	for _, mv := range all {
		cloud, err := mv.db.Meta(ctx, MetaCloudVault)
		if err != nil || cloud != cloudID {
			continue
		}
		if _, isMount, _ := readMountMeta(ctx, mv.db); isMount {
			continue
		}
		out = append(out, mv)
	}
	return out
}
