//go:build darwin

package watcher

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/fsnotify/fsnotify"
)

// On macOS fsnotify uses kqueue, which needs an open file descriptor for every
// file of every watched folder: a vault of tens of thousands of files reaches
// kern.maxfilesperproc and then every open of the process fails (index.db,
// sync.db, atomic writes, sockets). FSEvents watches the whole tree with one
// stream and no descriptor per file. It is reached through purego (dlopen of
// CoreServices), so the build needs no cgo; when it cannot be set up the
// watcher falls back to fsnotify.

func newSource() (source, error) {
	if s, err := newFSEventsSource(); err == nil {
		return s, nil
	}
	return newFsnotifySource()
}

// FSEvents constants (CoreServices/FSEvents.h).
const (
	fseSinceNow             = ^uint64(0) // kFSEventStreamEventIdSinceNow
	fseFlagNoDefer          = 0x02       // kFSEventStreamCreateFlagNoDefer
	fseFlagWatchRoot        = 0x04       // kFSEventStreamCreateFlagWatchRoot
	fseFlagFileEvents       = 0x10       // kFSEventStreamCreateFlagFileEvents
	fseMustScanSubDirs      = 0x00000001
	fseUserDropped          = 0x00000002
	fseKernelDropped        = 0x00000004
	fseRootChanged          = 0x00000020
	fseItemCreated          = 0x00000100
	fseItemRemoved          = 0x00000200
	fseItemRenamed          = 0x00000800
	fseLatencySeconds       = 0.05
	cfStringEncodingUTF8    = 0x08000100
	fseEventBufferSize      = 4096
	coreServicesFramework   = "/System/Library/Frameworks/CoreServices.framework/CoreServices"
	coreFoundationFramework = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
	libSystem               = "/usr/lib/libSystem.B.dylib"
)

// fsEventStreamContext is FSEventStreamContext; info carries the id of the
// source, the other members stay zero (version 0, no retain/release/
// copyDescription callbacks). The layout is what FSEventStreamCreate reads.
type fsEventStreamContext struct {
	_    int // version
	info uintptr
	_    [3]uintptr // retain, release, copyDescription
}

var fse struct {
	once sync.Once
	err  error

	cfStringCreateWithCString func(alloc uintptr, cstr *byte, encoding uint32) uintptr
	cfArrayCreate             func(alloc uintptr, values *uintptr, n int, callbacks uintptr) uintptr
	cfRelease                 func(ref uintptr)
	arrayCallbacks            uintptr // &kCFTypeArrayCallBacks

	streamCreate     func(alloc, cb uintptr, ctx *fsEventStreamContext, paths uintptr, since uint64, latency float64, flags uint32) uintptr
	streamSetQueue   func(stream, queue uintptr)
	streamStart      func(stream uintptr) bool
	streamStop       func(stream uintptr)
	streamInvalidate func(stream uintptr)
	streamRelease    func(stream uintptr)
	queueCreate      func(label *byte, attr uintptr) uintptr
	queueRelease     func(obj uintptr)

	callback uintptr // the one C callback, shared by every stream (purego callbacks are never freed)

	mu      sync.Mutex
	nextID  uintptr
	sources map[uintptr]*fseventsSource
}

func loadFSEvents() error {
	fse.once.Do(func() {
		defer func() {
			if r := recover(); r != nil { // purego panics on a missing symbol
				fse.err = fmt.Errorf("fsevents: %v", r)
			}
		}()
		cf, err := purego.Dlopen(coreFoundationFramework, purego.RTLD_LAZY|purego.RTLD_GLOBAL)
		if err != nil {
			fse.err = err
			return
		}
		cs, err := purego.Dlopen(coreServicesFramework, purego.RTLD_LAZY|purego.RTLD_GLOBAL)
		if err != nil {
			fse.err = err
			return
		}
		sys, err := purego.Dlopen(libSystem, purego.RTLD_LAZY|purego.RTLD_GLOBAL)
		if err != nil {
			fse.err = err
			return
		}
		if fse.arrayCallbacks, err = purego.Dlsym(cf, "kCFTypeArrayCallBacks"); err != nil {
			fse.err = err
			return
		}
		purego.RegisterLibFunc(&fse.cfStringCreateWithCString, cf, "CFStringCreateWithCString")
		purego.RegisterLibFunc(&fse.cfArrayCreate, cf, "CFArrayCreate")
		purego.RegisterLibFunc(&fse.cfRelease, cf, "CFRelease")
		purego.RegisterLibFunc(&fse.streamCreate, cs, "FSEventStreamCreate")
		purego.RegisterLibFunc(&fse.streamSetQueue, cs, "FSEventStreamSetDispatchQueue")
		purego.RegisterLibFunc(&fse.streamStart, cs, "FSEventStreamStart")
		purego.RegisterLibFunc(&fse.streamStop, cs, "FSEventStreamStop")
		purego.RegisterLibFunc(&fse.streamInvalidate, cs, "FSEventStreamInvalidate")
		purego.RegisterLibFunc(&fse.streamRelease, cs, "FSEventStreamRelease")
		purego.RegisterLibFunc(&fse.queueCreate, sys, "dispatch_queue_create")
		purego.RegisterLibFunc(&fse.queueRelease, sys, "dispatch_release")
		fse.callback = purego.NewCallback(fseventsCallback)
		fse.sources = map[uintptr]*fseventsSource{}
	})
	return fse.err
}

// fseventsSource is a recursive source: Add starts one stream for the root.
type fseventsSource struct {
	id      uintptr
	events  chan fsnotify.Event
	errs    chan error
	closing chan struct{}

	mu     sync.Mutex
	stream uintptr
	queue  uintptr
	closed bool
}

func newFSEventsSource() (*fseventsSource, error) {
	if err := loadFSEvents(); err != nil {
		return nil, err
	}
	s := &fseventsSource{events: make(chan fsnotify.Event, fseEventBufferSize), errs: make(chan error, 1), closing: make(chan struct{})}
	fse.mu.Lock()
	fse.nextID++
	s.id = fse.nextID
	fse.sources[s.id] = s
	fse.mu.Unlock()
	return s, nil
}

func (s *fseventsSource) Recursive() bool               { return true }
func (s *fseventsSource) Events() <-chan fsnotify.Event { return s.events }
func (s *fseventsSource) Errors() <-chan error          { return s.errs }

// Add starts the stream on root; the stream covers the whole tree, so only
// the first call does anything.
func (s *fseventsSource) Add(root string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("fsevents: watcher closed")
	}
	if s.stream != 0 {
		return nil
	}
	if _, err := os.Stat(root); err != nil {
		return err
	}
	cpath := append([]byte(root), 0)
	str := fse.cfStringCreateWithCString(0, &cpath[0], cfStringEncodingUTF8)
	if str == 0 {
		return fmt.Errorf("fsevents: cannot encode %q", root)
	}
	defer fse.cfRelease(str)
	values := []uintptr{str}
	paths := fse.cfArrayCreate(0, &values[0], 1, fse.arrayCallbacks)
	if paths == 0 {
		return errors.New("fsevents: CFArrayCreate failed")
	}
	defer fse.cfRelease(paths)
	ctx := fsEventStreamContext{info: s.id}
	stream := fse.streamCreate(0, fse.callback, &ctx, paths, fseSinceNow, fseLatencySeconds, fseFlagNoDefer|fseFlagWatchRoot|fseFlagFileEvents)
	if stream == 0 {
		return errors.New("fsevents: FSEventStreamCreate failed")
	}
	label := []byte("clarae.watcher\x00")
	queue := fse.queueCreate(&label[0], 0) // serial queue
	fse.streamSetQueue(stream, queue)
	if !fse.streamStart(stream) {
		fse.streamInvalidate(stream)
		fse.streamRelease(stream)
		fse.queueRelease(queue)
		return errors.New("fsevents: FSEventStreamStart failed")
	}
	s.stream, s.queue = stream, queue
	return nil
}

// Close stops the stream. The callback never blocks once closing is closed,
// so stopping cannot wait on a callback stuck on a full channel.
func (s *fseventsSource) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	close(s.closing)
	if s.stream != 0 {
		fse.streamStop(s.stream)
		fse.streamInvalidate(s.stream)
		fse.streamRelease(s.stream)
		fse.queueRelease(s.queue)
		s.stream, s.queue = 0, 0
	}
	fse.mu.Lock()
	delete(fse.sources, s.id)
	fse.mu.Unlock()
	return nil
}

// fseventsCallback is the FSEventStreamCallback, run on the stream's
// dispatch queue: eventPaths is a char** (no kFSEventStreamCreateFlagUseCFTypes).
func fseventsCallback(_, info, numEvents, eventPaths, eventFlags, _ uintptr) {
	fse.mu.Lock()
	s := fse.sources[info]
	fse.mu.Unlock()
	if s == nil {
		return
	}
	for i := uintptr(0); i < numEvents; i++ {
		cpath := *(*uintptr)(unsafe.Add(cptr(eventPaths), i*unsafe.Sizeof(uintptr(0))))
		flags := *(*uint32)(unsafe.Add(cptr(eventFlags), i*4))
		ev := fsnotify.Event{Name: filepath.Clean(goString(cpath))}
		switch {
		case flags&(fseMustScanSubDirs|fseUserDropped|fseKernelDropped|fseRootChanged) != 0:
			ev.Op = 0 // rescan: events were coalesced or lost
		case flags&(fseItemCreated|fseItemRenamed) != 0:
			ev.Op = fsnotify.Create
		case flags&fseItemRemoved != 0:
			ev.Op = fsnotify.Remove
		default:
			ev.Op = fsnotify.Write
		}
		select {
		case s.events <- ev:
		case <-s.closing:
			return
		}
	}
}

// cptr turns an address received from C into a pointer without the
// uintptr-to-pointer conversion go vet warns about (the memory is C's).
func cptr(u uintptr) unsafe.Pointer {
	return *(*unsafe.Pointer)(unsafe.Pointer(&u)) //nolint:gosec // C memory, not managed by the Go GC
}

// goString copies a NUL-terminated C string.
func goString(p uintptr) string {
	if p == 0 {
		return ""
	}
	n := 0
	for *(*byte)(unsafe.Add(cptr(p), n)) != 0 {
		n++
	}
	return string(unsafe.Slice((*byte)(cptr(p)), n)) //nolint:gosec // copied by the conversion
}
