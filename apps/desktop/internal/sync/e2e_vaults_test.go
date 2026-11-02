//go:build integration

package sync_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	syncpkg "memobrain/apps/desktop/internal/sync"
	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/shared/syncproto"
)

func listed(vs []transport.Vault, id string) bool {
	for _, v := range vs {
		if v.Id.String() == id {
			return true
		}
	}
	return false
}

// A vault deleted by another client (the console, another device) disconnects the folder linked
// on this device at its next cycle, keeping its files, as a delete made from this device does.
func TestManagerCloudVaultDeletedElsewhere(t *testing.T) {
	ctx := context.Background()
	ada := newManagerEnv(t, "ada")
	dir := filepath.Join(ada.root, "vault")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	note := filepath.Join(dir, "plan.md")
	if err := os.WriteFile(note, []byte("the plan"), 0o644); err != nil {
		t.Fatal(err)
	}
	ada.openVault(t, "v1", dir)
	res, err := ada.m.Link(ctx, "v1", fmt.Sprintf("DeletedElsewhere-%d", time.Now().UnixNano()), "shared", "")
	if err != nil {
		t.Fatal(err)
	}
	client := newClient(t, "ada")
	eventually(t, "the first upload", func() bool {
		v, err := client.GetVault(ctx, res.CloudVaultID)
		return err == nil && v.FileCount == 1
	})

	if err := client.DeleteVault(ctx, res.CloudVaultID); err != nil { // another client deletes it
		t.Fatal(err)
	}
	eventually(t, "the folder to be disconnected", func() bool {
		_ = ada.m.SyncNow("v1") // no realtime stream in this test
		info, _ := ada.m.Info(ctx, "v1")
		return !info.Linked
	})
	if ada.emitted(syncpkg.EventCloudVaultDeleted) != 1 {
		t.Fatalf("%s emitted %d times", syncpkg.EventCloudVaultDeleted, ada.emitted(syncpkg.EventCloudVaultDeleted))
	}
	if b, err := os.ReadFile(note); err != nil || string(b) != "the plan" {
		t.Fatalf("local file after the delete: %q, %v", b, err)
	}
	// Still restorable: the server kept it.
	if _, err := ada.m.RestoreCloudVault(ctx, res.CloudVaultID); err != nil {
		t.Fatal(err)
	}
}

// The lifecycle of a cloud vault through the manager (ADR-0037 §2): rename,
// soft delete, the list of deleted vaults and restore, against the real cloud.
// Deleting disconnects the folder linked on this device and keeps its files.
func TestManagerCloudVaultLifecycle(t *testing.T) {
	ctx := context.Background()
	ada := newManagerEnv(t, "ada")
	dir := filepath.Join(ada.root, "vault")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	note := filepath.Join(dir, "plan.md")
	if err := os.WriteFile(note, []byte("the plan"), 0o644); err != nil {
		t.Fatal(err)
	}
	ada.openVault(t, "v1", dir)
	name := fmt.Sprintf("Lifecycle-%d", time.Now().UnixNano())
	res, err := ada.m.Link(ctx, "v1", name, "shared", "")
	if err != nil {
		t.Fatal(err)
	}
	cloud := res.CloudVaultID
	client := newClient(t, "ada")
	eventually(t, "the first upload", func() bool {
		v, err := client.GetVault(ctx, cloud)
		return err == nil && v.FileCount == 1
	})

	// Rename: the server and the local link take the new name; the folder keeps its own.
	renamed, err := ada.m.RenameCloudVault(ctx, cloud, name+"-renamed")
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Name != name+"-renamed" {
		t.Fatalf("renamed = %q", renamed.Name)
	}
	if info, _ := ada.m.Info(ctx, "v1"); info.Name != name+"-renamed" {
		t.Fatalf("local link name = %q", info.Name)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("the folder moved: %v", err)
	}

	// Delete: gone from the list, listed as deleted, the folder disconnected with its files.
	deleted, err := ada.m.DeletedCloudVaults(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if listed(deleted, cloud) {
		t.Fatal("a live vault is listed as deleted")
	}
	unlinked, err := ada.m.DeleteCloudVault(ctx, cloud)
	if err != nil {
		t.Fatal(err)
	}
	if len(unlinked) != 1 || unlinked[0] != "v1" {
		t.Fatalf("unlinked = %v, want [v1]", unlinked)
	}
	if info, _ := ada.m.Info(ctx, "v1"); info.Linked {
		t.Fatalf("the folder is still linked: %+v", info)
	}
	if b, err := os.ReadFile(note); err != nil || string(b) != "the plan" {
		t.Fatalf("local file after the delete: %q, %v", b, err)
	}
	live, err := ada.m.CloudVaults(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if listed(live, cloud) {
		t.Fatal("a deleted vault is still listed")
	}
	deleted, err = ada.m.DeletedCloudVaults(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !listed(deleted, cloud) {
		t.Fatal("the deleted vault is not listed as deleted")
	}
	for _, v := range deleted {
		if v.Id.String() == cloud && v.DeletedAt == nil {
			t.Fatal("a deleted vault without deleted_at")
		}
	}
	// Another user never sees it, nor restores it.
	if _, err := newClient(t, "bob").RestoreVault(ctx, cloud); !transport.IsCode(err, syncproto.CodeNotFound) {
		t.Fatalf("restore by another user: %v, want NOT_FOUND", err)
	}

	// Restore: listed again, with its content; the folder stays disconnected.
	restored, err := ada.m.RestoreCloudVault(ctx, cloud)
	if err != nil {
		t.Fatal(err)
	}
	if restored.DeletedAt != nil || restored.FileCount != 1 {
		t.Fatalf("restored = %+v", restored)
	}
	live, err = ada.m.CloudVaults(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !listed(live, cloud) {
		t.Fatal("the restored vault is not listed")
	}
	if info, _ := ada.m.Info(ctx, "v1"); info.Linked {
		t.Fatal("restoring reconnected the folder by itself")
	}
}

// A vault whose name was taken while it was deleted cannot be restored before
// the other one is renamed (NAME_IN_USE).
func TestRestoreCloudVaultNameInUse(t *testing.T) {
	ctx := context.Background()
	ada := newManagerEnv(t, "ada")
	client := newClient(t, "ada")
	name := fmt.Sprintf("Taken-%d", time.Now().UnixNano())
	first, err := client.CreateVault(ctx, name, "shared", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ada.m.DeleteCloudVault(ctx, first.Id.String()); err != nil {
		t.Fatal(err)
	}
	second, err := client.CreateVault(ctx, name, "shared", nil)
	if err != nil {
		t.Skipf("the name of a deleted vault stays reserved (%v): nothing to check", err)
	}
	if _, err := ada.m.RestoreCloudVault(ctx, first.Id.String()); !transport.IsCode(err, syncproto.CodeNameInUse) {
		t.Fatalf("restore over a taken name: %v, want NAME_IN_USE", err)
	}
	if _, err := ada.m.RenameCloudVault(ctx, second.Id.String(), name+"-2"); err != nil {
		t.Fatal(err)
	}
	if _, err := ada.m.RestoreCloudVault(ctx, first.Id.String()); err != nil {
		t.Fatalf("restore after the rename: %v", err)
	}
}
