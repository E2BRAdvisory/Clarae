// The native web views of the applications on macOS: see guest_darwin.h. Compiled with ARC.
//
// What a guest is allowed, in one place:
//   - A fresh WKWebViewConfiguration: no script message handler, no user script, no URL scheme
//     handler. The scheme of the application ("wails") is registered on the configuration of ITS web
//     view only, so a guest cannot even name it; and nothing of the Wails runtime (the bridge, the
//     events, the bindings) exists in a page that is not the application's.
//   - Only http and https in the top frame (the policy of Go, and this file refuses the rest as well),
//     and, in frames inside the page, also about, blob and data (what pages build frames with).
//   - Downloads are cancelled, before they write anything. Permission requests (camera, microphone,
//     the storage access prompt, motion sensors, the file chooser) are denied. New windows are not
//     opened: the address is reported to Go. A certificate that is not trusted fails the load: the
//     challenge gets the default handling, never a credential.
//   - No inspector, no favicon request (nothing here asks for one), no context menu item that opens a
//     window or downloads.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include "guest_darwin.h"

// Implemented in Go (driver_darwin.go). The strings are valid during the call only.
extern void goGuestEvent(char *id, int kind, char *a, char *b, int f1, int f2, int f3);
extern int goGuestPolicy(char *id, char *url, int mainFrame);
extern void goGuestReply(long req, int ok, char *msg);

// The user agent: a Safari (the engine is WebKit; a site that sniffs for an unknown browser serves it
// less). The version is a number a current Safari has had for a while.
static NSString *const kUserAgentApplicationName = @"Version/18.0 Safari/605.1.15";

#define MAIN_ONLY(ret) do { if (![NSThread isMainThread]) { NSLog(@"clarae nativeview: called off the main thread"); return ret; } } while (0)

static const char *cstr(NSString *s) { return s ? s.UTF8String : ""; }

static void emit(NSString *gid, int kind, NSString *a, NSString *b, int f1, int f2, int f3) {
	goGuestEvent((char *)cstr(gid), kind, (char *)cstr(a), (char *)cstr(b), f1, f2, f3);
}

// ---- keys -------------------------------------------------------------------------------------

static NSSet<NSString *> *gReserved;

// keyName is the key of an accelerator in the syntax of webview.ParseAccelerator, or nil.
static NSString *keyName(NSEvent *e) {
	// charactersIgnoringModifiers still applies Shift (Cmd+Shift+1 gives "!"), so the key of a combination
	// with Shift would not be the one the user reserved ("shift+cmd+1"): the key is what the keyboard makes with
	// no modifier at all. A function key has no such character (the layout answers a control character for
	// it), and keeps its private-use one.
	NSString *c = e.charactersIgnoringModifiers;
	if (c.length == 0) return nil;
	unichar first = [c characterAtIndex:0];
	if (first < 0xF700 || first > 0xF8FF) {
		NSString *bare = [e charactersByApplyingModifiers:0];
		if (bare.length > 0) {
			unichar b0 = [bare characterAtIndex:0];
			if ((b0 >= 0x20 && b0 != 0x7f) || b0 == 0x09 || b0 == 0x0d || b0 == 0x1b || b0 == 0x7f || b0 == 0x03) c = bare;
		}
	}
	unichar ch = [c characterAtIndex:0];
	if (ch >= NSF1FunctionKey && ch <= NSF20FunctionKey) return [NSString stringWithFormat:@"f%d", (int)(ch - NSF1FunctionKey + 1)];
	switch (ch) {
	case NSUpArrowFunctionKey: return @"up";
	case NSDownArrowFunctionKey: return @"down";
	case NSLeftArrowFunctionKey: return @"left";
	case NSRightArrowFunctionKey: return @"right";
	case NSHomeFunctionKey: return @"home";
	case NSEndFunctionKey: return @"end";
	case NSPageUpFunctionKey: return @"pageup";
	case NSPageDownFunctionKey: return @"pagedown";
	case NSDeleteFunctionKey: return @"delete";
	case 0x7f: return @"backspace";
	case 0x0d: case 0x03: return @"enter";
	case 0x09: case 0x19: return @"tab"; // 0x19 is Shift+Tab
	case 0x1b: return @"escape";
	case ' ': return @"space";
	case '+': return @"plus";
	}
	if (ch > ' ' && ch < 0x7f) return [[NSString stringWithCharacters:&ch length:1] lowercaseString];
	return nil;
}

static NSString *accelerator(NSEvent *e) {
	NSEventModifierFlags m = e.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
	NSString *k = keyName(e);
	if (!k) return @"";
	NSMutableArray *p = [NSMutableArray array];
	if (m & NSEventModifierFlagControl) [p addObject:@"ctrl"];
	if (m & NSEventModifierFlagOption) [p addObject:@"alt"];
	if (m & NSEventModifierFlagShift) [p addObject:@"shift"];
	if (m & NSEventModifierFlagCommand) [p addObject:@"cmd"];
	[p addObject:k];
	return [p componentsJoinedByString:@"+"];
}

// ---- downloads --------------------------------------------------------------------------------

// A download that starts all the same (a response WebKit turns into one) is cancelled before it
// writes anything.
@interface ClaraeDownloadDelegate : NSObject <WKDownloadDelegate>
@property (copy) NSString *gid;
@end
@implementation ClaraeDownloadDelegate
- (void)download:(WKDownload *)download decideDestinationUsingResponse:(NSURLResponse *)response suggestedFilename:(NSString *)name completionHandler:(void (^)(NSURL *))completionHandler {
	emit(self.gid, GuestEvDownload, response.URL.absoluteString, @"", 0, 0, 0);
	completionHandler(nil); // nil cancels
}
- (void)download:(WKDownload *)download didFailWithError:(NSError *)error resumeData:(NSData *)resumeData {}
@end

// ---- the view ---------------------------------------------------------------------------------

@interface ClaraeGuestView : WKWebView
@property (copy) NSString *gid;
@property CFTimeInterval lastActivity;
@property CFTimeInterval lastUserEvent; // the last key, click or scroll in the guest (not throttled)
@end

@implementation ClaraeGuestView
// The window asks the views for key equivalents before the main menu: when the guest has the focus
// this is the first place that sees the Cmd+W of the user. A reserved one goes to Go (and so to the
// command of the application of the same name) and is consumed here.
- (BOOL)performKeyEquivalent:(NSEvent *)e {
	// Only when the guest has the focus: shown beside the editor, with the editor focused, it must not take
	// the keys of the application (Cmd+W, Cmd+P) from it.
	NSResponder *fr = self.window.firstResponder;
	if (![fr isKindOfClass:[NSView class]] || ![(NSView *)fr isDescendantOf:self]) return NO;
	NSString *acc = accelerator(e);
	if (acc.length && [gReserved containsObject:acc]) {
		emit(self.gid, GuestEvKey, acc, @"", 0, 0, 0);
		return YES;
	}
	return [super performKeyEquivalent:e];
}
- (BOOL)becomeFirstResponder {
	BOOL ok = [super becomeFirstResponder];
	if (ok) emit(self.gid, GuestEvFocus, @"", @"", 0, 0, 0);
	return ok;
}
// The pointer and the keys of a guest never reach the web view of the application, which is what the
// idle lock of a private vault listens to: tell Go that the user is working, now and then.
- (void)noteActivity {
	CFTimeInterval now = CACurrentMediaTime();
	self.lastUserEvent = now;
	if (now - self.lastActivity < 5.0) return;
	self.lastActivity = now;
	emit(self.gid, GuestEvActivity, @"", @"", 0, 0, 0);
}
- (void)keyDown:(NSEvent *)e { [self noteActivity]; [super keyDown:e]; }
- (void)mouseDown:(NSEvent *)e { [self noteActivity]; [super mouseDown:e]; }
- (void)scrollWheel:(NSEvent *)e { [self noteActivity]; [super scrollWheel:e]; }
// The context menu of WebKit offers to open a link in a new window, to download and to inspect: none
// of them is wanted.
- (void)willOpenMenu:(NSMenu *)menu withEvent:(NSEvent *)event {
	[super willOpenMenu:menu withEvent:event];
	for (NSMenuItem *it in [menu.itemArray copy]) {
		NSString *ident = it.identifier ?: @"";
		if ([ident containsString:@"NewWindow"] || [ident containsString:@"Download"] || [ident containsString:@"Inspect"]) {
			[menu removeItem:it];
		}
	}
}
@end

@interface ClaraeGuest : NSObject <WKNavigationDelegate, WKUIDelegate>
@property (copy) NSString *gid;
@property (strong) ClaraeGuestView *view;
@property (strong) ClaraeDownloadDelegate *dl;
@property (weak) NSWindow *window;
@property NSRect norm; // x, y, w, h in 0..1, origin top-left
@property int storeKind;
@property (copy) NSURL *lastURL; // the last address a load was asked for: what Reload retries when nothing was ever shown
@property (strong) NSDate *lastNewWindow;
@property (copy) NSString *lastNewWindowURL;
@end

static NSMutableDictionary<NSString *, ClaraeGuest *> *gGuests;

static BOOL isHTTP(NSURL *u) {
	NSString *s = u.scheme.lowercaseString;
	return [s isEqualToString:@"http"] || [s isEqualToString:@"https"];
}

// userGesture: the user worked in the guest a moment ago and it is shown. A window that a page asks for
// with no one in front of it is not forwarded to the system browser. WebKit calls a script run by the
// application (callAsyncJavaScript) or by the page a gesture; this does not: it looks at the keys and clicks
// that reached the view.
static int userGesture(ClaraeGuestView *v) {
	return v && !v.hidden && CACurrentMediaTime() - v.lastUserEvent < 2.0 ? 1 : 0;
}

static NSString *originHost(WKSecurityOrigin *o) { return o.host ?: @""; }

@implementation ClaraeGuest

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
	[self pushState];
}

- (void)pushState {
	ClaraeGuestView *v = self.view;
	if (!v) return;
	emit(self.gid, GuestEvState, v.URL.absoluteString, v.title, v.loading, v.canGoBack, v.canGoForward);
}

- (NSRect)frameForContent:(NSView *)cv {
	NSSize s = cv.bounds.size;
	NSRect n = self.norm;
	CGFloat y = cv.isFlipped ? n.origin.y * s.height : (1.0 - n.origin.y - n.size.height) * s.height;
	return NSMakeRect(n.origin.x * s.width, y, n.size.width * s.width, n.size.height * s.height);
}

- (void)relayout {
	NSView *cv = self.window.contentView;
	if (!cv || !self.view) return;
	self.view.frame = [self frameForContent:cv];
}

- (void)contentResized:(NSNotification *)n { [self relayout]; }

#pragma mark WKNavigationDelegate

- (void)webView:(WKWebView *)wv decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))handler {
	NSURL *u = action.request.URL;
	NSString *us = u.absoluteString ?: @"";
	BOOL mainFrame = action.targetFrame.isMainFrame;
	if (action.targetFrame == nil) {
		// target=_blank, window.open: nothing is opened here, the address goes to Go.
		self.lastNewWindow = [NSDate date];
		self.lastNewWindowURL = us;
		emit(self.gid, GuestEvNewWindow, us, @"", userGesture(self.view), 0, 0);
		handler(WKNavigationActionPolicyCancel);
		return;
	}
	if (@available(macOS 11.3, *)) {
		if (action.shouldPerformDownload) {
			emit(self.gid, GuestEvDownload, us, @"", 0, 0, 0);
			handler(WKNavigationActionPolicyCancel);
			return;
		}
	}
	// Go judges (the rules of webview.ValidateURL, the private network, the view it is) and reports
	// what it refuses; the scheme is checked here as well, so that a mistake of one side is not the end.
	int allow = goGuestPolicy((char *)cstr(self.gid), (char *)cstr(us), mainFrame ? 1 : 0);
	NSString *s = u.scheme.lowercaseString;
	BOOL schemeOK = isHTTP(u) || (!mainFrame && ([s isEqualToString:@"about"] || [s isEqualToString:@"blob"] || [s isEqualToString:@"data"]));
	if (allow && !schemeOK) {
		emit(self.gid, GuestEvBlocked, us, @"scheme", mainFrame ? 1 : 0, 0, 0);
	}
	handler(allow && schemeOK ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

- (void)webView:(WKWebView *)wv decidePolicyForNavigationResponse:(WKNavigationResponse *)resp decisionHandler:(void (^)(WKNavigationResponsePolicy))handler {
	if (resp.isForMainFrame) {
		BOOL attachment = NO;
		if ([resp.response isKindOfClass:[NSHTTPURLResponse class]]) {
			NSString *cd = [(NSHTTPURLResponse *)resp.response valueForHTTPHeaderField:@"Content-Disposition"];
			attachment = cd && [cd.lowercaseString hasPrefix:@"attachment"];
		}
		if (attachment || !resp.canShowMIMEType) {
			emit(self.gid, GuestEvDownload, resp.response.URL.absoluteString, @"", 0, 0, 0);
			handler(WKNavigationResponsePolicyCancel);
			return;
		}
	}
	handler(WKNavigationResponsePolicyAllow);
}

- (void)webView:(WKWebView *)wv navigationAction:(WKNavigationAction *)action didBecomeDownload:(WKDownload *)download API_AVAILABLE(macos(11.3)) {
	download.delegate = self.dl;
}
- (void)webView:(WKWebView *)wv navigationResponse:(WKNavigationResponse *)resp didBecomeDownload:(WKDownload *)download API_AVAILABLE(macos(11.3)) {
	download.delegate = self.dl;
}

- (void)webView:(WKWebView *)wv didReceiveAuthenticationChallenge:(NSURLAuthenticationChallenge *)ch completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))handler {
	if ([ch.protectionSpace.authenticationMethod isEqualToString:NSURLAuthenticationMethodServerTrust]) {
		// The default handling: an untrusted certificate fails the load. There is no bypass, and a credential is
		// never built from the trust.
		handler(NSURLSessionAuthChallengePerformDefaultHandling, nil);
		return;
	}
	// Anything else (Basic, Digest, NTLM, Negotiate, a client certificate) is cancelled: the default handling
	// would offer what the system keeps (a password of the keychain, an identity) to a server that the page
	// chose. The load fails and the UI is told.
	emit(self.gid, GuestEvBlocked, ch.protectionSpace.host, @"authentication", 1, 0, 0);
	handler(NSURLSessionAuthChallengeCancelAuthenticationChallenge, nil);
}

// isCertificateError: the codes of NSURLErrorDomain for a certificate that is not good.
static BOOL isCertificateError(NSError *err) {
	if (![err.domain isEqualToString:NSURLErrorDomain]) return NO;
	switch (err.code) {
	case NSURLErrorServerCertificateHasBadDate:
	case NSURLErrorServerCertificateUntrusted:
	case NSURLErrorServerCertificateHasUnknownRoot:
	case NSURLErrorServerCertificateNotYetValid:
		return YES;
	}
	return NO;
}

// isOurCancel: a navigation that this file (or a newer navigation of the page) cancelled is not an error.
static BOOL isOurCancel(NSError *err) {
	if ([err.domain isEqualToString:NSURLErrorDomain] && err.code == NSURLErrorCancelled) return YES;
	return [err.domain isEqualToString:@"WebKitErrorDomain"] && err.code == 102; // frame load interrupted (a refused download)
}

- (void)webView:(WKWebView *)wv didFailProvisionalNavigation:(WKNavigation *)nav withError:(NSError *)err {
	if (!isOurCancel(err)) {
		NSString *u = err.userInfo[NSURLErrorFailingURLStringErrorKey] ?: @"";
		emit(self.gid, GuestEvError, u, err.localizedDescription, (int)err.code, isCertificateError(err) ? 1 : 0, 0);
	}
	[self pushState];
}
- (void)webView:(WKWebView *)wv didFailNavigation:(WKNavigation *)nav withError:(NSError *)err {
	if (!isOurCancel(err)) {
		emit(self.gid, GuestEvError, wv.URL.absoluteString, err.localizedDescription, (int)err.code, isCertificateError(err) ? 1 : 0, 0);
	}
	[self pushState];
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)wv {
	emit(self.gid, GuestEvCrash, @"", @"", 0, 0, 0);
}

#pragma mark WKUIDelegate

- (WKWebView *)webView:(WKWebView *)wv createWebViewWithConfiguration:(WKWebViewConfiguration *)cfg forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)features {
	// Nothing is opened. The address is reported unless decidePolicy has just done it.
	NSString *u = action.request.URL.absoluteString ?: @"";
	if (!(self.lastNewWindow && [self.lastNewWindowURL isEqualToString:u] && -[self.lastNewWindow timeIntervalSinceNow] < 0.5)) {
		emit(self.gid, GuestEvNewWindow, u, @"", userGesture(self.view), 0, 0);
	}
	return nil;
}
// The dialogs of the page: an alert is acknowledged, a confirm says no, a prompt says nothing.
- (void)webView:(WKWebView *)wv runJavaScriptAlertPanelWithMessage:(NSString *)m initiatedByFrame:(WKFrameInfo *)f completionHandler:(void (^)(void))h { h(); }
- (void)webView:(WKWebView *)wv runJavaScriptConfirmPanelWithMessage:(NSString *)m initiatedByFrame:(WKFrameInfo *)f completionHandler:(void (^)(BOOL))h { h(NO); }
- (void)webView:(WKWebView *)wv runJavaScriptTextInputPanelWithPrompt:(NSString *)p defaultText:(NSString *)d initiatedByFrame:(WKFrameInfo *)f completionHandler:(void (^)(NSString *))h { h(nil); }
- (void)webView:(WKWebView *)wv runOpenPanelWithParameters:(WKOpenPanelParameters *)p initiatedByFrame:(WKFrameInfo *)f completionHandler:(void (^)(NSArray<NSURL *> *))h {
	emit(self.gid, GuestEvPermission, @"file-chooser", originHost(f.securityOrigin), 0, 0, 0);
	h(nil);
}
- (void)webView:(WKWebView *)wv requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)o initiatedByFrame:(WKFrameInfo *)f type:(WKMediaCaptureType)t decisionHandler:(void (^)(WKPermissionDecision))h API_AVAILABLE(macos(12.0)) {
	emit(self.gid, GuestEvPermission, @"media-capture", originHost(o), 0, 0, 0);
	h(WKPermissionDecisionDeny);
}
- (void)webView:(WKWebView *)wv requestDeviceOrientationAndMotionPermissionForOrigin:(WKSecurityOrigin *)o initiatedByFrame:(WKFrameInfo *)f decisionHandler:(void (^)(WKPermissionDecision))h API_AVAILABLE(macos(15.0)) {
	emit(self.gid, GuestEvPermission, @"orientation", originHost(o), 0, 0, 0);
	h(WKPermissionDecisionDeny);
}
- (void)webView:(WKWebView *)wv requestStorageAccessPanelForDomain:(NSString *)requestingDomain underCurrentDomain:(NSString *)currentDomain completionHandler:(void (^)(BOOL))h API_AVAILABLE(macos(12.0)) {
	emit(self.gid, GuestEvPermission, @"storage-access", requestingDomain, 0, 0, 0);
	h(NO);
}

@end

#pragma mark C API

static ClaraeGuest *lookup(const char *id) { return id ? gGuests[[NSString stringWithUTF8String:id]] : nil; }

void guestReserveKeys(const char *csv) {
	NSString *s = [NSString stringWithUTF8String:csv ?: ""];
	NSMutableSet *set = [NSMutableSet set];
	for (NSString *k in [s componentsSeparatedByString:@","]) {
		if (k.length) [set addObject:k];
	}
	gReserved = set;
}

int guestPersistent(void) {
	if (@available(macOS 14.0, *)) return 1;
	return 0;
}

int guestCreate(void *nsWindow, const char *id, const char *url, double x, double y, double w, double h, const char *storeUUID) {
	MAIN_ONLY(GuestErrThread);
	NSWindow *win = (__bridge NSWindow *)nsWindow;
	NSView *cv = win.contentView;
	if (!cv) return GuestErrNoWindow;
	if (!gGuests) gGuests = [NSMutableDictionary dictionary];
	if (!gReserved) guestReserveKeys("");
	NSString *gid = [NSString stringWithUTF8String:id ?: ""];
	if (gid.length == 0 || gGuests[gid]) return GuestErrExists;
	NSURL *nu = url ? [NSURL URLWithString:[NSString stringWithUTF8String:url]] : nil;
	if (!nu || !isHTTP(nu)) return GuestErrURL;

	// A new configuration: no message handler, no user script, no URL scheme handler.
	WKWebViewConfiguration *cfg = [[WKWebViewConfiguration alloc] init];
	int kind = 2;
	if (@available(macOS 14.0, *)) {
		NSString *uuid = storeUUID ? [NSString stringWithUTF8String:storeUUID] : @"";
		NSUUID *u = uuid.length ? [[NSUUID alloc] initWithUUIDString:uuid] : nil;
		if (u) {
			cfg.websiteDataStore = [WKWebsiteDataStore dataStoreForIdentifier:u];
			kind = 1;
		}
	}
	if (kind == 2) cfg.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
	cfg.preferences.javaScriptCanOpenWindowsAutomatically = NO;
	cfg.applicationNameForUserAgent = kUserAgentApplicationName;
	if (@available(macOS 12.3, *)) cfg.preferences.elementFullscreenEnabled = NO;
	cfg.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeAll;

	ClaraeGuest *g = [[ClaraeGuest alloc] init];
	g.gid = gid;
	g.window = win;
	g.norm = NSMakeRect(x, y, w, h);
	g.storeKind = kind;
	g.dl = [[ClaraeDownloadDelegate alloc] init];
	g.dl.gid = gid;

	ClaraeGuestView *v = [[ClaraeGuestView alloc] initWithFrame:[g frameForContent:cv] configuration:cfg];
	v.gid = gid;
	v.navigationDelegate = g;
	v.UIDelegate = g;
	v.allowsBackForwardNavigationGestures = NO;
	v.allowsMagnification = NO;
	v.allowsLinkPreview = NO;
	v.autoresizingMask = NSViewNotSizable;
	if (@available(macOS 13.3, *)) v.inspectable = NO;
	g.view = v;
	for (NSString *k in @[@"URL", @"title", @"loading", @"canGoBack", @"canGoForward"]) {
		[v addObserver:g forKeyPath:k options:0 context:NULL];
	}
	[[NSNotificationCenter defaultCenter] addObserver:g selector:@selector(contentResized:) name:NSViewFrameDidChangeNotification object:cv];

	// Above every sibling, the web view of the application included.
	[cv addSubview:v positioned:NSWindowAbove relativeTo:nil];
	gGuests[gid] = g;
	g.lastURL = nu;
	[v loadRequest:[NSURLRequest requestWithURL:nu]];
	return 0;
}

int guestSetBounds(const char *id, double x, double y, double w, double h) {
	MAIN_ONLY(GuestErrThread);
	ClaraeGuest *g = lookup(id);
	if (!g) return GuestErrUnknown;
	g.norm = NSMakeRect(x, y, w, h);
	[g relayout];
	return 0;
}

// releaseFocus gives the focus back to the web view of the application when a guest that is going away
// (hidden, closed) has it: a view that is not there must not keep the keys.
static void releaseFocus(NSWindow *win, NSView *guest) {
	if (!win || ![win.firstResponder isKindOfClass:[NSView class]] || ![(NSView *)win.firstResponder isDescendantOf:guest]) return;
	for (NSView *s in win.contentView.subviews) {
		if ([s isKindOfClass:[WKWebView class]] && ![s isKindOfClass:[ClaraeGuestView class]]) {
			[win makeFirstResponder:s];
			return;
		}
	}
	[win makeFirstResponder:nil];
}

int guestSetVisible(const char *id, int visible) {
	MAIN_ONLY(GuestErrThread);
	ClaraeGuest *g = lookup(id);
	if (!g) return GuestErrUnknown;
	if (!visible) releaseFocus(g.window, g.view);
	g.view.hidden = !visible;
	return 0;
}

int guestNavigate(const char *id, const char *url) {
	MAIN_ONLY(GuestErrThread);
	ClaraeGuest *g = lookup(id);
	if (!g) return GuestErrUnknown;
	NSURL *u = url ? [NSURL URLWithString:[NSString stringWithUTF8String:url]] : nil;
	if (!u || !isHTTP(u)) return GuestErrURL;
	g.lastURL = u;
	[g.view loadRequest:[NSURLRequest requestWithURL:u]];
	return 0;
}

int guestBack(const char *id) { MAIN_ONLY(GuestErrThread); ClaraeGuest *g = lookup(id); if (!g) return GuestErrUnknown; [g.view goBack]; return 0; }
int guestForward(const char *id) { MAIN_ONLY(GuestErrThread); ClaraeGuest *g = lookup(id); if (!g) return GuestErrUnknown; [g.view goForward]; return 0; }
int guestReload(const char *id) {
	MAIN_ONLY(GuestErrThread);
	ClaraeGuest *g = lookup(id);
	if (!g) return GuestErrUnknown;
	if (g.view.URL) {
		[g.view reload];
	} else if (g.lastURL) {
		// Nothing was ever shown (the first load failed, a certificate error among them): reload asks WebKit
		// to reload a page it does not have and does nothing, so the address is loaded again.
		[g.view loadRequest:[NSURLRequest requestWithURL:g.lastURL]];
	}
	return 0;
}

int guestFocus(const char *id) {
	MAIN_ONLY(GuestErrThread);
	ClaraeGuest *g = lookup(id);
	if (!g) return GuestErrUnknown;
	[g.window makeFirstResponder:g.view];
	return 0;
}

static void closeGuest(ClaraeGuest *g) {
	ClaraeGuestView *v = g.view;
	if (!v) return;
	for (NSString *k in @[@"URL", @"title", @"loading", @"canGoBack", @"canGoForward"]) {
		[v removeObserver:g forKeyPath:k];
	}
	[[NSNotificationCenter defaultCenter] removeObserver:g];
	v.navigationDelegate = nil;
	v.UIDelegate = nil;
	[v stopLoading];
	releaseFocus(g.window, v);
	[v removeFromSuperview];
	g.view = nil;
}

int guestClose(const char *id) {
	MAIN_ONLY(GuestErrThread);
	ClaraeGuest *g = lookup(id);
	if (!g) return GuestErrUnknown;
	closeGuest(g);
	[gGuests removeObjectForKey:g.gid];
	return 0;
}

void guestCloseAll(void) {
	if (![NSThread isMainThread]) { NSLog(@"clarae nativeview: called off the main thread"); return; }
	for (ClaraeGuest *g in [gGuests.allValues copy]) closeGuest(g);
	[gGuests removeAllObjects];
}

int guestRemoveData(const char *uuidC, long req) {
	MAIN_ONLY(GuestErrThread);
	if (@available(macOS 14.0, *)) {
		NSUUID *u = uuidC ? [[NSUUID alloc] initWithUUIDString:[NSString stringWithUTF8String:uuidC]] : nil;
		if (!u) { goGuestReply(req, 0, (char *)"invalid data store id"); return 0; }
		WKWebsiteDataStore *s = [WKWebsiteDataStore dataStoreForIdentifier:u];
		[s removeDataOfTypes:[WKWebsiteDataStore allWebsiteDataTypes] modifiedSince:[NSDate distantPast] completionHandler:^{
			// The data are gone. Taking the store itself away fails while a web view still holds it, and
			// that is not an error: the next guest of the vault gets an empty one.
			[WKWebsiteDataStore removeDataStoreForIdentifier:u completionHandler:^(NSError *err) {
				goGuestReply(req, 1, (char *)cstr(err ? err.localizedDescription : @""));
			}];
		}];
		return 0;
	}
	goGuestReply(req, 1, (char *)""); // before macOS 14 nothing is kept
	return 0;
}

// ---- test only --------------------------------------------------------------------------------

#ifdef CLARAE_NATIVEVIEW_TEST

int guestCount(void) { return (int)gGuests.count; }
int guestInspectable(const char *id) {
	ClaraeGuest *g = lookup(id);
	if (!g) return -1;
	if (@available(macOS 13.3, *)) return g.view.isInspectable ? 1 : 0;
	return 0;
}
int guestStoreKind(const char *id) { ClaraeGuest *g = lookup(id); return g ? g.storeKind : -1; }

int guestEval(const char *gidC, const char *js, long req) { // not "id": the type id is used below
	MAIN_ONLY(GuestErrThread);
	ClaraeGuest *g = lookup(gidC);
	if (!g) return GuestErrUnknown;
	[g.view callAsyncJavaScript:[NSString stringWithUTF8String:js] arguments:@{} inFrame:nil inContentWorld:[WKContentWorld pageWorld] completionHandler:^(id r, NSError *err) {
		if (err) { goGuestReply(req, 0, (char *)cstr(err.localizedDescription)); return; }
		NSString *s;
		if ([r isKindOfClass:[NSString class]]) s = r;
		else if (!r || r == [NSNull null]) s = @"null";
		else if ([NSJSONSerialization isValidJSONObject:r]) s = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:r options:0 error:nil] encoding:NSUTF8StringEncoding];
		else s = [r description];
		goGuestReply(req, 1, (char *)cstr(s));
	}];
	return 0;
}

int guestFrame(const char *id, double *x, double *y, double *w, double *h, double *cw, double *ch, int *hidden, int *firstResponder) {
	MAIN_ONLY(GuestErrThread);
	ClaraeGuest *g = lookup(id);
	if (!g) return GuestErrUnknown;
	NSView *cv = g.window.contentView;
	NSRect f = g.view.frame;
	CGFloat top = cv.isFlipped ? f.origin.y : cv.bounds.size.height - f.origin.y - f.size.height;
	*x = f.origin.x; *y = top; *w = f.size.width; *h = f.size.height;
	*cw = cv.bounds.size.width; *ch = cv.bounds.size.height;
	*hidden = g.view.hidden;
	NSResponder *r = g.window.firstResponder;
	*firstResponder = [r isKindOfClass:[NSView class]] && [(NSView *)r isDescendantOf:g.view];
	return 0;
}

int guestHitTest(const char *id, double x, double y) {
	MAIN_ONLY(GuestErrThread);
	ClaraeGuest *g = lookup(id);
	if (!g) return GuestErrUnknown;
	NSView *cv = g.window.contentView;
	CGFloat yy = cv.isFlipped ? y : cv.bounds.size.height - y;
	NSView *hit = [cv hitTest:[cv.superview convertPoint:NSMakePoint(x, yy) fromView:cv]];
	if (!hit) return 0;
	if ([hit isDescendantOf:g.view]) return 1;
	for (NSView *p = hit; p; p = p.superview) { if ([p isKindOfClass:[WKWebView class]]) return 2; }
	return 0;
}

void guestPostKey(void *nsWindow, const char *chars, const char *charsNoMods, unsigned short keyCode, unsigned long flags) {
	NSWindow *win = (__bridge NSWindow *)nsWindow;
	NSString *c = [NSString stringWithUTF8String:chars];
	NSString *cn = [NSString stringWithUTF8String:charsNoMods];
	for (int i = 0; i < 2; i++) {
		NSEvent *e = [NSEvent keyEventWithType:(i == 0 ? NSEventTypeKeyDown : NSEventTypeKeyUp)
			location:NSZeroPoint modifierFlags:(NSEventModifierFlags)flags
			timestamp:[NSProcessInfo processInfo].systemUptime windowNumber:win.windowNumber context:nil
			characters:c charactersIgnoringModifiers:cn isARepeat:NO keyCode:keyCode];
		[NSApp postEvent:e atStart:NO];
	}
}

void guestActivateApp(void) {
	// Cooperative activation (macOS 14): a process that is not frontmost may be refused; the test then
	// says the keys could not be tried. The old call is kept for the systems where it still works.
	[NSApp activateIgnoringOtherApps:YES];
	[[NSRunningApplication currentApplication] activateWithOptions:NSApplicationActivateIgnoringOtherApps];
	if (@available(macOS 14.0, *)) [NSApp activate];
	for (NSWindow *w in NSApp.windows) [w makeKeyAndOrderFront:nil];
}

void guestFocusMain(void *nsWindow) {
	NSWindow *win = (__bridge NSWindow *)nsWindow;
	for (NSView *s in win.contentView.subviews) {
		if ([s isKindOfClass:[WKWebView class]] && ![s isKindOfClass:[ClaraeGuestView class]]) {
			[win makeFirstResponder:s];
			return;
		}
	}
}

static NSEvent *keyEvent(NSWindow *win, NSEventType type, const char *chars, const char *charsNoMods, unsigned short keyCode, unsigned long flags) {
	return [NSEvent keyEventWithType:type location:NSZeroPoint modifierFlags:(NSEventModifierFlags)flags
		timestamp:[NSProcessInfo processInfo].systemUptime windowNumber:win.windowNumber context:nil
		characters:[NSString stringWithUTF8String:chars] charactersIgnoringModifiers:[NSString stringWithUTF8String:charsNoMods]
		isARepeat:NO keyCode:keyCode];
}

// A key event as the keyboard makes it: AppKit derives the characters from the key code and the layout in
// use (Shift applied to both "characters" and "charactersIgnoringModifiers"), as it does for a real key.
// Tests must not spell the characters: on another layout the same key code is another character.
static NSEvent *realKeyEvent(NSWindow *win, unsigned short keyCode, unsigned long flags) {
	CGEventRef cg = CGEventCreateKeyboardEvent(NULL, keyCode, true);
	CGEventSetFlags(cg, (CGEventFlags)flags);
	NSEvent *e = [NSEvent eventWithCGEvent:cg];
	CFRelease(cg);
	return e;
}

void guestKeyEquivalent(void *nsWindow, unsigned short keyCode, unsigned long flags, int *windowHandled, int *menuHandled, char *info, int n) {
	NSWindow *win = (__bridge NSWindow *)nsWindow;
	NSEvent *e = realKeyEvent(win, keyCode, flags);
	NSString *d = [NSString stringWithFormat:@"characters=%@ ignoring=%@ accelerator=%@", e.characters, e.charactersIgnoringModifiers, accelerator(e)];
	strncpy(info, d.UTF8String, n - 1);
	info[n - 1] = 0;
	*windowHandled = [win performKeyEquivalent:e];
	*menuHandled = 0;
	if (!*windowHandled) *menuHandled = [NSApp.mainMenu performKeyEquivalent:e];
}

void guestKeyDown(const char *gidC, const char *chars, unsigned short keyCode) {
	ClaraeGuest *g = lookup(gidC);
	if (!g) return;
	[g.view keyDown:keyEvent(g.window, NSEventTypeKeyDown, chars, chars, keyCode, 0)];
}

void guestAppState(void *nsWindow, int *active, int *key, int *main) {
	NSWindow *win = (__bridge NSWindow *)nsWindow;
	*active = NSApp.isActive;
	*key = win.isKeyWindow;
	*main = win.isMainWindow;
}

void guestResignFocus(void *nsWindow) { [((__bridge NSWindow *)nsWindow) makeFirstResponder:nil]; }

void guestPostClick(const char *id, double x, double y) {
	ClaraeGuest *g = lookup(id);
	if (!g) return;
	NSPoint inWindow = [g.view convertPoint:NSMakePoint(x, y) toView:nil];
	for (int i = 0; i < 2; i++) {
		NSEvent *e = [NSEvent mouseEventWithType:(i == 0 ? NSEventTypeLeftMouseDown : NSEventTypeLeftMouseUp)
			location:inWindow modifierFlags:0 timestamp:[NSProcessInfo processInfo].systemUptime
			windowNumber:g.window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:1.0];
		[NSApp postEvent:e atStart:NO];
	}
}

#endif
