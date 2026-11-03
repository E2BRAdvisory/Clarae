//go:build !js

// Command events writes packages/workbench/src/app/events.gen.ts from the registry of
// internal/app/events_registry.go (`task gen`, ADR-0045 §5): the names of the Go → TypeScript events and
// their payload types, derived from the json tags of the Go structs.
//
// Run from apps/desktop: go run ./internal/app/gen/events [-root ../..] [-check]
package main

import (
	"bytes"
	"flag"
	"log"
	"os"
	"path/filepath"

	"memobrain/apps/desktop/internal/app"
	"memobrain/apps/desktop/internal/events"
)

// Output is the generated file, relative to the repository root.
const Output = "packages/workbench/src/app/events.gen.ts"

func main() {
	root := flag.String("root", "../..", "repository root")
	check := flag.Bool("check", false, "fail when the file is out of date instead of writing it")
	flag.Parse()
	out, err := events.TypeScript(app.Events, app.EventEnums)
	if err != nil {
		log.Fatal(err)
	}
	p := filepath.Join(*root, Output)
	if old, err := os.ReadFile(p); err == nil && bytes.Equal(old, out) {
		return // unchanged: keep the timestamp
	}
	if *check {
		log.Fatalf("%s is out of date: run `task gen`", Output)
	}
	if err := os.WriteFile(p, out, 0o644); err != nil {
		log.Fatal(err)
	}
	log.Printf("wrote %s", Output)
}
