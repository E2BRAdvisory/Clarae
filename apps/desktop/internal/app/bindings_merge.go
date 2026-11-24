package app

import (
	"context"
	"time"

	"clarae/shared/hashing"
	"clarae/shared/merge"
	"clarae/shared/syncproto"
)

// MergeEditResult is what MergeEdit decided.
type MergeEditResult struct {
	Strategy string `json:"strategy"` // a merge.Strategy
	Merged   string `json:"merged"`   // the merged text; empty unless Clean
	Clean    bool   `json:"clean"`    // true: Merged holds both sides, nothing to choose
}

// MergeEdit merges the unsaved text of an editor (ours) with a newer version of the same file (theirs),
// from the text the editor last loaded or saved (base), with the code of the sync (shared/go/merge) and
// the strategy its decision table gives for the kind of file (D-04). It only computes: it reads no file
// and writes none; the caller writes the merged text with WriteNote and the hash of theirs as expectedHash.
//
// Clean is false, and Merged empty, when the text cannot be merged without a choice (a note with
// conflicting hunks, a kind that is never merged, an author that is not the user's own on a shared vault,
// a text that does not parse): the caller keeps its choice between the two versions.
func (v *VaultAPI) MergeEdit(vaultID, relPath, base, ours, theirs string) (MergeEditResult, error) {
	ov, err := v.app.vault(vaultID)
	if err != nil {
		return MergeEditResult{}, err
	}
	_, path, err := ov.FS.Resolve(relPath)
	if err != nil {
		return MergeEditResult{}, bindingError(err)
	}
	sameAuthor := v.app.sync.SameAuthorOnDisk(context.Background(), vaultID, path, hashing.Sum([]byte(theirs)).Hex())
	// By path, as the sync decides (resolve.go): a template of the vault is merged as what it holds.
	strategy := merge.DecideByPath(path, syncproto.KindOf(path), sameAuthor, merge.ChangeModify, merge.ChangeModify)

	b, o, t := []byte(base), []byte(ours), []byte(theirs)
	var res merge.Result
	switch strategy {
	case merge.StrategyMarkdown3Way:
		res = merge.Markdown(b, o, t)
	case merge.StrategyExcalidrawID:
		res, err = merge.Excalidraw(b, o, t)
	case merge.StrategyCanvasID:
		res, err = merge.Canvas(b, o, t, merge.Options{TheirsTime: time.Now()})
	default:
		return MergeEditResult{Strategy: string(strategy)}, nil // nothing to merge: the caller chooses
	}
	if err != nil {
		// Content that does not parse is not an error of the call: it is what the sync does too (a conflict copy).
		return MergeEditResult{Strategy: string(merge.StrategyConflictCopy)}, nil
	}
	if !res.Clean {
		return MergeEditResult{Strategy: string(strategy)}, nil
	}
	return MergeEditResult{Strategy: string(strategy), Merged: string(res.Merged), Clean: true}, nil
}
