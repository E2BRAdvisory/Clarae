//go:build race

package main

// The race detector makes the large uploads of bridge_upload_test.go about ten times slower: under
// it the test keeps to the size that failed on the transport of Wails.
const largeUploadMiB = 65
