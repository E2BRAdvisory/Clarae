//go:build !js

// Command bindings writes packages/workbench/wailsjs, the TypeScript the UI calls the Go core through
// (`task gen`, ADR-0045 §5, ADR-0051 B-D3): go/<package>/<Service>.{js,d.ts} and go/models.ts, reflected from
// App.Services, and runtime/, the Wails JavaScript runtime wrapper. The tree is the one `wails generate
// module` wrote; scripts/gen-core-client.mjs derives web/src/workbench/core.gen.ts from it.
//
// Run from apps/desktop: go run ./internal/app/gen/bindings [-root ../..] [-out dir] [-check]
package main

import (
	"bytes"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/app"
)

// Output is the generated tree, relative to the repository root.
const Output = "packages/workbench/wailsjs"

// owned are the directories of the tree this command writes and so cleans: anything else in wailsjs stays.
var owned = []string{"go", "runtime"}

func main() {
	root := flag.String("root", "../..", "repository root")
	out := flag.String("out", "", "directory to write instead of <root>/"+Output)
	check := flag.Bool("check", false, "fail when the tree is out of date instead of writing it")
	flag.Parse()

	// Only the types of the services matter: nothing of the application is started.
	services := app.New(app.Options{Logger: zerolog.Nop(), Version: "gen"}).Services()
	files, err := Generate(services)
	if err != nil {
		log.Fatal(err)
	}
	dir := *out
	if dir == "" {
		dir = filepath.Join(*root, filepath.FromSlash(Output))
	}
	if *check {
		if stale, err := diff(dir, files); err != nil {
			log.Fatal(err)
		} else if len(stale) > 0 {
			log.Fatalf("%s is out of date (%s): run `task gen`", Output, strings.Join(stale, ", "))
		}
		return
	}
	wrote, err := write(dir, files)
	if err != nil {
		log.Fatal(err)
	}
	if wrote > 0 {
		log.Printf("wrote %d files of %s", wrote, dir)
	}
}

// existing lists the files under the owned directories of dir, slash separated and relative to dir.
func existing(dir string) ([]string, error) {
	var found []string
	for _, sub := range owned {
		err := filepath.WalkDir(filepath.Join(dir, sub), func(p string, d os.DirEntry, err error) error {
			if err != nil {
				if os.IsNotExist(err) {
					return nil
				}
				return err
			}
			if !d.IsDir() {
				rel, err := filepath.Rel(dir, p)
				if err != nil {
					return err
				}
				found = append(found, filepath.ToSlash(rel))
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	sort.Strings(found)
	return found, nil
}

// diff names the files whose content differs from files, were added, or would be removed.
func diff(dir string, files map[string][]byte) ([]string, error) {
	var stale []string
	for name, want := range files {
		got, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
		if err != nil || !bytes.Equal(got, want) {
			stale = append(stale, name)
		}
	}
	present, err := existing(dir)
	if err != nil {
		return nil, err
	}
	for _, name := range present {
		if _, ok := files[name]; !ok {
			stale = append(stale, name)
		}
	}
	sort.Strings(stale)
	return stale, nil
}

// write brings the owned directories of dir to files: it writes what changed and removes what is no
// longer generated (a service that was renamed or dropped). It returns the number of files written.
func write(dir string, files map[string][]byte) (int, error) {
	present, err := existing(dir)
	if err != nil {
		return 0, err
	}
	for _, name := range present {
		if _, ok := files[name]; !ok {
			if err := os.Remove(filepath.Join(dir, filepath.FromSlash(name))); err != nil {
				return 0, err
			}
		}
	}
	wrote := 0
	for _, name := range sortedKeys(files) {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, files[name]) {
			continue // unchanged: keep the timestamp
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return wrote, err
		}
		if err := os.WriteFile(path, files[name], 0o644); err != nil {
			return wrote, fmt.Errorf("write %s: %w", name, err)
		}
		wrote++
	}
	removeEmptyDirs(dir)
	return wrote, nil
}

// removeEmptyDirs drops the directories of the owned trees that no file is left in.
func removeEmptyDirs(dir string) {
	for _, sub := range owned {
		var dirs []string
		_ = filepath.WalkDir(filepath.Join(dir, sub), func(p string, d os.DirEntry, err error) error {
			if err == nil && d.IsDir() {
				dirs = append(dirs, p)
			}
			return nil
		})
		for i := len(dirs) - 1; i >= 0; i-- {
			_ = os.Remove(dirs[i]) // fails, and is skipped, while the directory has files
		}
	}
}
