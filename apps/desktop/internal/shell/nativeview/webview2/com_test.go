//go:build windows && (amd64 || arm64)

//nolint:gosec // G103: the tests give pointers to functions that are called as COM methods are
package webview2

import (
	"errors"
	"testing"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Written on a machine that is not Windows and compiled there (go test -c); it has not been run.

var procCoTaskMemAlloc = windows.NewLazySystemDLL("ole32.dll").NewProc("CoTaskMemAlloc")

// comString returns a string in memory that the caller frees with CoTaskMemFree, as WebView2 does.
func comString(t *testing.T, s string) *uint16 {
	t.Helper()
	w := utf16.Encode([]rune(s + "\x00"))
	p, _, _ := procCoTaskMemAlloc.Call(uintptr(2 * len(w)))
	if p == 0 {
		t.Fatal("CoTaskMemAlloc failed")
	}
	copy(unsafe.Slice((*uint16)(*(*unsafe.Pointer)(unsafe.Pointer(&p))), len(w)), w)
	return (*uint16)(*(*unsafe.Pointer)(unsafe.Pointer(&p)))
}

func TestHRESULT(t *testing.T) {
	for _, hr := range []uintptr{0, 1, 0x7fffffff, 0xffffffff00000000, 0x1234567800000001} {
		if Failed(hr) || hresult(hr) != nil {
			t.Errorf("%#x is a success (S_OK, S_FALSE, a success code with garbage in the upper half)", hr)
		}
	}
	for _, hr := range []uintptr{0x80004003, 0x80070057, 0xffffffff, 0x1234567880004005} {
		err := hresult(hr)
		var e Error
		if !Failed(hr) || !errors.As(err, &e) || uint32(e) != uint32(hr) {
			t.Errorf("%#x is a failure: %v", hr, err)
		}
	}
	if got := Error(0x80004003).Error(); got != "HRESULT 0x80004003" {
		t.Errorf("Error() = %q", got)
	}
}

func TestGetString(t *testing.T) {
	// The method of COM gets the address of a pointer and puts the string in it: the original binding
	// passed a null pointer, so a get_Source could never work.
	ok := ComProc(windows.NewCallback(func(this uintptr, out **uint16) uintptr {
		*out = comString(t, "https://example.com/é?q=1")
		return 0
	}))
	got, err := getString(nil, ok)
	if err != nil || got != "https://example.com/é?q=1" {
		t.Errorf("getString = %q, %v", got, err)
	}

	failed := ComProc(windows.NewCallback(func(this uintptr, out **uint16) uintptr {
		return 0x80004003 // E_POINTER
	}))
	if got, err := getString(nil, failed); err == nil || got != "" {
		t.Errorf("getString on a failure = %q, %v", got, err)
	}

	// An HRESULT is 32 bits: the rest of the register does not make a success a failure.
	garbage := ComProc(windows.NewCallback(func(this uintptr, out **uint16) uintptr {
		*out = comString(t, "x")
		return 0xdeadbeef00000000
	}))
	if got, err := getString(nil, garbage); err != nil || got != "x" {
		t.Errorf("getString with garbage in the upper half = %q, %v", got, err)
	}
}

func TestGUIDs(t *testing.T) {
	// The interfaces that are asked for by IID: a typo would be an interface that is never there.
	want := map[string]GUID{
		"{20d02d59-6df2-42dc-bd06-f98a694b1302}": {Data1: 0x20d02d59, Data2: 0x6df2, Data3: 0x42dc, Data4: [8]byte{0xbd, 0x06, 0xf9, 0x8a, 0x69, 0x4b, 0x13, 0x02}},
	}
	for s, g := range want {
		if got := NewGUID(s); got == nil || *got != g {
			t.Errorf("NewGUID(%s) = %v", s, got)
		}
	}
	if NewGUID("not a guid") != nil {
		t.Error("NewGUID accepted a string that is not a GUID")
	}
	if !IsEqualGUID(NewGUID("{00000000-0000-0000-C000-000000000046}"), NewGUID("{00000000-0000-0000-c000-000000000046}")) {
		t.Error("IsEqualGUID is case sensitive")
	}
}
