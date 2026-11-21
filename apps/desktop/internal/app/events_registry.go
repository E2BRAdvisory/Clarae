//go:build !js

package app

import (
	"clarae/apps/desktop/internal/auth"
	"clarae/apps/desktop/internal/events"
	"clarae/apps/desktop/internal/presence"
	syncpkg "clarae/apps/desktop/internal/sync"
	"clarae/apps/desktop/internal/terminal"
	"clarae/apps/desktop/internal/webview"
	"clarae/shared/syncproto"
)

// Events is the registry of every Go → TypeScript event of the core (ADR-0045 §5): the input of the
// generator of packages/workbench/src/app/events.gen.ts (`task gen`, internal/app/gen/events). It is
// built for the desktop, the superset (the browser build has no updater and no AI assistant). TestEventRegistry fails when
// an event is declared but not listed here, or sent by name instead of through its declaration.
// The contract and how to add an event: docs/desktop-web-sync.md, "Contratto degli eventi".
var Events = []events.Spec{
	EventVaultFileChanged.Spec(),
	EventIndexProgress.Spec(),
	syncpkg.EventStatus.Spec(),
	syncpkg.EventConflict.Spec(),
	syncpkg.EventLocked.Spec(),
	syncpkg.EventCloudVaultDeleted.Spec(),
	EventAuthState.Spec(),
	syncpkg.EventConfig.Spec(),
	EventConfigUpdated.Spec(),
	syncpkg.EventShares.Spec(),
	EventMountsChanged.Spec(),
	syncpkg.EventMountRevoked.Spec(),
	EventImportProgress.Spec(),
	EventImportDone.Spec(),
	EventUpdaterStatus.Spec(),
	EventAIChunk.Spec(),
	EventAIDone.Spec(),
	EventOpenRequest.Spec(),
	EventBeforeClose.Spec(),
	webview.EventState.Spec(),
	webview.EventBlocked.Spec(),
	webview.EventNewWindow.Spec(),
	webview.EventDownload.Spec(),
	webview.EventPermission.Spec(),
	webview.EventKey.Spec(),
	webview.EventLoadError.Spec(),
	webview.EventCrashed.Spec(),
	webview.EventFocus.Spec(),
	webview.EventClosed.Spec(),
	terminal.EventOutput.Spec(),
	terminal.EventExit.Spec(),
	terminal.EventLayout.Spec(),
	presence.EventMembers.Spec(),
	presence.EventMove.Spec(),
	presence.EventCleared.Spec(),
}

// EventEnums are the string types of the payloads that TypeScript sees as unions of their values
// (TestEventEnumsComplete checks each list against the constants of its type).
var EventEnums = []events.EnumSpec{
	events.Enum(ChangeCreate, ChangeModify, ChangeDelete),
	events.Enum(syncpkg.PhaseIdle, syncpkg.PhaseSyncing, syncpkg.PhasePaused, syncpkg.PhaseOffline, syncpkg.PhaseError, syncpkg.PhaseLocked),
	events.Enum(syncpkg.LockReasonManual, syncpkg.LockReasonIdle, syncpkg.LockReasonSync),
	events.Enum(auth.StatusSignedOut, auth.StatusSigningIn, auth.StatusReady, auth.StatusDisconnected, auth.StatusDeviceRevoked),
	events.Enum(webview.BlockEmpty, webview.BlockTooLong, webview.BlockCharacters, webview.BlockMalformed, webview.BlockScheme,
		webview.BlockCredentials, webview.BlockHost, webview.BlockPort, webview.BlockPrivateNetwork, webview.BlockThrottled, webview.BlockOther),
	events.Enum(webview.ClosedVaultClosed, webview.ClosedVaultLocked, webview.ClosedDataCleared, webview.ClosedDisabled, webview.ClosedQuit),
	events.Enum(terminal.ModeDocked, terminal.ModeDetached),
	events.Enum(terminal.ReasonExited, terminal.ReasonClosed, terminal.ReasonReadOnly, terminal.ReasonWindowClosed),
	events.Enum(syncproto.KindMarkdown, syncproto.KindCanvas, syncproto.KindBase, syncproto.KindExcalidraw,
		syncproto.KindAttachment, syncproto.KindConfig, syncproto.KindOther, syncproto.KindOpaque),
}
