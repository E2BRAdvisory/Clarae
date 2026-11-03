package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"memobrain/apps/desktop/internal/importer"
	syncpkg "memobrain/apps/desktop/internal/sync"
)

func TestImporterRunEmitsEventsAndTheWatcherIndexesTheNotes(t *testing.T) {
	a, info, root := newTestApp(t)
	var mu sync.Mutex
	var progress, done []any
	a.setEmitter(func(name string, p any) {
		mu.Lock()
		defer mu.Unlock()
		switch name {
		case EventImportProgress.Name():
			progress = append(progress, p)
		case EventImportDone.Name():
			done = append(done, p)
		}
	})
	api := NewImporterAPI(a)
	if ids := api.Detect("../importer/testdata/mdfolder"); len(ids) == 0 || ids[0] != "markdown-folder" {
		t.Fatalf("detect: %v", ids)
	}
	pv, err := api.Preview(info.ID, "markdown-folder", "../importer/testdata/mdfolder", importer.Options{TargetFolder: "Imported", UseWikilinks: true})
	if err != nil || pv.Notes != 5 {
		t.Fatalf("preview: %+v %v", pv, err)
	}
	if _, err := os.Stat(filepath.Join(root, "Imported")); err == nil {
		t.Fatal("preview wrote to the vault")
	}
	id, err := api.Run(info.ID, "markdown-folder", "../importer/testdata/mdfolder", importer.Options{TargetFolder: "Imported", UseWikilinks: true})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		mu.Lock()
		n := len(done)
		mu.Unlock()
		if n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no importer:done event")
		}
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	payload := done[0].(ImportDonePayload)
	mu.Unlock()
	if !payload.OK || payload.JobID != id || payload.Report == nil || payload.Report.NotesCreated != 5 {
		t.Fatalf("done: %+v", payload)
	}
	rep, err := api.Report(id)
	if err != nil || rep.ReportPath != "Imported/Import report.md" {
		t.Fatalf("report: %+v %v", rep, err)
	}
	if _, err := api.Report(id); err == nil || !strings.HasPrefix(err.Error(), "not-found:") {
		t.Fatalf("a report read once must be forgotten: %v", err)
	}
	if b, err := os.ReadFile(filepath.Join(root, "Imported", "Index.md")); err != nil || !strings.Contains(string(b), "[[Second note#Part two]]") {
		t.Fatalf("note: %v %s", err, b)
	}
	// 5 notes + the report note are picked up by the file watcher, without any explicit call.
	waitIndexed(t, a, info.ID, 6)
	mu.Lock()
	defer mu.Unlock()
	if len(progress) == 0 {
		t.Error("no progress events")
	}
}

func TestImporterCancelAndBusy(t *testing.T) {
	a, info, _ := newTestApp(t)
	a.emitter = func(string, any) {}
	api := NewImporterAPI(a)
	api.mu.Lock()
	api.jobs["j"] = &importJob{vaultID: info.ID, cancel: func() {}}
	api.mu.Unlock()
	if _, err := api.Run(info.ID, "markdown-folder", "../importer/testdata/mdfolder", importer.Options{}); err == nil || !strings.HasPrefix(err.Error(), "busy:") {
		t.Fatalf("a second import in the same vault: %v", err)
	}
	if err := api.Cancel("j"); err != nil {
		t.Fatal(err)
	}
	if err := api.Cancel("nope"); err == nil {
		t.Fatal("unknown job")
	}
	if _, err := api.Run(info.ID, "nope", "x", importer.Options{}); err == nil {
		t.Fatal("unknown source")
	}
}

func TestImporterRefusesViewerMounts(t *testing.T) {
	a, _, _ := newTestApp(t)
	ctx := context.Background()
	dir := filepath.Join(a.mountsDir(), "share-9")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	mm := syncpkg.MountMeta{ShareID: "share-9", CloudVaultID: "cloud-9", Scope: "share:share-9", Permission: syncpkg.PermViewer, Name: "Docs", OwnerName: "ada", ResourceType: "folder"}
	if err := syncpkg.PrepareMount(ctx, dir, mm, syncpkg.SessionInfo{ServerURL: "http://cloud.test"}); err != nil {
		t.Fatal(err)
	}
	info, err := a.openVault(dir)
	if err != nil {
		t.Fatal(err)
	}
	_, err = NewImporterAPI(a).Run(info.ID, "markdown-folder", "../importer/testdata/mdfolder", importer.Options{TargetFolder: "Imported"})
	if err == nil || !strings.HasPrefix(err.Error(), "read-only:") {
		t.Fatalf("import into a viewer mount: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "Imported")); err == nil {
		t.Fatal("wrote into a read-only mount")
	}
}

func TestImporterForgetsFinishedJobs(t *testing.T) {
	a, _, _ := newTestApp(t)
	api := NewImporterAPI(a)
	now := time.Now()
	api.mu.Lock()
	api.jobs["running"] = &importJob{cancel: func() {}}
	api.jobs["stale"] = &importJob{done: true, finished: now.Add(-finishedImportTTL - time.Second), report: &importer.Report{}}
	for n := range maxFinishedImports + 2 {
		api.jobs[fmt.Sprintf("job%d", n)] = &importJob{done: true, finished: now.Add(time.Duration(n-10) * time.Second), report: &importer.Report{}}
	}
	api.pruneLocked(now)
	var left []string
	for id := range api.jobs {
		left = append(left, id)
	}
	api.mu.Unlock()
	sort.Strings(left)
	want := []string{"running"}
	for n := 2; n < maxFinishedImports+2; n++ {
		want = append(want, fmt.Sprintf("job%d", n))
	}
	sort.Strings(want)
	if strings.Join(left, ",") != strings.Join(want, ",") {
		t.Fatalf("kept %v, want %v", left, want)
	}
	if _, err := api.Report("running"); err == nil || !strings.HasPrefix(err.Error(), "busy:") {
		t.Fatalf("a running job: %v", err)
	}
	if _, err := api.Report("job5"); err != nil {
		t.Fatal(err)
	}
	if _, err := api.Report("job5"); err == nil {
		t.Fatal("a report read once must be forgotten")
	}
}
