package merge

import "clarae/shared/syncproto"

// Strategy is what the sync engine does with a candidate conflict.
type Strategy string

// Strategies (§3.4.5 decision table).
const (
	StrategyMarkdown3Way  Strategy = "markdown-3way"
	StrategyExcalidrawID  Strategy = "excalidraw-by-id"
	StrategyCanvasID      Strategy = "canvas-by-id"
	StrategyConfigLWW     Strategy = "config-lww"
	StrategyLastWriteWins Strategy = "last-write-wins"
	StrategyConflictCopy  Strategy = "conflict-copy"
	// StrategyKeepModification: delete vs modify, the modification wins and the
	// file is restored.
	StrategyKeepModification Strategy = "keep-modification"
	// StrategyApplyBoth: rename vs modify (identity by file_id).
	StrategyApplyBoth Strategy = "apply-both"
	// StrategyFirstWinsRemap: rename vs rename, the first commit wins.
	StrategyFirstWinsRemap Strategy = "first-wins-remap"
	// StrategyRenameSecond: create vs create on the same path, the second
	// becomes "name (1).ext".
	StrategyRenameSecond Strategy = "rename-second"
)

// Change is what one side did to a file since the common ancestor.
type Change string

// Kinds of side changes.
const (
	ChangeModify Change = "modify"
	ChangeDelete Change = "delete"
	ChangeMove   Change = "move"
	ChangeCreate Change = "create"
)

// Decide returns the strategy for a file that both sides changed. sameAuthor
// is true when both changes come from the same user (other devices of that
// user count as the same author).
func Decide(kind syncproto.FileKind, sameAuthor bool, ours, theirs Change) Strategy {
	switch {
	case ours == ChangeCreate && theirs == ChangeCreate:
		return StrategyRenameSecond
	case ours == ChangeMove && theirs == ChangeMove:
		return StrategyFirstWinsRemap
	case (ours == ChangeDelete && theirs == ChangeModify) || (ours == ChangeModify && theirs == ChangeDelete):
		return StrategyKeepModification
	case (ours == ChangeMove && theirs == ChangeModify) || (ours == ChangeModify && theirs == ChangeMove):
		return StrategyApplyBoth
	case ours == ChangeDelete && theirs == ChangeDelete:
		return StrategyApplyBoth
	}
	// Both modified the content.
	switch kind {
	case syncproto.KindMarkdown:
		return StrategyMarkdown3Way
	case syncproto.KindConfig:
		return StrategyConfigLWW
	case syncproto.KindBase:
		if sameAuthor {
			return StrategyMarkdown3Way
		}
		return StrategyConflictCopy
	case syncproto.KindExcalidraw:
		if sameAuthor {
			return StrategyExcalidrawID
		}
		return StrategyConflictCopy
	case syncproto.KindCanvas:
		if sameAuthor {
			return StrategyCanvasID
		}
		return StrategyConflictCopy
	case syncproto.KindAttachment:
		if sameAuthor {
			return StrategyLastWriteWins
		}
		return StrategyConflictCopy
	default:
		// Opaque (private vault) content cannot be inspected: the client
		// decides on the plaintext path it knows, so reaching here means an
		// unknown type. Be safe.
		if sameAuthor {
			return StrategyLastWriteWins
		}
		return StrategyConflictCopy
	}
}
