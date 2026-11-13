// Package envcompat reads the environment variables of the product, which changed prefix with
// the rebrand to Clarae notanda (ADR-0052): CLARAE_<name> is the variable, MEMOBRAIN_<name> is
// still read when the first is not set, so that the environment of an installation made for 1.x
// keeps working. The callers warn when the old name is the one in use.
package envcompat

import "os"

const (
	// Prefix is the prefix of the product's environment variables.
	Prefix = "CLARAE_"
	// LegacyPrefix is the prefix they had up to 1.x.
	LegacyPrefix = "MEMOBRAIN_"
)

// Lookup returns the value of CLARAE_<name>, or the value of MEMOBRAIN_<name> when the first is
// not set or empty. deprecated is true when the value comes from the old name.
func Lookup(name string) (value string, deprecated bool) {
	if v := os.Getenv(Prefix + name); v != "" {
		return v, false
	}
	v := os.Getenv(LegacyPrefix + name)
	return v, v != ""
}

// Get is Lookup without the deprecation flag.
func Get(name string) string {
	v, _ := Lookup(name)
	return v
}
