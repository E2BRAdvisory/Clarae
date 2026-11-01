//go:build !js

package main

// The desktop core runs in the browser only (see doc.go): on any other platform there is nothing
// to run, build it with GOOS=js GOARCH=wasm.

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "memobrain-core runs as WebAssembly only: build with GOOS=js GOARCH=wasm (task wasm-core)")
	os.Exit(2)
}
