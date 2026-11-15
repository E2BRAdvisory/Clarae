// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

package webview2

type COREWEBVIEW2_MOVE_FOCUS_REASON uint32

const (
	COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC = 0
	COREWEBVIEW2_MOVE_FOCUS_REASON_NEXT         = 1
	COREWEBVIEW2_MOVE_FOCUS_REASON_PREVIOUS     = 2
)
