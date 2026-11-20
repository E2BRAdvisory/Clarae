//go:build linux && cgo && gtk3 && !android && !server && !purego

// The native web views of the applications on Linux (M22, ADR-0062): a WebKitWebView of WebKitGTK added to a
// GtkOverlay that takes the place of the web view of the application in the window, above it. Everything here
// runs on the GTK main thread (the Go side moves its calls there); a function called from another thread
// refuses (-2). The Go side is driver_linux.go.
#ifndef CLARAE_GUEST_LINUX_H
#define CLARAE_GUEST_LINUX_H

// The kinds of event reported to Go (goGuestEvent). They are the values of webview.EventKind.
enum {
	GuestEvState = 1,      // a=url b=title f1=loading f2=canGoBack f3=canGoForward
	GuestEvNewWindow = 2,  // a=url f1=userGesture         (target=_blank, window.open: nothing is opened)
	GuestEvBlocked = 3,    // a=url b=reason f1=mainFrame (a navigation was cancelled)
	GuestEvDownload = 4,   // a=url                       (a download was refused)
	GuestEvPermission = 5, // a=what b=host               (a permission request was denied)
	GuestEvKey = 6,        // a=accelerator               (a reserved key combination)
	GuestEvError = 7,      // a=url b=message f1=code f2=certificate
	GuestEvCrash = 8,      // the process that renders the page ended
	GuestEvFocus = 9,      // the guest took the keyboard focus
	GuestEvActivity = 10,  // the user works in the guest (at most every 5 s)
};

// What a navigation is for, as the policy is asked (goGuestPolicy): WebKitGTK does not say which frame, see frameOf.
enum {
	GuestFrameMain = 1,
	GuestFrameSub = 2,
	GuestFrameUnknown = 3,
};

// Return codes: 0 or more is success.
enum {
	GuestErrUnknown = -1,
	GuestErrThread = -2,
	GuestErrURL = -3,
	GuestErrNoWindow = -4,
	GuestErrExists = -5,
	// GuestErrUnavailable: the platform cannot show views at all (WebKitGTK too old, a window that is not made
	// the way the driver expects); `err` of guestCreate says why. The Go side turns it into
	// webview.ErrPlatformUnavailable.
	GuestErrUnavailable = -6,
	GuestErrStore = -7, // the session data of the store could not be set up
	GuestErrStoreBusy = -8, // the session data of the store are being deleted: the caller tries again
};

// guestOnMainThread says whether the caller is on the GTK main thread (it owns the default main context): the
// shutdown of the application removes the guests at once there, and queues the work anywhere else.
int guestOnMainThread(void);

// guestWebKitOK says whether the WebKitGTK of this process is new enough (2.40); it does not need the GTK main
// thread. Otherwise it returns 0 and writes why in `why` (n bytes).
int guestWebKitOK(char *why, int n);

// guestCreate adds the guest `id` above the web view of the application, in the window `gtkWindow` (the
// GtkWindow of Wails). The first call grafts a GtkOverlay in place of the web view of the application (see
// graft in guest_linux.c); if the window is not made as the graft expects it returns GuestErrUnavailable. The
// bounds are fractions (0..1) of the area of the web view of the application, origin at the top-left. `store`
// names the session (a context of WebKit with its own data); `dataDir` and `cacheDir` are the folders it keeps
// them in (they exist). The URL must be http or https.
int guestCreate(void *gtkWindow, const char *id, const char *url, double x, double y, double w, double h,
	const char *store, const char *dataDir, const char *cacheDir, char *err, int errn);
int guestSetBounds(const char *id, double x, double y, double w, double h);
int guestSetVisible(const char *id, int visible);
int guestNavigate(const char *id, const char *url);
int guestBack(const char *id);
int guestForward(const char *id);
int guestReload(const char *id);
int guestFocus(const char *id);
int guestClose(const char *id);
void guestCloseAll(void);

// guestReserveKeys sets the accelerators the guest hands to Go instead of consuming ("ctrl+w,ctrl+shift+tab").
void guestReserveKeys(const char *csv);

// guestReleaseStore deletes the data of the store `store` that WebKit keeps in memory (cookies, storage, caches)
// and lets go of its context, so that the folder can be deleted. The answer comes in goGuestReply with req (1 ok;
// 0 and a message: the store is in use). A store that was never made answers ok at once.
int guestReleaseStore(const char *store, long req);

#ifdef CLARAE_NATIVEVIEW_TEST
// Test only (build tag nativeviewtest): what the live test needs to see inside the guest.
int guestEval(const char *id, const char *js, long req); // the body of an async function; the answer in goGuestReply
// guestFrame: where the guest is, in the coordinates of the area of the web view of the application (origin top-left).
int guestFrame(const char *id, double *x, double *y, double *w, double *h, double *cw, double *ch, int *visible, int *hasFocus);
// guestHitTest: what is at a point of that area: 1 the guest, 2 the web view of the application, 0 other.
int guestHitTest(const char *id, double x, double y);
int guestCount(void);
int guestSandboxEnabled(const char *id);       // 1 if the context of the guest has the sandbox of WebKit on
void guestSetClearing(const char *store, int on); // plays a guestReleaseStore that is waiting for WebKit
int guestInspectable(const char *id); // 1 if developer extras are on, 0 if not, -1 unknown
// guestPostKey hands a key to the guest as the keyboard does; modifiers are GdkModifierType bits.
void guestPostKey(const char *id, unsigned int keyval, unsigned int state);
// guestPostPointer sends a button press (what 1) or release (2) at a point of the area, through the X server (XTest).
void guestPostPointer(double x, double y, int what);
int guestWindowAt(double x, double y, char *name, int n); // what the X server has under a point (the pointer moves there): 1 guest, 2 application, 0 other

void guestFocusMain(void *gtkWindow); // the web view of the application takes the focus
// guestGraftInfo: the graft as the live test sees it: the type names of the parents of the web view of the
// application, from the window down (`path`), whether the overlay holds it and where the box packs it.
int guestGraftInfo(void *gtkWindow, char *path, int n, int *position, int *children);
int guestAppFocused(void *gtkWindow); // 1 when the web view of the application has the focus
int guestCreateElsewhere(char *err, int n); // guestCreate on a plain window: the graft must refuse it (-6)
int guestPixel(double x, double y, int *r, int *g, int *b); // the colour drawn at a point of the area (needs a drawn window)
void guestTraceEvents(void);
int guestClicks(const char *id);      // button presses that reached the guest
int guestAppClicks(void);             // button presses that reached the web view of the application
const char *guestUserAgent(const char *id);
#endif

#endif
