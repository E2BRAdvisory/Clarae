//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package nativeview

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// The few calls of Win32 that the driver makes itself (the rest goes through WebView2).
var (
	user32             = windows.NewLazySystemDLL("user32.dll")
	procGetClientRect  = user32.NewProc("GetClientRect")
	procGetKeyState    = user32.NewProc("GetKeyState")
	procIsIconic       = user32.NewProc("IsIconic")
	procMapVirtualKeyW = user32.NewProc("MapVirtualKeyW")
	procSetFocus       = user32.NewProc("SetFocus")
)

const (
	vkShift   = 0x10
	vkControl = 0x11
	vkMenu    = 0x12 // Alt

	mapVKToChar = 2 // MAPVK_VK_TO_CHAR
)

type winRect struct{ Left, Top, Right, Bottom int32 }

// clientSize is the size of the client area of a window, in physical pixels: 0 by 0 if the call fails
// or the window is minimised.
func clientSize(hwnd uintptr) (w, h int32) {
	var r winRect
	if ok, _, _ := procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&r))); ok == 0 {
		return 0, 0
	}
	return r.Right - r.Left, r.Bottom - r.Top
}

func isIconic(hwnd uintptr) bool {
	r, _, _ := procIsIconic.Call(hwnd)
	return r != 0
}

// keyDown says whether a key is down for the thread that is handling the message (GetKeyState): in the
// handler of an accelerator, the state the key was pressed with.
func keyDown(vk int) bool {
	r, _, _ := procGetKeyState.Call(uintptr(vk))
	return int16(r) < 0 //nolint:gosec // the high bit of the 16 bits that GetKeyState returns
}

// layoutChar is the character that a virtual-key code makes with no modifier in the layout in use, 0 if
// there is none or it is a dead key.
func layoutChar(vk uint32) rune {
	r, _, _ := procMapVirtualKeyW.Call(uintptr(vk), mapVKToChar)
	if r == 0 || r&0x80000000 != 0 {
		return 0
	}
	return rune(r & 0xFFFF)
}

// setFocus gives the keyboard focus to a window of this thread (the window of the application, when a
// view that has the focus goes away; Wails then moves it into its own web view).
func setFocus(hwnd uintptr) {
	_, _, _ = procSetFocus.Call(hwnd)
}
