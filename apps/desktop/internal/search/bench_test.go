package search_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/indexer"
	"clarae/apps/desktop/internal/search"
	"clarae/apps/desktop/internal/store"
	"clarae/apps/desktop/internal/vault"
)

// BenchmarkQuery builds a synthetic vault and measures indexing and query
// latency. Size via CLARAE_BENCH_NOTES (default 2000; the target of Appendix A
// is 50000: index < 3 min, query < 200 ms):
//
//	CLARAE_BENCH_NOTES=50000 go test -run xxx -bench Query -benchtime 1x ./internal/search/
func BenchmarkQuery(b *testing.B) {
	n := 2000
	if v := os.Getenv("CLARAE_BENCH_NOTES"); v != "" {
		n, _ = strconv.Atoi(v)
	}
	ctx := context.Background()
	root := b.TempDir()
	fsys, _ := vault.NewFS(root)
	words := strings.Fields("alpha beta gamma delta epsilon project budget review meeting notes plan risk task idea journal client invoice roadmap")
	for i := 0; i < n; i++ {
		var sb strings.Builder
		fmt.Fprintf(&sb, "---\nstatus: %s\namount: %d\ntags: [t%d]\n---\n# Note %d\n\n", []string{"active", "done"}[i%2], i%5000, i%50, i)
		for l := 0; l < 12; l++ {
			for w := 0; w < 10; w++ {
				sb.WriteString(words[(i*7+l*3+w)%len(words)])
				sb.WriteByte(' ')
			}
			if l%4 == 0 {
				fmt.Fprintf(&sb, "[[Note %d]] ", (i+l)%n)
			}
			sb.WriteByte('\n')
		}
		if _, err := fsys.WriteFile(fmt.Sprintf("folder%d/note%d.md", i%40, i), []byte(sb.String()), "", false); err != nil {
			b.Fatal(err)
		}
	}
	db, err := store.Open(ctx, filepath.Join(root, ".clarae", "index.db"), store.KindIndex)
	if err != nil {
		b.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	start := time.Now()
	if err := indexer.New(fsys, db, zerolog.Nop(), nil).Full(ctx); err != nil {
		b.Fatal(err)
	}
	b.Logf("indexed %d notes in %s", n, time.Since(start).Round(time.Millisecond))

	e := search.New(db)
	for _, q := range []string{"budget review", `"roadmap invoice"`, "tag:t7 plan", "[status:active] [amount:<100] risk", "line:(client invoice)", "/note \\d+7\\b/", "file:note1 -idea"} {
		b.Run(q, func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				if _, err := e.Query(ctx, q, search.Options{}); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
