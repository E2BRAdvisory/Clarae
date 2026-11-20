//go:build linux && cgo && gtk3 && !android && !server && !purego

// The native web views of the applications on Linux: see guest_linux.h.
//
// The build constraint above is the one of the binding of Wails for GTK3 (pkg/application/linux_cgo_gtk3.go): in any
// other build (GTK4, purego, no cgo) this file is not part of the package, and the Go tool must not see a C file.
//
// What a guest is allowed, in one place (the counterpart of the list at the top of guest_darwin.m):
//   - A WebKitWebView of a WebKitWebContext of its own (one per data store, i.e. per vault), with no
//     WebKitUserContentManager, no script message handler, no user script and no URI scheme registered: the
//     scheme of the application ("wails") lives on the default context of the web view of the application only,
//     so a guest cannot even name it; and nothing of the Wails runtime (the bridge, the events, the bindings)
//     exists in a page that is not the application's.
//   - Only http and https in the top frame (the policy of Go, and this file refuses the rest as well), and, in
//     frames inside the page, also about, blob and data (what pages build frames with).
//   - Downloads are cancelled, before they write anything. Permission requests (camera, microphone, location,
//     notifications, the storage access prompt, ...) are denied, and so is the file chooser. New windows are not
//     opened: the address is reported to Go. A certificate that is not trusted fails the load, with no way
//     to go on. A login (HTTP authentication, a client certificate) is cancelled, never answered.
//   - No inspector, no favicon database, no context menu item that opens a window or downloads, no printing,
//     no full screen, the dialogs of the page are answered by this file (alert is acknowledged, confirm says no,
//     prompt says nothing).
//
// Every function runs on the GTK main thread; the signal handlers do too, and they never wait for Go (the policy
// is a lookup and a parse; events are queued).
#include <gtk/gtk.h>
#include <gdk/gdk.h>
#include <gdk/gdkkeysyms.h>
#include <webkit2/webkit2.h>
#include <libsoup/soup.h>
#include <string.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include "guest_linux.h"

#ifdef CLARAE_NATIVEVIEW_TEST
#include <jsc/jsc.h>
#endif

// Implemented in Go (driver_linux.go). The strings are valid during the call only.
extern void goGuestEvent(char *id, int kind, char *a, char *b, int f1, int f2, int f3);
extern int goGuestPolicy(char *id, char *url, int frame, int redirect); // frame: GuestFrameMain, GuestFrameSub or GuestFrameUnknown
extern void goGuestMainFrame(char *id, char *url);        // the top frame of the guest starts to load url
extern void goGuestReply(long req, int ok, char *msg);

#define MAIN_ONLY(ret) do { if (!g_main_context_is_owner(NULL)) { g_warning("clarae nativeview: called off the main thread"); return ret; } } while (0)

// The least WebKitGTK that runs a guest: older ones are still in use on LTS systems, are not maintained and lack
// the hardening below. The page then opens in the system browser.
#define MIN_MAJOR 2
#define MIN_MINOR 40

static const char *or_empty(const char *s) { return s ? s : ""; }

static void emit(const char *gid, int kind, const char *a, const char *b, int f1, int f2, int f3) {
	goGuestEvent((char *)gid, kind, (char *)or_empty(a), (char *)or_empty(b), f1, f2, f3);
}

// ---- the state --------------------------------------------------------------------------------

// A store is the session of a vault: a context of WebKit with its own data folders. It lives until its data are
// deleted (guestReleaseStore) or the application quits, so a second tab of the same vault shares the cookies and
// the processes of the first.
typedef struct Store {
	char *name;
	WebKitWebContext *ctx;
	WebKitWebsiteDataManager *dm; // owned by ctx
	int guests;
	gboolean clearing; // guestReleaseStore is waiting for WebKit: a second one must not free the store under it
} Store;

typedef struct Guest {
	char *gid;
	GtkWidget *view;
	Store *store;
	double nx, ny, nw, nh; // fractions of the overlay, origin top-left
	gint64 lastActivity;   // monotonic µs: the last EvActivity sent
	gint64 lastUserEvent;  // the last key, click or scroll in the guest (not throttled)
	char *lastURL;         // the last address a load was asked for: what Reload retries when nothing was shown
	char *lastNewWindowURL;
	gint64 lastNewWindow;
	char *tlsFailedURI;    // the load that failed on a certificate: its load-failed is not reported twice
	gboolean failed;       // the last load failed
	int clicks;            // button presses that reached the guest (test)
} Guest;

static GHashTable *gGuests;   // gid -> Guest*
static GHashTable *gStores;   // name -> Store*
static GHashTable *gReserved; // accelerator -> 1
static GtkWindow *gWindow;
static GtkWidget *gOverlay;   // the GtkOverlay that holds the web view of the application and the guests
static GtkWidget *gAppView;   // the web view of the application (Wails'); weak
static int gGraftState;       // 0 not tried, 1 done, -1 failed
static char gGraftWhy[256];
#ifdef CLARAE_NATIVEVIEW_TEST
static int gAppClicks;        // button presses that reached the web view of the application
#endif

static const char *kGuestKey = "clarae-guest";

static Guest *lookup(const char *id) { return (id && gGuests) ? g_hash_table_lookup(gGuests, id) : NULL; }
static Guest *guestOfWidget(GtkWidget *w) { return w ? g_object_get_data(G_OBJECT(w), kGuestKey) : NULL; }

// ---- the version ------------------------------------------------------------------------------

int guestOnMainThread(void) { return g_main_context_is_owner(NULL) ? 1 : 0; }

int guestWebKitOK(char *why, int n) {
	guint major = webkit_get_major_version(), minor = webkit_get_minor_version();
	if (major > MIN_MAJOR || (major == MIN_MAJOR && minor >= MIN_MINOR)) return 1;
	if (why && n > 0) snprintf(why, n, "WebKitGTK %u.%u is older than %d.%d", major, minor, MIN_MAJOR, MIN_MINOR);
	return 0;
}

// ---- the graft --------------------------------------------------------------------------------

static void fail_graft(char *why, int n, const char *msg) {
	snprintf(gGraftWhy, sizeof gGraftWhy, "%s", msg);
	gGraftState = -1;
	if (why && n > 0) snprintf(why, n, "%s", msg);
}

static gboolean onChildPosition(GtkOverlay *ov, GtkWidget *child, GdkRectangle *alloc, gpointer data);
#ifdef CLARAE_NATIVEVIEW_TEST
static gboolean onAppButton(GtkWidget *w, GdkEventButton *e, gpointer data) { gAppClicks++; return FALSE; }
#endif

// graft puts a GtkOverlay where the web view of the application is, and the web view inside it, so that a
// guest can be added above it. Wails builds GtkWindow > GtkBox "webview-box" > [menu bar] + WebKitWebView
// (windowNew in pkg/application/linux_cgo_gtk3.go); the web view is taken out of the box (with a reference, so it
// is never finalised), put in the overlay, and the overlay packed in the box in its place, with the same packing.
// Wails keeps the pointer of its web view and nothing else of the box, so everything it does goes on working.
// A window that is not made like that (another version of Wails, another toolkit) is left alone and the platform is
// reported unavailable. Called once; the verdict is kept.
static int graft(GtkWindow *win, char *why, int n) {
	if (gGraftState == 1) {
		if (win == gWindow) return 0;
		if (why && n > 0) snprintf(why, n, "the window changed");
		return GuestErrUnavailable;
	}
	if (gGraftState < 0) {
		if (why && n > 0) snprintf(why, n, "%s", gGraftWhy);
		return GuestErrUnavailable;
	}
	if (!win || !GTK_IS_WINDOW(win)) { fail_graft(why, n, "the native window is not a GtkWindow"); return GuestErrUnavailable; }
	GtkWidget *box = gtk_bin_get_child(GTK_BIN(win));
	if (!box || !GTK_IS_BOX(box) || g_strcmp0(gtk_widget_get_name(box), "webview-box") != 0) {
		fail_graft(why, n, "the window has no \"webview-box\" (an unexpected version of the window toolkit of Wails)");
		return GuestErrUnavailable;
	}
	GList *kids = gtk_container_get_children(GTK_CONTAINER(box));
	GtkWidget *wv = NULL;
	int pos = 0, i = 0, count = 0;
	for (GList *l = kids; l; l = l->next, i++) {
		if (WEBKIT_IS_WEB_VIEW(l->data)) {
			count++;
			wv = l->data;
			pos = i;
		}
	}
	g_list_free(kids);
	if (count != 1) {
		fail_graft(why, n, count == 0 ? "the window has no web view in its box" : "the window has more than one web view in its box");
		return GuestErrUnavailable;
	}

	gboolean expand = FALSE, fill = FALSE;
	guint padding = 0;
	GtkPackType packType = GTK_PACK_START;
	gtk_box_query_child_packing(GTK_BOX(box), wv, &expand, &fill, &padding, &packType);
	gboolean hadFocus = gtk_widget_is_focus(wv);

	GtkWidget *overlay = gtk_overlay_new();
	g_object_ref(wv); // the box lets go of it when it is removed: nothing must finalise it
	gtk_container_remove(GTK_CONTAINER(box), wv);
	gtk_container_add(GTK_CONTAINER(overlay), wv);
	if (packType == GTK_PACK_END) gtk_box_pack_end(GTK_BOX(box), overlay, expand, fill, padding);
	else gtk_box_pack_start(GTK_BOX(box), overlay, expand, fill, padding);
	gtk_box_reorder_child(GTK_BOX(box), overlay, pos);
	// A guest is placed by the overlay asking for its position (onChildPosition), from fractions of the
	// area of the overlay: a resize of the window, of the menu bar or of anything around it follows with no
	// signal of ours.
	g_signal_connect(overlay, "get-child-position", G_CALLBACK(onChildPosition), NULL);
	gtk_widget_show(overlay);
	g_object_unref(wv);
	if (hadFocus) gtk_widget_grab_focus(wv);

	gWindow = win;
	gOverlay = overlay;
	gAppView = wv;
	g_object_add_weak_pointer(G_OBJECT(overlay), (gpointer *)&gOverlay);
	g_object_add_weak_pointer(G_OBJECT(wv), (gpointer *)&gAppView);
#ifdef CLARAE_NATIVEVIEW_TEST
	g_signal_connect(wv, "button-press-event", G_CALLBACK(onAppButton), NULL);
#endif
	gGraftState = 1;
	return 0;
}

// onChildPosition says where a guest goes, in the coordinates of the overlay. It is asked at every allocation.
static gboolean onChildPosition(GtkOverlay *ov, GtkWidget *child, GdkRectangle *alloc, gpointer data) {
	Guest *g = guestOfWidget(child);
	if (!g) return FALSE;
	int W = gtk_widget_get_allocated_width(GTK_WIDGET(ov)), H = gtk_widget_get_allocated_height(GTK_WIDGET(ov));
	// The edges are rounded, not the sizes, so two views that touch in fractions touch in pixels too.
	int x0 = (int)(g->nx * W + 0.5), y0 = (int)(g->ny * H + 0.5);
	int x1 = (int)((g->nx + g->nw) * W + 0.5), y1 = (int)((g->ny + g->nh) * H + 0.5);
	if (x1 > W) x1 = W;
	if (y1 > H) y1 = H;
	alloc->x = x0;
	alloc->y = y0;
	alloc->width = x1 > x0 ? x1 - x0 : 1; // never nothing: GTK does not allocate a size of 0
	alloc->height = y1 > y0 ? y1 - y0 : 1;
	return TRUE;
}

static void relayout(void) {
	if (gOverlay) gtk_widget_queue_resize(gOverlay);
}

// ---- keys -------------------------------------------------------------------------------------

// keyName is the key of an accelerator in the syntax of webview.ParseAccelerator, or NULL. The key is what the
// keyboard makes with no modifier at all (Ctrl+Shift+1 is "ctrl+shift+1", not "ctrl+shift+!").
static const char *keyName(const GdkEventKey *e, char *buf, size_t n) {
	guint kv = e->keyval;
	GdkKeymap *km = gdk_keymap_get_for_display(gdk_display_get_default());
	if (km && e->hardware_keycode) {
		guint bare = 0;
		if (gdk_keymap_translate_keyboard_state(km, e->hardware_keycode, 0, e->group, &bare, NULL, NULL, NULL) && bare) kv = bare;
	}
	kv = gdk_keyval_to_lower(kv);
	if (kv >= GDK_KEY_F1 && kv <= GDK_KEY_F20) { snprintf(buf, n, "f%u", kv - GDK_KEY_F1 + 1); return buf; }
	switch (kv) {
	case GDK_KEY_Up: case GDK_KEY_KP_Up: return "up";
	case GDK_KEY_Down: case GDK_KEY_KP_Down: return "down";
	case GDK_KEY_Left: case GDK_KEY_KP_Left: return "left";
	case GDK_KEY_Right: case GDK_KEY_KP_Right: return "right";
	case GDK_KEY_Home: case GDK_KEY_KP_Home: return "home";
	case GDK_KEY_End: case GDK_KEY_KP_End: return "end";
	case GDK_KEY_Page_Up: case GDK_KEY_KP_Page_Up: return "pageup";
	case GDK_KEY_Page_Down: case GDK_KEY_KP_Page_Down: return "pagedown";
	case GDK_KEY_Delete: case GDK_KEY_KP_Delete: return "delete";
	case GDK_KEY_BackSpace: return "backspace";
	case GDK_KEY_Return: case GDK_KEY_KP_Enter: case GDK_KEY_ISO_Enter: return "enter";
	case GDK_KEY_Tab: case GDK_KEY_ISO_Left_Tab: case GDK_KEY_KP_Tab: return "tab";
	case GDK_KEY_Escape: return "escape";
	case GDK_KEY_space: case GDK_KEY_KP_Space: return "space";
	case GDK_KEY_plus: case GDK_KEY_KP_Add: return "plus";
	}
	gunichar u = gdk_keyval_to_unicode(kv);
	if (u > ' ' && u < 0x7f) { buf[0] = (char)g_ascii_tolower((gchar)u); buf[1] = 0; return buf; }
	return NULL;
}

// accelerator writes the key with its modifiers: ctrl, alt, shift, then the key. A key with the logo key is
// never an accelerator (the keyboard of Linux has no "cmd").
static gboolean accelerator(const GdkEventKey *e, char *out, size_t n) {
	if (e->state & (GDK_SUPER_MASK | GDK_META_MASK | GDK_HYPER_MASK)) return FALSE;
	char key[16];
	const char *k = keyName(e, key, sizeof key);
	if (!k) return FALSE;
	snprintf(out, n, "%s%s%s%s", (e->state & GDK_CONTROL_MASK) ? "ctrl+" : "", (e->state & GDK_MOD1_MASK) ? "alt+" : "",
		(e->state & GDK_SHIFT_MASK) ? "shift+" : "", k);
	return TRUE;
}

void guestReserveKeys(const char *csv) {
	if (!g_main_context_is_owner(NULL)) { g_warning("clarae nativeview: called off the main thread"); return; }
	GHashTable *set = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
	gchar **parts = g_strsplit(csv ? csv : "", ",", -1);
	for (gchar **p = parts; *p; p++) {
		if (**p) g_hash_table_replace(set, g_strdup(*p), GINT_TO_POINTER(1));
	}
	g_strfreev(parts);
	if (gReserved) g_hash_table_destroy(gReserved);
	gReserved = set;
}

// ---- activity, focus and keys of a guest --------------------------------------------------------

// The pointer and the keys of a guest never reach the web view of the application, which is what the idle lock
// of a private vault listens to: tell Go that the user is working, now and then.
static void noteActivity(Guest *g) {
	gint64 now = g_get_monotonic_time();
	g->lastUserEvent = now;
	if (now - g->lastActivity < 5 * G_USEC_PER_SEC && g->lastActivity != 0) return;
	g->lastActivity = now;
	emit(g->gid, GuestEvActivity, "", "", 0, 0, 0);
}

// userGesture: the user worked in the guest a moment ago and it is shown. A window that a page asks for with no
// one in front of it is not forwarded to the system browser.
static int userGesture(Guest *g) {
	return gtk_widget_get_visible(g->view) && g->lastUserEvent != 0 && g_get_monotonic_time() - g->lastUserEvent < 2 * G_USEC_PER_SEC ? 1 : 0;
}

// onKeyPress hands a reserved accelerator to Go (and so to the command of the application of the same name) and
// consumes it. It sees only the keys of a guest that has the focus.
static gboolean onKeyPress(GtkWidget *w, GdkEventKey *e, gpointer data) {
	Guest *g = data;
	noteActivity(g);
	char acc[64];
	if (gReserved && accelerator(e, acc, sizeof acc) && g_hash_table_contains(gReserved, acc)) {
		emit(g->gid, GuestEvKey, acc, "", 0, 0, 0);
		return TRUE;
	}
	return FALSE;
}
static gboolean onButtonPress(GtkWidget *w, GdkEventButton *e, gpointer data) { Guest *g = data; g->clicks++; noteActivity(g); return FALSE; }
static gboolean onScroll(GtkWidget *w, GdkEventScroll *e, gpointer data) { noteActivity(data); return FALSE; }
static gboolean onFocusIn(GtkWidget *w, GdkEventFocus *e, gpointer data) {
	Guest *g = data;
	emit(g->gid, GuestEvFocus, "", "", 0, 0, 0);
	return FALSE;
}

// ---- state ------------------------------------------------------------------------------------

static void pushState(Guest *g) {
	WebKitWebView *v = WEBKIT_WEB_VIEW(g->view);
	emit(g->gid, GuestEvState, webkit_web_view_get_uri(v), webkit_web_view_get_title(v), webkit_web_view_is_loading(v),
		webkit_web_view_can_go_back(v), webkit_web_view_can_go_forward(v));
}
static void onNotify(GObject *o, GParamSpec *p, gpointer data) { pushState(data); }
// The active address of the guest changed: the top frame starts to load something (the requested address, when the load
// starts; the one it is sent to, on a redirect; the final one, when it commits) or moves inside the page. The decisions of
// the policy do not say which frame they are for (see frameOf), so Go is told here where the top frame is: that, and not
// a decision, is where the page is. It is not the address at load-changed STARTED, which is still the old one.
static void onNotifyURI(GObject *o, GParamSpec *p, gpointer data) {
	Guest *g = data;
	pushState(g);
	const char *uri = webkit_web_view_get_uri(WEBKIT_WEB_VIEW(g->view));
	if (uri && *uri) goGuestMainFrame(g->gid, (char *)uri);
}
static void onHistoryChanged(WebKitBackForwardList *l, WebKitBackForwardListItem *added, gpointer removed, gpointer data) { pushState(data); }
static void onLoadChanged(WebKitWebView *v, WebKitLoadEvent ev, gpointer data) {
	Guest *g = data;
	if (ev == WEBKIT_LOAD_COMMITTED) g->failed = FALSE;
}

static gboolean isHTTP(const char *uri) {
	return uri && (g_ascii_strncasecmp(uri, "http://", 7) == 0 || g_ascii_strncasecmp(uri, "https://", 8) == 0);
}

static char *hostOf(const char *uri) {
	if (!uri) return g_strdup("");
	GUri *u = g_uri_parse(uri, G_URI_FLAGS_PARSE_RELAXED | G_URI_FLAGS_ENCODED, NULL);
	char *h = g_strdup(u && g_uri_get_host(u) ? g_uri_get_host(u) : "");
	if (u) g_uri_unref(u);
	return h;
}

// ---- navigation -------------------------------------------------------------------------------

// frameOf says which frame a navigation is for. WebKitGTK does not tell: the decision for a frame inside the page is
// the same as the one for the top frame (no frame in the action, no name, no "Sec-Fetch-Dest" in the request at this
// point; the live test shows it). A navigation to about, blob or data can only be a frame (it is what pages build frames
// with, and WebKit itself refuses to let a page take the top frame to a data URL). Anything else is unknown: Go judges
// it by the rules of the top frame, which are the stricter ones (a frame that points at a private host from a public
// page is refused, a scheme other than http and https is refused), without taking it for the place of the top frame,
// which load-changed tells (onLoadChanged). It is a difference from macOS and Windows (ADR-0062).
static int frameOf(const char *uri) {
	if (g_ascii_strncasecmp(uri, "about:", 6) == 0 || g_ascii_strncasecmp(uri, "blob:", 5) == 0 || g_ascii_strncasecmp(uri, "data:", 5) == 0) return GuestFrameSub;
	return GuestFrameUnknown;
}

static gboolean onDecidePolicy(WebKitWebView *v, WebKitPolicyDecision *d, WebKitPolicyDecisionType type, gpointer data) {
	Guest *g = data;
	switch (type) {
	case WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION: {
		WebKitNavigationAction *a = webkit_navigation_policy_decision_get_navigation_action(WEBKIT_NAVIGATION_POLICY_DECISION(d));
		const char *uri = or_empty(webkit_uri_request_get_uri(webkit_navigation_action_get_request(a)));
		int frame = frameOf(uri);
#ifdef CLARAE_NATIVEVIEW_TRACE
		{
			SoupMessageHeaders *hh = webkit_uri_request_get_http_headers(webkit_navigation_action_get_request(a));
			const char *dest = hh ? soup_message_headers_get_one(hh, "Sec-Fetch-Dest") : NULL;
			const char *mode = hh ? soup_message_headers_get_one(hh, "Sec-Fetch-Mode") : NULL;
			const char *ref = hh ? soup_message_headers_get_one(hh, "Referer") : NULL;
			fprintf(stderr, "TRACE navigation %s frame=%d frame-name=%s type=%d redirect=%d dest=%s mode=%s referer=%s\n", uri, frame,
				or_empty(webkit_navigation_action_get_frame_name(a)), (int)webkit_navigation_action_get_navigation_type(a),
				webkit_navigation_action_is_redirect(a), or_empty(dest), or_empty(mode), or_empty(ref));
		}
#endif
		// Go judges (the rules of webview.ValidateURL, the private network, the view it is) and reports what it
		// refuses; the scheme is checked here as well, so that a mistake of one side is not the end.
		int allow = goGuestPolicy(g->gid, (char *)uri, frame, webkit_navigation_action_is_redirect(a) ? 1 : 0);
		gboolean schemeOK = isHTTP(uri) || frame == GuestFrameSub;
		if (allow && !schemeOK) emit(g->gid, GuestEvBlocked, uri, "scheme", 0, 0, 0);
		if (allow && schemeOK) webkit_policy_decision_use(d);
		else webkit_policy_decision_ignore(d);
		return TRUE;
	}
	case WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION: {
		// target=_blank, window.open: nothing is opened here, the address goes to Go.
		WebKitNavigationAction *a = webkit_navigation_policy_decision_get_navigation_action(WEBKIT_NAVIGATION_POLICY_DECISION(d));
		const char *uri = or_empty(webkit_uri_request_get_uri(webkit_navigation_action_get_request(a)));
		g_free(g->lastNewWindowURL);
		g->lastNewWindowURL = g_strdup(uri);
		g->lastNewWindow = g_get_monotonic_time();
		emit(g->gid, GuestEvNewWindow, uri, "", userGesture(g), 0, 0);
		webkit_policy_decision_ignore(d);
		return TRUE;
	}
	case WEBKIT_POLICY_DECISION_TYPE_RESPONSE: {
		WebKitResponsePolicyDecision *rd = WEBKIT_RESPONSE_POLICY_DECISION(d);
		if (!webkit_response_policy_decision_is_main_frame_main_resource(rd)) return FALSE; // a frame: what it is, is judged by its navigation
		gboolean attachment = FALSE;
		WebKitURIResponse *resp = webkit_response_policy_decision_get_response(rd);
		SoupMessageHeaders *h = resp ? webkit_uri_response_get_http_headers(resp) : NULL;
		if (h) {
			char *disp = NULL;
			if (soup_message_headers_get_content_disposition(h, &disp, NULL) && disp && g_ascii_strcasecmp(disp, "attachment") == 0) attachment = TRUE;
			g_free(disp);
		}
		if (attachment || !webkit_response_policy_decision_is_mime_type_supported(rd)) {
			emit(g->gid, GuestEvDownload, resp ? webkit_uri_response_get_uri(resp) : "", "", 0, 0, 0);
			webkit_policy_decision_ignore(d);
			return TRUE;
		}
		return FALSE;
	}
	default:
		return FALSE;
	}
}

// create answers window.open and the like: nothing is opened. The address is reported unless the decision of the
// policy has just done it.
static GtkWidget *onCreate(WebKitWebView *v, WebKitNavigationAction *a, gpointer data) {
	Guest *g = data;
	const char *uri = or_empty(webkit_uri_request_get_uri(webkit_navigation_action_get_request(a)));
	gboolean dup = g->lastNewWindowURL && g_strcmp0(g->lastNewWindowURL, uri) == 0 && g_get_monotonic_time() - g->lastNewWindow < G_USEC_PER_SEC / 2;
	if (!dup) emit(g->gid, GuestEvNewWindow, uri, "", userGesture(g), 0, 0);
	return NULL;
}

// A login is cancelled: the handling of the system would offer a server that the page chose what the system keeps.
static gboolean onAuthenticate(WebKitWebView *v, WebKitAuthenticationRequest *r, gpointer data) {
	Guest *g = data;
	char *host = hostOf(webkit_web_view_get_uri(v));
	const char *realmHost = webkit_authentication_request_get_host(r);
	emit(g->gid, GuestEvBlocked, realmHost && *realmHost ? realmHost : host, "authentication", 1, 0, 0);
	g_free(host);
	webkit_authentication_request_cancel(r);
	return TRUE;
}

static gboolean isOurCancel(const GError *err) {
	if (!err) return FALSE;
	if (err->domain == WEBKIT_NETWORK_ERROR && err->code == WEBKIT_NETWORK_ERROR_CANCELLED) return TRUE;
	// A load that a policy ended (a refused navigation, a download that was turned into a cancel).
	return err->domain == WEBKIT_POLICY_ERROR;
}

static gboolean onLoadFailed(WebKitWebView *v, WebKitLoadEvent ev, const char *uri, GError *err, gpointer data) {
	Guest *g = data;
	if (g->tlsFailedURI && g_strcmp0(g->tlsFailedURI, uri) == 0) { // reported by the certificate handler
		g_free(g->tlsFailedURI);
		g->tlsFailedURI = NULL;
		g->failed = TRUE;
		return FALSE;
	}
	if (!isOurCancel(err)) {
		g->failed = TRUE;
		emit(g->gid, GuestEvError, uri, err ? err->message : "", err ? err->code : 0, 0, 0);
	}
	pushState(g);
	return FALSE;
}

static const char *tlsText(GTlsCertificateFlags f) {
	if (f & G_TLS_CERTIFICATE_EXPIRED) return "the certificate of the site has expired";
	if (f & G_TLS_CERTIFICATE_NOT_ACTIVATED) return "the certificate of the site is not valid yet";
	if (f & G_TLS_CERTIFICATE_REVOKED) return "the certificate of the site was revoked";
	if (f & G_TLS_CERTIFICATE_BAD_IDENTITY) return "the name of the certificate does not match the site";
	if (f & G_TLS_CERTIFICATE_UNKNOWN_CA) return "the certificate of the site was issued by an authority that is not trusted";
	if (f & G_TLS_CERTIFICATE_INSECURE) return "the certificate of the site uses an algorithm that is not secure";
	return "the certificate of the site is not valid";
}

// A certificate that is not trusted fails the load, and there is no way to go on: the handler never allows an
// exception for the host (webkit_web_view_load_failed_with_tls_errors leaves it to the default, which is to fail).
static gboolean onTLSErrors(WebKitWebView *v, const char *uri, GTlsCertificate *cert, GTlsCertificateFlags flags, gpointer data) {
	Guest *g = data;
	g_free(g->tlsFailedURI);
	g->tlsFailedURI = g_strdup(uri);
	g->failed = TRUE;
	emit(g->gid, GuestEvError, uri, tlsText(flags), (int)flags, 1, 0);
	pushState(g);
	return FALSE;
}

static gboolean onProcessTerminated(WebKitWebView *v, WebKitWebProcessTerminationReason reason, gpointer data) {
	Guest *g = data;
	emit(g->gid, GuestEvCrash, "", "", 0, 0, 0);
	return FALSE;
}

// ---- what a page asks ---------------------------------------------------------------------------

static const char *permissionName(WebKitPermissionRequest *r) {
	if (WEBKIT_IS_GEOLOCATION_PERMISSION_REQUEST(r)) return "geolocation";
	if (WEBKIT_IS_NOTIFICATION_PERMISSION_REQUEST(r)) return "notifications";
	if (WEBKIT_IS_USER_MEDIA_PERMISSION_REQUEST(r)) return "media-capture";
	if (WEBKIT_IS_DEVICE_INFO_PERMISSION_REQUEST(r)) return "media-devices";
	if (WEBKIT_IS_MEDIA_KEY_SYSTEM_PERMISSION_REQUEST(r)) return "media-key-system";
	if (WEBKIT_IS_INSTALL_MISSING_MEDIA_PLUGINS_PERMISSION_REQUEST(r)) return "media-plugins";
	if (WEBKIT_IS_WEBSITE_DATA_ACCESS_PERMISSION_REQUEST(r)) return "storage-access";
	if (WEBKIT_IS_POINTER_LOCK_PERMISSION_REQUEST(r)) return "pointer-lock";
#if WEBKIT_CHECK_VERSION(2, 40, 0)
	if (WEBKIT_IS_CLIPBOARD_PERMISSION_REQUEST(r)) return "clipboard-read";
#endif
	return "unknown";
}

// Every permission request is denied, and shown to the user as a notice in the tab.
static gboolean onPermission(WebKitWebView *v, WebKitPermissionRequest *r, gpointer data) {
	Guest *g = data;
	char *host = hostOf(webkit_web_view_get_uri(v));
	emit(g->gid, GuestEvPermission, permissionName(r), host, 0, 0, 0);
	g_free(host);
	webkit_permission_request_deny(r);
	return TRUE;
}

static gboolean onFileChooser(WebKitWebView *v, WebKitFileChooserRequest *r, gpointer data) {
	Guest *g = data;
	char *host = hostOf(webkit_web_view_get_uri(v));
	emit(g->gid, GuestEvPermission, "file-chooser", host, 0, 0, 0);
	g_free(host);
	webkit_file_chooser_request_cancel(r);
	return TRUE;
}

// The dialogs of the page: an alert is acknowledged, a confirm says no, a prompt says nothing. A page that
// asks "leave this page?" is answered yes: the guest is not held by it.
static gboolean onScriptDialog(WebKitWebView *v, WebKitScriptDialog *d, gpointer data) {
	switch (webkit_script_dialog_get_dialog_type(d)) {
	case WEBKIT_SCRIPT_DIALOG_CONFIRM: webkit_script_dialog_confirm_set_confirmed(d, FALSE); break;
	case WEBKIT_SCRIPT_DIALOG_PROMPT: webkit_script_dialog_prompt_set_text(d, NULL); break;
	case WEBKIT_SCRIPT_DIALOG_BEFORE_UNLOAD_CONFIRM: webkit_script_dialog_confirm_set_confirmed(d, TRUE); break;
	default: break;
	}
	return TRUE;
}

// The context menu of WebKit offers to open a link in a new window, to download and to inspect: none of them is wanted.
static gboolean onContextMenu(WebKitWebView *v, WebKitContextMenu *menu, WebKitHitTestResult *hit, gpointer data) {
	GList *items = g_list_copy(webkit_context_menu_get_items(menu));
	for (GList *l = items; l; l = l->next) {
		WebKitContextMenuItem *it = l->data;
		switch (webkit_context_menu_item_get_stock_action(it)) {
		case WEBKIT_CONTEXT_MENU_ACTION_OPEN_LINK_IN_NEW_WINDOW:
		case WEBKIT_CONTEXT_MENU_ACTION_DOWNLOAD_LINK_TO_DISK:
		case WEBKIT_CONTEXT_MENU_ACTION_OPEN_IMAGE_IN_NEW_WINDOW:
		case WEBKIT_CONTEXT_MENU_ACTION_DOWNLOAD_IMAGE_TO_DISK:
		case WEBKIT_CONTEXT_MENU_ACTION_OPEN_FRAME_IN_NEW_WINDOW:
		case WEBKIT_CONTEXT_MENU_ACTION_OPEN_VIDEO_IN_NEW_WINDOW:
		case WEBKIT_CONTEXT_MENU_ACTION_DOWNLOAD_VIDEO_TO_DISK:
		case WEBKIT_CONTEXT_MENU_ACTION_OPEN_AUDIO_IN_NEW_WINDOW:
		case WEBKIT_CONTEXT_MENU_ACTION_DOWNLOAD_AUDIO_TO_DISK:
		case WEBKIT_CONTEXT_MENU_ACTION_INSPECT_ELEMENT:
			webkit_context_menu_remove(menu, it);
			break;
		default:
			break;
		}
	}
	g_list_free(items);
	return FALSE;
}

static gboolean onPrint(WebKitWebView *v, WebKitPrintOperation *op, gpointer data) { return TRUE; } // window.print(): nothing
static gboolean onShowNotification(WebKitWebView *v, WebKitNotification *n, gpointer data) { return TRUE; }
static gboolean onClose(WebKitWebView *v, gpointer data) { return TRUE; }

// A download that starts all the same (a response WebKit turns into one) is cancelled before it writes anything.
static gboolean onDecideDestination(WebKitDownload *dl, const char *suggested, gpointer data) { webkit_download_cancel(dl); return TRUE; }
static void onDownloadStarted(WebKitWebContext *ctx, WebKitDownload *dl, gpointer data) {
	WebKitWebView *v = webkit_download_get_web_view(dl);
	Guest *g = v ? guestOfWidget(GTK_WIDGET(v)) : NULL;
	WebKitURIRequest *req = webkit_download_get_request(dl);
	if (g) emit(g->gid, GuestEvDownload, req ? webkit_uri_request_get_uri(req) : "", "", 0, 0, 0);
	g_signal_connect(dl, "decide-destination", G_CALLBACK(onDecideDestination), NULL);
	webkit_download_cancel(dl);
}

// ---- stores -----------------------------------------------------------------------------------

// sandboxProblem says why the sandbox of WebKit (bubblewrap) cannot be had in this process, "" when it can. A guest
// never runs without it: a page of the web is untrusted content, and the web process is what runs it. It is asked
// once. WebKit makes its sandbox opt-in for an application (webkit_web_context_set_sandbox_enabled), turns it off for
// the whole process when WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS is set, and cannot make it where bwrap is missing or
// may not create the namespaces it asks for (a container without privileges, a system with user namespaces off).
static const char *sandboxProblem(void) {
	static gboolean done;
	static char why[300];
	if (done) return why;
	done = TRUE;
	const char *off = g_getenv("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS");
	if (off && *off) {
		snprintf(why, sizeof why, "the sandbox of WebKit is turned off by WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS");
		return why;
	}
	char *bwrap = g_find_program_in_path("bwrap");
	if (!bwrap) {
		snprintf(why, sizeof why, "bubblewrap (bwrap) is not installed: the web processes of a guest need its sandbox");
		return why;
	}
	// What WebKit asks of bwrap for a web process (BubblewrapLauncher.cpp): a namespace each for hostname, processes,
	// network and IPC, a /proc of its own, and no user namespace of its own (bwrap makes one when the user is not
	// privileged, which is the case on a desktop; a root in a container has none, and then needs the capability to
	// set the loopback up, which is how this was found). The command does nothing. A launch that fails after this
	// check is not survivable: WebKit aborts the application when its auxiliary process dies at once (g_error in
	// readPIDFromPeer), so the check must be as demanding as the real thing.
	// It also loads a seccomp filter as WebKit does (one that allows everything: what matters is that the kernel, and an
	// emulator under it, take the prctl), because that is what fails under QEMU and old kernels.
	char *bpf = NULL;
	GError *e = NULL;
	int fd = g_file_open_tmp("clarae-bpf-XXXXXX", &bpf, &e);
	if (fd < 0) {
		snprintf(why, sizeof why, "no temporary file for the check of the sandbox (%s)", e ? e->message : "?");
		if (e) g_error_free(e);
		g_free(bwrap);
		return why;
	}
	static const unsigned char allow[8] = {0x06, 0, 0, 0, 0, 0, 0xff, 0x7f}; // struct sock_filter {BPF_RET|BPF_K, 0, 0, SECCOMP_RET_ALLOW}
	gboolean wrote = write(fd, allow, sizeof allow) == (ssize_t)sizeof allow;
	close(fd);
	char *argv[] = {"/bin/sh", "-c",
		"exec \"$1\" --unshare-uts --unshare-pid --unshare-net --unshare-ipc --die-with-parent --ro-bind / / --dev /dev --proc /proc --seccomp 3 true 3<\"$2\"",
		"sh", bwrap, bpf, NULL};
	char *errout = NULL;
	int status = 0;
	gboolean ok = wrote && g_spawn_sync(NULL, argv, NULL, G_SPAWN_STDOUT_TO_DEV_NULL, NULL, NULL, NULL, &errout, &status, &e) &&
		g_spawn_check_wait_status(status, NULL);
	unlink(bpf);
	g_free(bpf);
	if (!ok) {
		char *line = errout ? g_strstrip(errout) : NULL;
		if (line) { char *nl = strchr(line, '\n'); if (nl) *nl = 0; }
		snprintf(why, sizeof why, "bubblewrap cannot start a sandbox here (%s)", line && *line ? line : (e ? e->message : "it failed"));
	}
	if (e) g_error_free(e);
	g_free(errout);
	g_free(bwrap);
	return why;
}

static Store *storeOf(const char *name, const char *dataDir, const char *cacheDir) {
	if (!gStores) gStores = g_hash_table_new(g_str_hash, g_str_equal);
	Store *s = g_hash_table_lookup(gStores, name);
	if (s) return s;
	WebKitWebsiteDataManager *dm = webkit_website_data_manager_new("base-data-directory", dataDir, "base-cache-directory", cacheDir, NULL);
	// Cookies are kept across a restart, in the folder of the store (the rest of the data goes where the manager puts it).
	WebKitCookieManager *cm = webkit_website_data_manager_get_cookie_manager(dm);
	char *cookies = g_build_filename(dataDir, "cookies.sqlite", NULL);
	webkit_cookie_manager_set_persistent_storage(cm, cookies, WEBKIT_COOKIE_PERSISTENT_STORAGE_SQLITE);
	g_free(cookies);
	webkit_website_data_manager_set_itp_enabled(dm, TRUE);
	WebKitWebContext *ctx = webkit_web_context_new_with_website_data_manager(dm);
	g_object_unref(dm); // the context holds it
	// The sandbox, before the first web process of the context starts. It cannot be turned off again.
	webkit_web_context_set_sandbox_enabled(ctx, TRUE);
	if (!webkit_web_context_get_sandbox_enabled(ctx)) {
		g_object_unref(ctx);
		return NULL;
	}
	// Nothing is registered on this context: no URI scheme, no extension.
	g_signal_connect(ctx, "download-started", G_CALLBACK(onDownloadStarted), NULL);
	s = g_new0(Store, 1);
	s->name = g_strdup(name);
	s->ctx = ctx;
	s->dm = webkit_web_context_get_website_data_manager(ctx);
	g_hash_table_insert(gStores, s->name, s);
	return s;
}

// ---- creating a guest ---------------------------------------------------------------------------

static void setting(WebKitSettings *s) {
	webkit_settings_set_enable_developer_extras(s, FALSE);
	webkit_settings_set_javascript_can_open_windows_automatically(s, FALSE);
	webkit_settings_set_enable_write_console_messages_to_stdout(s, FALSE);
	webkit_settings_set_allow_file_access_from_file_urls(s, FALSE);
	webkit_settings_set_allow_universal_access_from_file_urls(s, FALSE);
	webkit_settings_set_enable_back_forward_navigation_gestures(s, FALSE);
#if !WEBKIT_CHECK_VERSION(2, 46, 0)
	webkit_settings_set_enable_hyperlink_auditing(s, FALSE); // removed (and always off) from 2.46
#endif
	webkit_settings_set_enable_fullscreen(s, FALSE);
	webkit_settings_set_media_playback_requires_user_gesture(s, TRUE);
	webkit_settings_set_enable_media_stream(s, FALSE);
#if WEBKIT_CHECK_VERSION(2, 38, 0)
	webkit_settings_set_enable_webrtc(s, FALSE);
#endif
	webkit_settings_set_enable_site_specific_quirks(s, TRUE);
	// The user agent is the default one of WebKitGTK, which ends in Safari/605.1.15 like the one of Safari: a
	// site that sniffs for an unknown browser serves it less (the application of Wails adds its own name to its
	// own settings, not to these).
}

static void destroyGuest(Guest *g);

int guestCreate(void *gtkWindow, const char *id, const char *url, double x, double y, double w, double h,
	const char *store, const char *dataDir, const char *cacheDir, char *err, int errn) {
	MAIN_ONLY(GuestErrThread);
	char why[256] = "";
	if (!guestWebKitOK(why, sizeof why)) { if (err && errn > 0) snprintf(err, errn, "%s", why); return GuestErrUnavailable; }
	const char *sp = sandboxProblem();
	if (*sp) { if (err && errn > 0) snprintf(err, errn, "%s", sp); return GuestErrUnavailable; }
	if (!gtkWindow) return GuestErrNoWindow;
	if (!gGuests) gGuests = g_hash_table_new(g_str_hash, g_str_equal);
	if (!gReserved) guestReserveKeys("");
	if (!id || !*id || g_hash_table_contains(gGuests, id)) return GuestErrExists;
	if (!isHTTP(url)) return GuestErrURL;
	if (!store || !*store || !dataDir || !cacheDir) return GuestErrStore;
	// The data of the store are being deleted: a view made now would use what is going away, and the folder that Go is
	// about to delete would be live. The caller tries again.
	Store *busy = gStores ? g_hash_table_lookup(gStores, store) : NULL;
	if (busy && busy->clearing) { if (err && errn > 0) snprintf(err, errn, "the session data are being deleted"); return GuestErrStoreBusy; }
	int rc = graft(GTK_WINDOW(gtkWindow), why, sizeof why);
	if (rc != 0) { if (err && errn > 0) snprintf(err, errn, "%s", why); return rc; }
	if (!gOverlay) { if (err && errn > 0) snprintf(err, errn, "the overlay of the window is gone"); return GuestErrUnavailable; }

	Store *s = storeOf(store, dataDir, cacheDir);
	if (!s) { if (err && errn > 0) snprintf(err, errn, "the sandbox of WebKit could not be turned on"); return GuestErrUnavailable; }
	WebKitSettings *settings = webkit_settings_new();
	setting(settings);
	// No WebKitUserContentManager is given: the view makes an empty one of its own, with no handler and no script.
	GtkWidget *view = g_object_new(WEBKIT_TYPE_WEB_VIEW, "web-context", s->ctx, "settings", settings, NULL);
	g_object_unref(settings);

	Guest *g = g_new0(Guest, 1);
	g->gid = g_strdup(id);
	g->view = view;
	g->store = s;
	g->nx = x; g->ny = y; g->nw = w; g->nh = h;
	g->lastURL = g_strdup(url);
	s->guests++;
	g_object_set_data(G_OBJECT(view), kGuestKey, g);

	g_signal_connect(view, "decide-policy", G_CALLBACK(onDecidePolicy), g);
	g_signal_connect(view, "create", G_CALLBACK(onCreate), g);
	g_signal_connect(view, "authenticate", G_CALLBACK(onAuthenticate), g);
	g_signal_connect(view, "load-failed", G_CALLBACK(onLoadFailed), g);
	g_signal_connect(view, "load-failed-with-tls-errors", G_CALLBACK(onTLSErrors), g);
	g_signal_connect(view, "load-changed", G_CALLBACK(onLoadChanged), g);
	g_signal_connect(view, "web-process-terminated", G_CALLBACK(onProcessTerminated), g);
	g_signal_connect(view, "permission-request", G_CALLBACK(onPermission), g);
	g_signal_connect(view, "run-file-chooser", G_CALLBACK(onFileChooser), g);
	g_signal_connect(view, "script-dialog", G_CALLBACK(onScriptDialog), g);
	g_signal_connect(view, "context-menu", G_CALLBACK(onContextMenu), g);
	g_signal_connect(view, "print", G_CALLBACK(onPrint), g);
	g_signal_connect(view, "show-notification", G_CALLBACK(onShowNotification), g);
	g_signal_connect(view, "close", G_CALLBACK(onClose), g);
	g_signal_connect(view, "notify::uri", G_CALLBACK(onNotifyURI), g);
	g_signal_connect(view, "notify::title", G_CALLBACK(onNotify), g);
	g_signal_connect(view, "notify::is-loading", G_CALLBACK(onNotify), g);
	g_signal_connect(webkit_web_view_get_back_forward_list(WEBKIT_WEB_VIEW(view)), "changed", G_CALLBACK(onHistoryChanged), g);
	g_signal_connect(view, "key-press-event", G_CALLBACK(onKeyPress), g);
	g_signal_connect(view, "button-press-event", G_CALLBACK(onButtonPress), g);
	g_signal_connect(view, "scroll-event", G_CALLBACK(onScroll), g);
	g_signal_connect(view, "focus-in-event", G_CALLBACK(onFocusIn), g);

	g_hash_table_insert(gGuests, g->gid, g);
	// Above the web view of the application: an overlay child is drawn and hit above the main child.
	gtk_overlay_add_overlay(GTK_OVERLAY(gOverlay), view);
	gtk_overlay_set_overlay_pass_through(GTK_OVERLAY(gOverlay), view, FALSE);
	gtk_widget_show(view);
	relayout();
	webkit_web_view_load_uri(WEBKIT_WEB_VIEW(view), url);
	return 0;
}

// ---- the calls on a guest -----------------------------------------------------------------------

int guestSetBounds(const char *id, double x, double y, double w, double h) {
	MAIN_ONLY(GuestErrThread);
	Guest *g = lookup(id);
	if (!g) return GuestErrUnknown;
	g->nx = x; g->ny = y; g->nw = w; g->nh = h;
	relayout();
	return 0;
}

// releaseFocus gives the focus back to the web view of the application when a guest that is going away (hidden,
// closed) has it: a view that is not there must not keep the keys.
static void releaseFocus(Guest *g) {
	if (!gWindow || !gAppView) return;
	GtkWidget *f = gtk_window_get_focus(gWindow);
	if (f && (f == g->view || gtk_widget_is_ancestor(f, g->view))) gtk_widget_grab_focus(gAppView);
}

int guestSetVisible(const char *id, int visible) {
	MAIN_ONLY(GuestErrThread);
	Guest *g = lookup(id);
	if (!g) return GuestErrUnknown;
	if (!visible) releaseFocus(g);
	if (visible) gtk_widget_show(g->view);
	else gtk_widget_hide(g->view);
	relayout();
	return 0;
}

int guestNavigate(const char *id, const char *url) {
	MAIN_ONLY(GuestErrThread);
	Guest *g = lookup(id);
	if (!g) return GuestErrUnknown;
	if (!isHTTP(url)) return GuestErrURL;
	g_free(g->lastURL);
	g->lastURL = g_strdup(url);
	webkit_web_view_load_uri(WEBKIT_WEB_VIEW(g->view), url);
	return 0;
}

int guestBack(const char *id) { MAIN_ONLY(GuestErrThread); Guest *g = lookup(id); if (!g) return GuestErrUnknown; webkit_web_view_go_back(WEBKIT_WEB_VIEW(g->view)); return 0; }
int guestForward(const char *id) { MAIN_ONLY(GuestErrThread); Guest *g = lookup(id); if (!g) return GuestErrUnknown; webkit_web_view_go_forward(WEBKIT_WEB_VIEW(g->view)); return 0; }

int guestReload(const char *id) {
	MAIN_ONLY(GuestErrThread);
	Guest *g = lookup(id);
	if (!g) return GuestErrUnknown;
	WebKitWebView *v = WEBKIT_WEB_VIEW(g->view);
	const char *uri = webkit_web_view_get_uri(v);
	if (!g->failed && uri && *uri) {
		webkit_web_view_reload(v);
	} else if (g->lastURL) {
		// Nothing was ever shown (the first load failed, a certificate error among them): reload asks WebKit to
		// reload a page it does not have, so the address is loaded again.
		webkit_web_view_load_uri(v, g->lastURL);
	}
	return 0;
}

int guestFocus(const char *id) {
	MAIN_ONLY(GuestErrThread);
	Guest *g = lookup(id);
	if (!g) return GuestErrUnknown;
	gtk_widget_grab_focus(g->view);
	return 0;
}

static void destroyGuest(Guest *g) {
	// No handler may run after this: they hold g.
	g_signal_handlers_disconnect_by_data(g->view, g);
	g_signal_handlers_disconnect_by_data(webkit_web_view_get_back_forward_list(WEBKIT_WEB_VIEW(g->view)), g);
	releaseFocus(g);
	g_object_set_data(G_OBJECT(g->view), kGuestKey, NULL);
	g->store->guests--;
	gtk_widget_destroy(g->view); // out of the overlay, and the page ends with it
	g_free(g->gid);
	g_free(g->lastURL);
	g_free(g->lastNewWindowURL);
	g_free(g->tlsFailedURI);
	g_free(g);
	relayout();
}

int guestClose(const char *id) {
	MAIN_ONLY(GuestErrThread);
	Guest *g = lookup(id);
	if (!g) return GuestErrUnknown;
	g_hash_table_remove(gGuests, g->gid);
	destroyGuest(g);
	return 0;
}

void guestCloseAll(void) {
	if (!g_main_context_is_owner(NULL)) { g_warning("clarae nativeview: called off the main thread"); return; }
	if (!gGuests) return;
	GList *all = g_hash_table_get_values(gGuests);
	for (GList *l = all; l; l = l->next) {
		Guest *g = l->data;
		g_hash_table_remove(gGuests, g->gid);
		destroyGuest(g);
	}
	g_list_free(all);
}

// ---- the data of a store ------------------------------------------------------------------------

typedef struct { Store *store; long req; } Clearing;

static void onCleared(GObject *src, GAsyncResult *res, gpointer data) {
	Clearing *c = data;
	GError *err = NULL;
	webkit_website_data_manager_clear_finish(WEBKIT_WEBSITE_DATA_MANAGER(src), res, &err);
	Store *s = c->store;
	s->clearing = FALSE;
	// guestCreate refuses a store that is being cleared, so no view was made meanwhile; if one was, the data are not
	// the caller's to delete and the answer says so.
	if (s->guests == 0) {
		g_hash_table_remove(gStores, s->name);
		g_object_unref(s->ctx);
		g_free(s->name);
		g_free(s);
		goGuestReply(c->req, 1, err ? err->message : "");
	} else {
		goGuestReply(c->req, 0, "the session data are in use");
	}
	if (err) g_error_free(err);
	g_free(c);
}

int guestReleaseStore(const char *store, long req) {
	MAIN_ONLY(GuestErrThread);
	Store *s = (store && gStores) ? g_hash_table_lookup(gStores, store) : NULL;
	if (!s) { goGuestReply(req, 1, ""); return 0; }
	if (s->guests > 0) { goGuestReply(req, 0, "the session data are in use"); return 0; }
	if (s->clearing) { goGuestReply(req, 0, "the session data are being deleted"); return 0; }
	s->clearing = TRUE;
	Clearing *c = g_new0(Clearing, 1);
	c->store = s;
	c->req = req;
	webkit_website_data_manager_clear(s->dm, WEBKIT_WEBSITE_DATA_ALL, 0, NULL, onCleared, c);
	return 0;
}

// ---- test only --------------------------------------------------------------------------------

#ifdef CLARAE_NATIVEVIEW_TEST

int guestSandboxEnabled(const char *id) {
	Guest *g = lookup(id);
	return g ? (webkit_web_context_get_sandbox_enabled(g->store->ctx) ? 1 : 0) : -1;
}
void guestSetClearing(const char *store, int on) {
	Store *s = (store && gStores) ? g_hash_table_lookup(gStores, store) : NULL;
	if (s) s->clearing = on ? TRUE : FALSE;
}

int guestCount(void) { return gGuests ? (int)g_hash_table_size(gGuests) : 0; }
int guestInspectable(const char *id) {
	Guest *g = lookup(id);
	if (!g) return -1;
	return webkit_settings_get_enable_developer_extras(webkit_web_view_get_settings(WEBKIT_WEB_VIEW(g->view))) ? 1 : 0;
}
const char *guestUserAgent(const char *id) {
	Guest *g = lookup(id);
	return g ? webkit_settings_get_user_agent(webkit_web_view_get_settings(WEBKIT_WEB_VIEW(g->view))) : "";
}

static void evalDone(GObject *src, GAsyncResult *res, gpointer data) {
	long req = (long)(intptr_t)data;
	GError *err = NULL;
	JSCValue *v = webkit_web_view_call_async_javascript_function_finish(WEBKIT_WEB_VIEW(src), res, &err);
	if (err) { goGuestReply(req, 0, err->message); g_error_free(err); return; }
	char *s = NULL;
	if (!v || jsc_value_is_undefined(v) || jsc_value_is_null(v)) s = g_strdup("null");
	else if (jsc_value_is_string(v)) s = jsc_value_to_string(v);
	else if (jsc_value_is_object(v) || jsc_value_is_array(v)) s = jsc_value_to_json(v, 0);
	else s = jsc_value_to_string(v);
	goGuestReply(req, 1, s ? s : "");
	g_free(s);
	if (v) g_object_unref(v);
}

int guestEval(const char *gidC, const char *js, long req) {
	MAIN_ONLY(GuestErrThread);
	Guest *g = lookup(gidC);
	if (!g) return GuestErrUnknown;
	webkit_web_view_call_async_javascript_function(WEBKIT_WEB_VIEW(g->view), js, -1, NULL, NULL, NULL, NULL, evalDone, (gpointer)(intptr_t)req);
	return 0;
}

int guestFrame(const char *id, double *x, double *y, double *w, double *h, double *cw, double *ch, int *visible, int *hasFocus) {
	MAIN_ONLY(GuestErrThread);
	Guest *g = lookup(id);
	if (!g || !gOverlay) return GuestErrUnknown;
	GtkAllocation a, oa;
	gtk_widget_get_allocation(g->view, &a);
	gtk_widget_get_allocation(gOverlay, &oa);
	gint gx = 0, gy = 0;
	gtk_widget_translate_coordinates(g->view, gOverlay, 0, 0, &gx, &gy); // the allocation is relative to the window of the widget
	*x = gx; *y = gy; *w = a.width; *h = a.height;
	*cw = oa.width; *ch = oa.height;
	*visible = gtk_widget_get_visible(g->view);
	GtkWidget *f = gWindow ? gtk_window_get_focus(gWindow) : NULL;
	*hasFocus = f && (f == g->view || gtk_widget_is_ancestor(f, g->view));
	return 0;
}

int guestHitTest(const char *id, double x, double y) {
	MAIN_ONLY(GuestErrThread);
	Guest *g = lookup(id);
	if (!g || !gOverlay) return GuestErrUnknown;
	GtkAllocation a;
	gtk_widget_get_allocation(g->view, &a);
	gint gxi = 0, gyi = 0;
	gtk_widget_translate_coordinates(g->view, gOverlay, 0, 0, &gxi, &gyi);
	double gx = gxi, gy = gyi;
	if (gtk_widget_get_visible(g->view) && x >= gx && x < gx + a.width && y >= gy && y < gy + a.height) return 1;
	return gAppView ? 2 : 0;
}

void guestPostKey(const char *id, unsigned int keyval, unsigned int state) {
	Guest *g = lookup(id);
	if (!g) return;
	GdkWindow *win = gtk_widget_get_window(g->view);
	if (!win) return;
	GdkDisplay *display = gdk_display_get_default();
	GdkKeymap *km = gdk_keymap_get_for_display(display);
	GdkKeymapKey *keys = NULL;
	gint nkeys = 0;
	guint16 hw = 0;
	if (gdk_keymap_get_entries_for_keyval(km, keyval, &keys, &nkeys) && nkeys > 0) hw = keys[0].keycode;
	g_free(keys);
	for (int i = 0; i < 2; i++) {
		GdkEvent *e = gdk_event_new(i == 0 ? GDK_KEY_PRESS : GDK_KEY_RELEASE);
		e->key.window = g_object_ref(win);
		e->key.send_event = TRUE;
		e->key.time = GDK_CURRENT_TIME;
		e->key.state = state;
		e->key.keyval = keyval;
		e->key.hardware_keycode = hw;
		e->key.group = 0;
		gdk_event_set_device(e, gdk_seat_get_keyboard(gdk_display_get_default_seat(display)));
		gtk_widget_event(g->view, e);
		gdk_event_free(e);
	}
}

// guestPostPointer sends a motion (press 0) or a button press (1) or release (2) at a point of the area, through
// the X server (XTest): it goes to the window that is under the point, which is what decides whether the guest
// or the web view of the application gets it.
void guestPostPointer(double x, double y, int what) {
	if (!gWindow || !gOverlay) return;
	GtkWidget *top = GTK_WIDGET(gWindow);
	GdkWindow *topWin = gtk_widget_get_window(top);
	gint tx = 0, ty = 0;
	if (!topWin || !gtk_widget_translate_coordinates(gOverlay, top, (gint)x, (gint)y, &tx, &ty)) return;
	gdk_test_simulate_button(topWin, tx, ty, 1, 0, what == 1 ? GDK_BUTTON_PRESS : GDK_BUTTON_RELEASE);
	gdk_display_sync(gdk_display_get_default());
}

// guestWindowAt says which widget owns the window that the X server has under a point of the area (the pointer is
// moved there): 1 a guest or a part of it, 2 the web view of the application or the overlay around it, 0 other.
int guestWindowAt(double x, double y, char *name, int n) {
	if (!gWindow || !gOverlay) return GuestErrUnknown;
	GtkWidget *top = GTK_WIDGET(gWindow);
	GdkWindow *topWin = gtk_widget_get_window(top);
	gint tx = 0, ty = 0;
	if (!topWin || !gtk_widget_translate_coordinates(gOverlay, top, (gint)x, (gint)y, &tx, &ty)) return GuestErrUnknown;
	gdk_test_simulate_button(topWin, tx, ty, 1, 0, GDK_BUTTON_RELEASE); // moves the pointer there (and releases nothing)
	GdkDisplay *display = gdk_display_get_default();
	gdk_display_sync(display);
	GdkDevice *ptr = gdk_seat_get_pointer(gdk_display_get_default_seat(display));
	GdkWindow *at = gdk_device_get_window_at_position(ptr, NULL, NULL);
	gpointer data = NULL;
	if (at) gdk_window_get_user_data(at, &data);
	GtkWidget *w = data && GTK_IS_WIDGET(data) ? GTK_WIDGET(data) : NULL;
	if (name && n > 0) snprintf(name, n, "%s", w ? G_OBJECT_TYPE_NAME(w) : "none");
	for (GtkWidget *p = w; p; p = gtk_widget_get_parent(p)) {
		if (guestOfWidget(p)) return 1;
		if (p == gAppView || p == gOverlay) return 2;
	}
	return 0;
}

int guestCreateElsewhere(char *err, int n) {
	GtkWidget *w = gtk_window_new(GTK_WINDOW_TOPLEVEL);
	int rc = guestCreate(w, "elsewhere", "https://example.com/", 0, 0, 1, 1, "00000000-0000-4000-8000-000000000000", "/tmp", "/tmp", err, n);
	gtk_widget_destroy(w);
	return rc;
}

// guestPixel reads the colour that is drawn at a point of the area of the web view of the application, from the
// window as the X server has it.
int guestPixel(double x, double y, int *r, int *g, int *b) {
	if (!gWindow || !gOverlay) return GuestErrUnknown;
	GtkWidget *top = GTK_WIDGET(gWindow);
	GdkWindow *topWin = gtk_widget_get_window(top);
	gint tx = 0, ty = 0;
	if (!topWin || !gtk_widget_translate_coordinates(gOverlay, top, (gint)x, (gint)y, &tx, &ty)) return GuestErrUnknown;
	GdkPixbuf *pb = gdk_pixbuf_get_from_window(topWin, tx, ty, 1, 1);
	if (!pb) return GuestErrUnknown;
	const guchar *px = gdk_pixbuf_get_pixels(pb);
	*r = px[0]; *g = px[1]; *b = px[2];
	g_object_unref(pb);
	return 0;
}

static void traceEvent(GdkEvent *e, gpointer data) {
	if (e->type == GDK_BUTTON_PRESS || e->type == GDK_BUTTON_RELEASE || e->type == GDK_ENTER_NOTIFY)
		fprintf(stderr, "TRACE event type=%d window=%p widget=%s\n", (int)e->type, (void *)e->any.window, gtk_get_event_widget(e) ? G_OBJECT_TYPE_NAME(gtk_get_event_widget(e)) : "none");
	gtk_main_do_event(e);
}
void guestTraceEvents(void) { gdk_event_handler_set(traceEvent, NULL, NULL); }

int guestClicks(const char *id) {
	Guest *g = lookup(id);
	return g ? g->clicks : -1;
}
int guestAppClicks(void) { return gAppClicks; }

void guestFocusMain(void *gtkWindow) {
	if (gAppView) gtk_widget_grab_focus(gAppView);
}
int guestAppFocused(void *gtkWindow) { return gAppView && gtk_widget_is_focus(gAppView) ? 1 : 0; }

int guestGraftInfo(void *gtkWindow, char *path, int n, int *position, int *children) {
	if (!gAppView) return GuestErrUnknown;
	GString *s = g_string_new("");
	GList *chain = NULL;
	for (GtkWidget *w = gAppView; w; w = gtk_widget_get_parent(w)) chain = g_list_prepend(chain, w);
	for (GList *l = chain; l; l = l->next) {
		if (s->len) g_string_append_c(s, '>');
		g_string_append(s, G_OBJECT_TYPE_NAME(l->data));
	}
	g_list_free(chain);
	snprintf(path, n, "%s", s->str);
	g_string_free(s, TRUE);
	*position = -1;
	*children = 0;
	GtkWidget *ov = gtk_widget_get_parent(gAppView);
	GtkWidget *box = ov ? gtk_widget_get_parent(ov) : NULL;
	if (box && GTK_IS_BOX(box)) {
		GList *kids = gtk_container_get_children(GTK_CONTAINER(box));
		int i = 0;
		for (GList *l = kids; l; l = l->next, i++) {
			if (l->data == ov) *position = i;
			(*children)++;
		}
		g_list_free(kids);
	}
	return 0;
}

#endif
