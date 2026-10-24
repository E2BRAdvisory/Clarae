// Package merge reconciles concurrent edits of the same file (§3.4.5). The
// server never merges: this code runs on the client (and is shared with the
// conformance suite), so the protocol is identical for private and shared
// vaults.
//
// Every merge takes the common ancestor (base), the local content (ours) and
// the remote content (theirs) and returns a Result. A Clean result needs
// nothing more. A result that is not clean still carries the best merged
// content (conflicting regions resolved in favor of the server) and says which
// side must additionally be saved as a conflict copy.
package merge

import "time"

// Side names one of the two versions being merged.
type Side string

// Sides.
const (
	None   Side = ""
	Ours   Side = "ours"
	Theirs Side = "theirs"
)

// Hunk describes one region that could not be merged automatically.
type Hunk struct {
	// Where is a human-readable locator ("frontmatter key status", "lines 12-14").
	Where  string `json:"where"`
	Ours   string `json:"ours"`
	Theirs string `json:"theirs"`
}

// Result is the outcome of a merge.
type Result struct {
	Merged    []byte `json:"-"`
	Clean     bool   `json:"clean"`
	Conflicts []Hunk `json:"conflicts,omitempty"`
	// CopyOf names the side whose complete content must be saved as a
	// conflict copy; None when Clean.
	CopyOf Side `json:"copyOf,omitempty"`
}

// Options carry the server-authoritative timestamps some strategies need.
type Options struct {
	// OursTime is when the local change will be committed (zero = now: a
	// pending local change is newer than anything already on the server).
	OursTime time.Time
	// TheirsTime is the server time of the remote revision.
	TheirsTime time.Time
}

func (o Options) oursNewer() bool {
	if o.OursTime.IsZero() {
		return true
	}
	return o.OursTime.After(o.TheirsTime)
}
