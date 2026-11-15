// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

package webview2

type COREWEBVIEW2_KEY_EVENT_KIND uint32

const (
	COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN        = 0
	COREWEBVIEW2_KEY_EVENT_KIND_KEY_UP          = 1
	COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN = 2
	COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_UP   = 3
)
