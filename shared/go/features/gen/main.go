// Command gen writes the code generated from the Config Profile schema (`task gen`):
//
//	shared/go/features/features_gen.go          Go flag constants, Known, Defaults, product defaults
//	shared/go/features/config-profile.schema.json  byte copy embedded by package features (the cloud validates with it)
//	packages/api-client/src/gen/features.ts     TypeScript `Feature` union and defaults
//
// Run from shared/go: go run ./features/gen [-root ../..]
package main

import (
	"flag"
	"log"
	"os"
	"path/filepath"

	"clarae/shared/features/internal/featuregen"
)

func main() {
	root := flag.String("root", "../..", "repository root")
	flag.Parse()
	raw, err := os.ReadFile(filepath.Join(*root, featuregen.SchemaPath))
	if err != nil {
		log.Fatal(err)
	}
	files, err := featuregen.Files(raw)
	if err != nil {
		log.Fatal(err)
	}
	for _, f := range files {
		p := filepath.Join(*root, f.Path)
		if old, err := os.ReadFile(p); err == nil && string(old) == string(f.Content) {
			continue // unchanged: keep the timestamp
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			log.Fatal(err)
		}
		if err := os.WriteFile(p, f.Content, 0o644); err != nil {
			log.Fatal(err)
		}
		log.Printf("wrote %s", f.Path)
	}
}
