package app

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// Concurrent declarations must all survive: each one is merged into the types.json it read.
func TestSetTypeKeepsConcurrentDeclarations(t *testing.T) {
	a, info, _ := newTestApp(t)
	props := NewPropertiesAPI(a)
	const n = 16
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- props.SetType(info.ID, fmt.Sprintf("key%02d", i), "number")
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	schema, err := props.Schema(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(schema) != n {
		t.Fatalf("%d of %d declarations survived: %v", len(schema), n, schema)
	}
	if err := props.SetType(info.ID, "key00", ""); err != nil {
		t.Fatal(err)
	}
	if schema, _ := props.Schema(info.ID); len(schema) != n-1 || schema["key00"] != "" {
		t.Fatalf("removal: %v", schema)
	}
	if err := props.SetType(info.ID, "never-declared", ""); err != nil {
		t.Fatalf("removing an undeclared key: %v", err)
	}
}

// A types.json that cannot be parsed is not replaced by one holding the new key only.
func TestSetTypeRefusesAnUnreadableSchema(t *testing.T) {
	a, info, root := newTestApp(t)
	p := filepath.Join(root, ".clarae", "types.json")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	broken := []byte(`{"due": "date", "amount": "number",`)
	if err := os.WriteFile(p, broken, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := NewPropertiesAPI(a).SetType(info.ID, "tags", "list"); err == nil {
		t.Fatal("SetType overwrote an unreadable types.json")
	}
	if got, _ := os.ReadFile(p); string(got) != string(broken) {
		t.Fatalf("types.json changed: %s", got)
	}
}
