//go:build !js

package app

import (
	"memobrain/apps/desktop/internal/auth"
	"memobrain/apps/desktop/internal/events"
	syncpkg "memobrain/apps/desktop/internal/sync"
	"memobrain/shared/syncproto"
)

// Events is the registry of every Go → TypeScript event of the core (ADR-0045 §5): the input of the
// generator of packages/workbench/src/app/events.gen.ts (`task gen`, internal/app/gen/events). It is
// built for the desktop, the superset (the browser build has no updater). TestEventRegistry fails when
// an event is declared but not listed here, or sent by name instead of through its declaration.
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
	EventOpenRequest.Spec(),
	EventBeforeClose.Spec(),
}

// EventEnums are the string types of the payloads that TypeScript sees as unions of their values
// (TestEventEnumsComplete checks each list against the constants of its type).
var EventEnums = []events.EnumSpec{
	events.Enum(ChangeCreate, ChangeModify, ChangeDelete),
	events.Enum(syncpkg.PhaseIdle, syncpkg.PhaseSyncing, syncpkg.PhasePaused, syncpkg.PhaseOffline, syncpkg.PhaseError, syncpkg.PhaseLocked),
	events.Enum(syncpkg.LockReasonManual, syncpkg.LockReasonIdle, syncpkg.LockReasonSync),
	events.Enum(auth.StatusSignedOut, auth.StatusSigningIn, auth.StatusReady, auth.StatusDisconnected, auth.StatusDeviceRevoked),
	events.Enum(syncproto.KindMarkdown, syncproto.KindCanvas, syncproto.KindBase, syncproto.KindExcalidraw,
		syncproto.KindAttachment, syncproto.KindConfig, syncproto.KindOther, syncproto.KindOpaque),
}
