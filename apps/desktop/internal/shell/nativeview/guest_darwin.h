// The native web views of the applications on macOS (M18, track E): a WKWebView added as a child of the
// content view of the window of the application, above the web view of the application. Everything
// here runs on the main thread (the Go side moves its calls there); a function called from another
// thread refuses (-2). The Go side is driver_darwin.go.
#ifndef CLARAE_GUEST_DARWIN_H
#define CLARAE_GUEST_DARWIN_H

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
	GuestEvFocus = 9,      // the guest became first responder
	GuestEvActivity = 10,  // the user works in the guest (at most every 5 s)
};

// Return codes: 0 or more is success.
enum {
	GuestErrUnknown = -1,
	GuestErrThread = -2,
	GuestErrURL = -3,
	GuestErrNoWindow = -4,
	GuestErrExists = -5,
};

// guestCreate adds the guest `id` above the other views of the content view of nsWindow. The
// bounds are fractions (0..1) of the content view, origin at the top-left. storeUUID names a persistent
// data store (macOS 14 and later); an empty string, an invalid one or an older system gives a store
// that lives in memory. The URL must be http or https.
int guestCreate(void *nsWindow, const char *id, const char *url, double x, double y, double w, double h, const char *storeUUID);
int guestSetBounds(const char *id, double x, double y, double w, double h);
int guestSetVisible(const char *id, int visible);
int guestNavigate(const char *id, const char *url);
int guestBack(const char *id);
int guestForward(const char *id);
int guestReload(const char *id);
int guestFocus(const char *id);
int guestClose(const char *id);
void guestCloseAll(void);

// guestReserveKeys sets the accelerators the guest hands to Go instead of consuming ("cmd+w,ctrl+tab").
void guestReserveKeys(const char *csv);

// guestRemoveData deletes the data store `uuid` (cookies, storage, caches). The answer comes in
// goGuestReply with req.
int guestRemoveData(const char *uuid, long req);

// guestPersistent: sessions survive a restart (macOS 14 and later).
int guestPersistent(void);

#ifdef CLARAE_NATIVEVIEW_TEST
// Test only (build tag nativeviewtest): what the live test needs to see inside the guest.
int guestEval(const char *id, const char *js, long req); // callAsyncJavaScript: the body of an async function
int guestFrame(const char *id, double *x, double *y, double *w, double *h, double *cw, double *ch, int *hidden, int *firstResponder);
int guestHitTest(const char *id, double x, double y); // 1 = the guest, 2 = another web view, 0 = other
int guestCount(void);
int guestInspectable(const char *id); // 1 if the web inspector can attach to the guest, 0 if not, -1 unknown
int guestStoreKind(const char *id); // 1 = identified, 2 = in memory
void guestPostKey(void *nsWindow, const char *chars, const char *charsNoMods, unsigned short keyCode, unsigned long flags);
void guestActivateApp(void);
void guestFocusMain(void *nsWindow); // the web view of the application takes the focus
void guestPostClick(const char *id, double x, double y); // a click at a point of the guest (points in the guest)
// guestKeyEquivalent offers a Cmd/Ctrl key to the window and then to the main menu, in the order
// NSApplication does for a key that is pressed; it needs no active application (a test process started from a
// terminal is often not the active one, and then posted events go nowhere).
void guestKeyEquivalent(void *nsWindow, unsigned short keyCode, unsigned long flags, int *windowHandled, int *menuHandled, char *info, int n); // info: what the event is, for the log
// guestKeyDown hands a plain key to the guest, as the window does when the guest is the first responder.
void guestKeyDown(const char *id, const char *chars, unsigned short keyCode);
void guestResignFocus(void *nsWindow); // nothing is the first responder
void guestAppState(void *nsWindow, int *active, int *key, int *main); // is the application active, is this window key / main
#endif

#endif
