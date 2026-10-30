//go:build !js

// Command memobrain-core is the desktop core compiled to WebAssembly for the browser (ADR-0030).
// On any other platform there is nothing to run: build it with GOOS=js GOARCH=wasm.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "memobrain-core runs as WebAssembly only: build with GOOS=js GOARCH=wasm (task wasm-core)")
	os.Exit(2)
}
