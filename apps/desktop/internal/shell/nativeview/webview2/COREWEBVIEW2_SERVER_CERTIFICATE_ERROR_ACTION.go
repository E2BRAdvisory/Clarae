// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

package webview2

type COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION uint32

const (
	COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW = 0
	COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL       = 1
	COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_DEFAULT      = 2
)
