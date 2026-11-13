//go:build !js

package shell

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"clarae/apps/desktop/internal/app"
)

// The core starts in ServiceStartup, before the loop of the platform runs: an error dialog asked
// there waits for ApplicationStarted (Started) and is then shown, in order, once.
func TestErrorDialogWaitsForTheStartOfTheLoop(t *testing.T) {
	h := NewHost()
	var shown []string
	h.showError = func(title, message string) { shown = append(shown, title+"|"+message) }
	ctx := context.Background()

	h.ErrorDialog(ctx, "Clarae notanda", "Cannot open the application database: boom")
	h.ErrorDialog(ctx, "Clarae notanda", "second")
	if len(shown) != 0 {
		t.Fatalf("shown before the loop runs: %v", shown)
	}
	h.Started()
	if len(shown) != 2 || shown[0] != "Clarae notanda|Cannot open the application database: boom" || shown[1] != "Clarae notanda|second" {
		t.Fatalf("shown = %v", shown)
	}
	h.Started()                     // a second signal shows nothing more
	h.ErrorDialog(ctx, "t", "late") // after the start: at once
	if len(shown) != 3 || shown[2] != "t|late" {
		t.Fatalf("shown = %v", shown)
	}
}

// Before the application is attached the host drops events and fails dialogs instead of crashing.
func TestHostBeforeAttach(t *testing.T) {
	h := NewHost()
	ctx := context.Background()
	h.Emit(ctx, "x", nil)
	h.Emit(ctx, "x", 1)
	h.OpenURL(ctx, "https://example.org")
	h.Print(ctx)
	h.ShowWindow(ctx)
	h.Quit(ctx)
	if _, err := h.OpenFile(ctx, appOpenDialog()); err == nil {
		t.Fatal("OpenFile before the application exists must fail")
	}
	if _, err := h.SaveFile(ctx, appSaveDialog()); err == nil {
		t.Fatal("SaveFile before the application exists must fail")
	}
}

func appOpenDialog() app.OpenDialog { return app.OpenDialog{Title: "t"} }
func appSaveDialog() app.SaveDialog { return app.SaveDialog{Title: "t"} }

// On Windows v3 answers a cancelled file dialog with the "cancelled by user" error of its internal
// cfd package; Host.SaveFile, OpenFile and OpenDirectory must answer ("", nil) like on the other
// systems and like v2, or "Cancel" in an export or an import is shown as a failure.
func TestDialogAnswerTurnsCancellationIntoAnEmptyPath(t *testing.T) {
	cfdCancelled := errors.New("cancelled by user") // the text of cfd.ErrorCancelled
	boom := errors.New("the dialog could not be created")
	for _, tc := range []struct {
		name     string
		path     string
		err      error
		wantPath string
		wantErr  error
	}{
		{"chosen", "/tmp/a.md", nil, "/tmp/a.md", nil},
		{"closed channel", "", nil, "", nil},
		{"cancelled", "", cfdCancelled, "", nil},
		{"cancelled and wrapped", "", fmt.Errorf("file dialog: %w", cfdCancelled), "", nil},
		{"real failure", "", boom, "", boom},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path, err := dialogAnswer(tc.path, tc.err)
			if path != tc.wantPath || !errors.Is(err, tc.wantErr) || (tc.wantErr == nil && err != nil) {
				t.Fatalf("dialogAnswer(%q, %v) = %q, %v; want %q, %v", tc.path, tc.err, path, err, tc.wantPath, tc.wantErr)
			}
		})
	}
}
