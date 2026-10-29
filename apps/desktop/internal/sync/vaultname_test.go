package sync

import (
	"context"
	"testing"
)

func TestReadVaultName(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	if got := ReadVaultName(ctx, root); got != "" {
		t.Fatalf("an unlinked folder has no cloud name, got %q", got)
	}
	mm := MountMeta{ShareID: "s1", CloudVaultID: "c1", Scope: "share:s1", Permission: PermViewer, Name: "Team docs", OwnerName: "ada", ResourceType: "folder"}
	if err := PrepareMount(ctx, root, mm, SessionInfo{ServerURL: "http://cloud.test"}); err != nil {
		t.Fatal(err)
	}
	if got := ReadVaultName(ctx, root); got != "Team docs" {
		t.Fatalf("ReadVaultName = %q, want the cloud name", got)
	}
}
