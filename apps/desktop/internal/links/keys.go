package links

import (
	"path"
	"strings"
)

// Link keys let a change of the file set re-resolve only the links it can
// affect, instead of every link of the vault (ResolveAll).
//
// Resolve answers from three lookups only: lowerFS (exact lower-cased paths),
// byName (lower-cased base names) and aliases (lower-cased alias text), then
// picks among what they return. The name token of a string is its lower-cased
// base name with every trailing ".md" removed. Whenever one of these lookups
// returns a file F, the token of the lookup string equals a token of F:
//
//   - lowerFS: the lookup string is F's path up to case, so the base names
//     agree;
//   - byName: the key is F's lower-cased base name, minus ".md" for a note,
//     so both strip to the same token;
//   - aliases: the lookup string is one of F's aliases up to case.
//
// So a link can resolve differently after F appears, disappears or changes its
// aliases only if one of the tokens of its lookups is a token of F (FileTokens:
// its path and its aliases). links.target_key stores that token when all the
// lookups of a link share one (nearly always: "Note", "Note.md", "dir/Note" and
// the alias "Note" all give "note"), or WildcardKey when they do not, and those
// links are re-resolved after every change.

// WildcardKey is the target_key of a link whose lookups have several tokens.
const WildcardKey = "*"

// nameToken is the lower-cased base name of s without trailing ".md" extensions.
func nameToken(s string) string {
	t := path.Base(strings.ToLower(s))
	for strings.HasSuffix(t, ".md") {
		t = t[:len(t)-len(".md")]
	}
	return t
}

// lookupTokens calls add with the token of every lookup Resolve(from, target)
// can make. It must follow Resolve step by step.
func lookupTokens(from, target string, add func(string)) {
	target = strings.TrimSpace(target)
	if target == "" {
		return // the note itself, whatever the file set
	}
	target = strings.TrimPrefix(target, "/")
	if strings.HasPrefix(target, "./") || strings.HasPrefix(target, "../") {
		joined := path.Clean(path.Join(path.Dir(from), target))
		add(nameToken(joined))
		add(nameToken(joined + ".md"))
		return
	}
	add(nameToken(target))
	add(nameToken(target + ".md"))
	if dir := path.Dir(from); dir != "." {
		add(nameToken(dir + "/" + target))
		add(nameToken(dir + "/" + target + ".md"))
	}
	key := strings.ToLower(strings.TrimSuffix(path.Base(target), ".md"))
	if path.Ext(target) != "" && !strings.HasSuffix(strings.ToLower(target), ".md") {
		key = strings.ToLower(path.Base(target))
	}
	add(nameToken(key))
	add(nameToken(target)) // the alias lookup
}

// LinkKey is the links.target_key of a link of the given kind written in
// from: the single token of its lookups, "" when it makes none (an empty
// target is the note itself) or WildcardKey. A Markdown link also covers its
// URL-unescaped target, which is what a rename resolves (see PlanRename).
func LinkKey(from, kind, target string) string {
	key, n := "", 0
	add := func(t string) {
		if n == 0 || t != key {
			key, n = t, n+1
		}
	}
	lookupTokens(from, target, add)
	if kind == "markdown" {
		lookupTokens(from, unescapeURL(target), add)
	}
	if n > 1 {
		return WildcardKey
	}
	return key
}

// FileTokens are the tokens under which a file can be found by Resolve: its
// path and each of its aliases.
func FileTokens(filePath string, aliases []string) []string {
	return append([]string{nameToken(filePath)}, AliasTokens(aliases)...)
}

// AliasTokens are the tokens of aliases (added to or removed from a note).
func AliasTokens(aliases []string) []string {
	out := make([]string, len(aliases))
	for i, a := range aliases {
		out[i] = nameToken(a)
	}
	return out
}
