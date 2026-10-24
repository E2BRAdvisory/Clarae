//go:build integration

package sync_test

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// TestRandomizedTwoDeviceConvergence throws random interleavings of edits,
// creations and renames at two devices and checks the two promises of the
// protocol: both devices converge to the same files, and no written line is
// ever lost (it survives in a file or in a conflict copy). Deletions are left
// out on purpose: a plain delete legitimately removes content (it stays in the
// server history); delete-versus-modify has its own test.
func TestRandomizedTwoDeviceConvergence(t *testing.T) {
	seeds := uint64(12)
	if n, err := strconv.Atoi(os.Getenv("NODUS_SEEDS")); err == nil && n > 0 {
		seeds = uint64(n)
	}
	for seed := uint64(1); seed <= seeds; seed++ {
		t.Run(fmt.Sprintf("seed%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewPCG(seed, seed*7919))
			v := createVault(t, "ada", fmt.Sprintf("random%d", seed))
			devs := []*device{newDevice(t, "ada", "laptop", v, nil), newDevice(t, "ada", "desktop", v, nil)}
			// expected holds the lines users wrote and did not remove themselves.
			expected := map[string]bool{}
			counter := 0
			token := func() string {
				counter++
				tok := fmt.Sprintf("tok-%d-%d", seed, counter)
				expected[tok] = true
				return tok
			}

			// A small shared starting point.
			devs[0].write("a.md", lines(4, "base-a"))
			devs[0].write("sub/b.md", lines(4, "base-b"))
			for _, tok := range []string{"base-a 1", "base-a 4", "base-b 1", "base-b 4"} {
				expected[tok] = true
			}
			devs[0].sync()
			devs[1].sync()

			for step := 0; step < 14; step++ {
				d := devs[rng.IntN(2)]
				files := sortedKeys(d.files())
				t.Logf("step %d on %s (files %v)", step, d.name, files)
				switch op := rng.IntN(10); {
				case op < 4 && len(files) > 0: // append a line
					p := files[rng.IntN(len(files))]
					tk := token()
					t.Logf("  append %s to %s", tk, p)
					d.write(p, d.read(p)+tk+"\n")
				case op < 6: // new file
					np, tk := fmt.Sprintf("n%d-%d.md", step, rng.IntN(3)), token()
					t.Logf("  new file %s with %s", np, tk)
					d.write(np, tk+"\n")
				case op < 7 && len(files) > 0: // rename
					p := files[rng.IntN(len(files))]
					if !strings.HasPrefix(p, "r") {
						to := fmt.Sprintf("r%d-%s", step, strings.ReplaceAll(p, "/", "_"))
						t.Logf("  rename %s -> %s", p, to)
						d.rename(p, to)
					}
				case op < 8 && len(files) > 0: // change the first line (may collide with the other device)
					p := files[rng.IntN(len(files))]
					ls := strings.SplitAfter(d.read(p), "\n")
					delete(expected, strings.TrimSuffix(ls[0], "\n")) // the user removed that line on purpose
					tk := token()
					t.Logf("  replace first line of %s with %s", p, tk)
					ls[0] = tk + "\n"
					d.write(p, strings.Join(ls, ""))
				default:
					t.Logf("  sync")
					d.sync()
				}
			}
			for _, d := range []*device{devs[0], devs[1], devs[0], devs[1], devs[0]} {
				d.sync()
			}

			a, b := devs[0].files(), devs[1].files()
			for p, c := range a {
				t.Logf("final A %s: %q", p, c)
			}
			for p, c := range b {
				t.Logf("final B %s: %q", p, c)
			}
			if fmt.Sprint(sortedKeys(a)) != fmt.Sprint(sortedKeys(b)) {
				for _, d := range devs {
					rows, _ := d.db.Files(ctxBackground())
					for _, r := range rows {
						t.Logf("row %s: %+v", d.name, r)
					}
				}
				t.Fatalf("file sets diverge:\nA %v\nB %v", sortedKeys(a), sortedKeys(b))
			}
			var all strings.Builder
			for p, content := range a {
				if b[p] != content {
					t.Errorf("%s differs:\nA %q\nB %q", p, content, b[p])
				}
				all.WriteString(content)
			}
			var lost []string
			for tok := range expected {
				if !strings.Contains(all.String(), tok) {
					lost = append(lost, tok)
				}
			}
			sort.Strings(lost)
			for _, tok := range lost {
				if tokenInHistory(t, devs[0], tok) {
					t.Errorf("line %q is missing from the files although the server history has it (it should have been kept)", tok)
				} else {
					t.Errorf("line %q was lost completely (not in any file nor in the server history)", tok)
				}
			}
		})
	}
}

// tokenInHistory scans every revision of every file the device knows for the token.
func tokenInHistory(t *testing.T, d *device, tok string) bool {
	t.Helper()
	ctx := ctxBackground()
	rows, err := d.db.Files(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		revs, _, err := d.client.ListRevisions(ctx, d.vaultID, r.FileID, 200, "")
		if err != nil {
			t.Fatal(err)
		}
		for _, rev := range revs {
			if rev.BlobHash == "" {
				continue
			}
			var buf strings.Builder
			if _, err := d.client.GetRevisionContent(ctx, d.vaultID, r.FileID, rev.Rev, &buf); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(buf.String(), tok) {
				return true
			}
		}
	}
	return false
}

func ctxBackground() context.Context { return context.Background() }
