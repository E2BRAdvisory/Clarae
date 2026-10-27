// Command release builds, signs and verifies the desktop update manifest.
//
//	release gen-manifest   -channel stable -version 1.0.0 -sequence 12 [-min-version 1.0.0] \
//	                       [-notes-file CHANGELOG-1.0.0.md] -artifacts-dir dist -base-url https://… -out manifest.json
//	release sign-manifest  -in manifest.json [-key-env MEMOBRAIN_UPDATE_SIGNING_KEY | -key-file path] [-out manifest.json.sig]
//	release verify-manifest -in manifest.json [-sig manifest.json.sig] -pubkey <base64> | -pubkey-file path
//	release gen-key        (prints a fresh key pair to stdout; nothing is stored)
//	release pubkey         [-key-env NAME | -key-file path]  (public key of a private key)
//	release gen-dev-key    (prints the development key pair; for tests, never for releases)
//
// The private key (base64 ed25519, 64 bytes or 32-byte seed) is read from an
// environment variable or a file path and is never written anywhere.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"memobrain/shared/updatemanifest"
)

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "release:", err)
		os.Exit(1)
	}
}

func run(args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: release gen-manifest|sign-manifest|verify-manifest|gen-key|pubkey|gen-dev-key [flags]")
	}
	switch args[0] {
	case "gen-manifest":
		return genManifest(args[1:], out)
	case "sign-manifest":
		return signManifest(args[1:], out)
	case "verify-manifest":
		return verifyManifest(args[1:], out)
	case "gen-dev-key":
		return genDevKey(out)
	case "gen-key":
		return genKey(out)
	case "pubkey":
		return pubKey(args[1:], out)
	}
	return fmt.Errorf("unknown command %q", args[0])
}

// artifactFiles maps release file names to manifest artifacts:
// memobrain-<version>-<os>-<arch>.<ext>, ext = dmg|exe(nsis)|AppImage|deb.
func classify(name string) (osName, arch, kind string, ok bool) {
	parts := strings.Split(strings.TrimSuffix(name, filepath.Ext(name)), "-")
	if len(parts) < 4 || parts[0] != "memobrain" {
		return "", "", "", false
	}
	osName, arch = parts[len(parts)-2], parts[len(parts)-1]
	switch strings.ToLower(filepath.Ext(name)) {
	case ".dmg":
		kind = updatemanifest.KindDMG
	case ".exe":
		kind = updatemanifest.KindNSIS
	case ".appimage":
		kind = updatemanifest.KindAppImage
	case ".deb":
		kind = updatemanifest.KindDeb
	default:
		return "", "", "", false
	}
	return osName, arch, kind, true
}

func genManifest(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("gen-manifest", flag.ContinueOnError)
	channel := fs.String("channel", "stable", "stable|beta")
	version := fs.String("version", "", "release version (semver, no leading v)")
	sequence := fs.Int64("sequence", 0, "monotonic manifest sequence for the channel")
	minVersion := fs.String("min-version", "", "revocation floor (optional)")
	notesFile := fs.String("notes-file", "", "Markdown release notes (optional)")
	notesURL := fs.String("notes-url", "", "release page URL (optional)")
	dir := fs.String("artifacts-dir", "", "directory with memobrain-<version>-<os>-<arch>.<ext> files")
	baseURL := fs.String("base-url", "", "public URL prefix of the artifacts")
	outPath := fs.String("out", "", "output file (default stdout)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	m := updatemanifest.Manifest{
		Schema: updatemanifest.SchemaVersion, Channel: *channel, Version: strings.TrimPrefix(*version, "v"),
		Sequence: *sequence, MinVersion: *minVersion, NotesURL: *notesURL, ReleasedAt: time.Now().UTC().Truncate(time.Second),
	}
	if *notesFile != "" {
		raw, err := os.ReadFile(*notesFile)
		if err != nil {
			return err
		}
		m.Notes = string(raw)
	}
	entries, err := os.ReadDir(*dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		osName, arch, kind, ok := classify(e.Name())
		if e.IsDir() || !ok {
			continue
		}
		sum, size, err := hashFile(filepath.Join(*dir, e.Name()))
		if err != nil {
			return err
		}
		m.Artifacts = append(m.Artifacts, updatemanifest.Artifact{
			OS: osName, Arch: arch, Kind: kind, URL: strings.TrimRight(*baseURL, "/") + "/" + e.Name(), SHA256: sum, Size: size,
		})
	}
	if err := m.Validate(); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	if *outPath == "" {
		_, err = out.Write(raw)
		return err
	}
	return os.WriteFile(*outPath, raw, 0o644) //nolint:gosec // public release metadata
}

func hashFile(path string) (string, int64, error) {
	f, err := os.Open(path) //nolint:gosec // release artifacts chosen by the operator
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	n, err := io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil)), n, err
}

func signManifest(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("sign-manifest", flag.ContinueOnError)
	in := fs.String("in", "", "manifest file")
	keyEnv := fs.String("key-env", "MEMOBRAIN_UPDATE_SIGNING_KEY", "environment variable holding the base64 private key")
	keyFile := fs.String("key-file", "", "file holding the base64 private key (overrides -key-env)")
	outPath := fs.String("out", "", "signature file (default <in>.sig)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *in == "" {
		return errors.New("-in is required")
	}
	keyB64 := os.Getenv(*keyEnv)
	if *keyFile != "" {
		raw, err := os.ReadFile(*keyFile)
		if err != nil {
			return err
		}
		keyB64 = string(raw)
	}
	if strings.TrimSpace(keyB64) == "" {
		return fmt.Errorf("no signing key: set %s or pass -key-file", *keyEnv)
	}
	priv, err := updatemanifest.ParsePrivateKey(keyB64)
	if err != nil {
		return err
	}
	manifest, err := os.ReadFile(*in)
	if err != nil {
		return err
	}
	if _, err := parseOnly(manifest); err != nil { // refuse to sign something clients would reject
		return err
	}
	sig, err := updatemanifest.Sign(priv, manifest)
	if err != nil {
		return err
	}
	dst := *outPath
	if dst == "" {
		dst = *in + ".sig"
	}
	if err := os.WriteFile(dst, []byte(sig+"\n"), 0o644); err != nil { //nolint:gosec // detached signature is public
		return err
	}
	_, err = fmt.Fprintln(out, "signed", *in, "->", dst)
	return err
}

func parseOnly(raw []byte) (*updatemanifest.Manifest, error) {
	var m updatemanifest.Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	return &m, m.Validate()
}

func verifyManifest(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("verify-manifest", flag.ContinueOnError)
	in := fs.String("in", "", "manifest file")
	sigPath := fs.String("sig", "", "signature file (default <in>.sig)")
	pub := fs.String("pubkey", "", "base64 public key")
	pubFile := fs.String("pubkey-file", "", "file holding the base64 public key")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *in == "" {
		return errors.New("-in is required")
	}
	pubB64 := *pub
	if *pubFile != "" {
		raw, err := os.ReadFile(*pubFile)
		if err != nil {
			return err
		}
		pubB64 = string(raw)
	}
	key, err := updatemanifest.ParsePublicKey(pubB64)
	if err != nil {
		return err
	}
	sp := *sigPath
	if sp == "" {
		sp = *in + ".sig"
	}
	manifest, err := os.ReadFile(*in)
	if err != nil {
		return err
	}
	sig, err := os.ReadFile(sp)
	if err != nil {
		return err
	}
	m, err := updatemanifest.VerifyAndParse(key, manifest, sig)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(out, "OK: %s %s sequence %d, %d artifact(s)\n", m.Channel, m.Version, m.Sequence, len(m.Artifacts))
	return err
}

// genKey prints a fresh random key pair to stdout; nothing is written to disk.
func genKey(out io.Writer) error {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(out, "private (UPDATE_SIGNING_KEY, keep secret): %s\npublic  (UPDATE_PUBLIC_KEY):               %s\n",
		base64.StdEncoding.EncodeToString(priv), base64.StdEncoding.EncodeToString(pub))
	return err
}

// pubKey prints the public key of the private key given by env var or file.
func pubKey(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("pubkey", flag.ContinueOnError)
	keyEnv := fs.String("key-env", "MEMOBRAIN_UPDATE_SIGNING_KEY", "environment variable holding the base64 private key")
	keyFile := fs.String("key-file", "", "file holding the base64 private key")
	if err := fs.Parse(args); err != nil {
		return err
	}
	keyB64 := os.Getenv(*keyEnv)
	if *keyFile != "" {
		raw, err := os.ReadFile(*keyFile)
		if err != nil {
			return err
		}
		keyB64 = string(raw)
	}
	priv, err := updatemanifest.ParsePrivateKey(keyB64)
	if err != nil {
		return err
	}
	pub, _ := priv.Public().(ed25519.PublicKey)
	_, err = fmt.Fprintln(out, base64.StdEncoding.EncodeToString(pub))
	return err
}

// genDevKey prints a throwaway key pair for local experiments.
func genDevKey(out io.Writer) error {
	seed := sha256.Sum256([]byte("memobrain-development-update-key-NOT-FOR-PRODUCTION"))
	priv := ed25519.NewKeyFromSeed(seed[:])
	pub, _ := priv.Public().(ed25519.PublicKey)
	_, err := fmt.Fprintf(out, "private: %s\npublic:  %s\n(development key, public by design: never sign a release with it)\n",
		base64.StdEncoding.EncodeToString(priv), base64.StdEncoding.EncodeToString(pub))
	return err
}
