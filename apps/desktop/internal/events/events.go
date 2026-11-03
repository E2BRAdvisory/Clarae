// Package events types the events the Go core sends to the TypeScript UI (Go → TS, §2.5, ADR-0045 §5).
//
// An event is declared once, next to the code that emits it, with the type of its payload:
//
//	var EventStatus = events.New[Status]("sync:status", "The sync state of a vault changed.")
//
// and sent through that declaration, so a name cannot be misspelt and a payload cannot drift from
// its declared type:
//
//	EventStatus.Send(m.emit, st)
//
// Every declaration is listed in the registry of apps/desktop/internal/app/events.go, from which
// `task gen` writes the TypeScript names and payload types (packages/workbench/src/app/events.gen.ts).
// A test of package app fails when an event is declared or sent outside that path.
package events

import "reflect"

// Emitter delivers an event to the UI: App.emit on the desktop and in the browser, a recorder in
// tests. A nil Emitter drops the event.
type Emitter func(name string, payload any)

// Event is a Go → TypeScript event whose payload is a P (marshalled to JSON by the host).
type Event[P any] struct {
	name string
	doc  string
}

// New declares an event. The name is what the UI subscribes to (`area:what-happened`); the doc
// becomes the comment of the generated TypeScript name.
func New[P any](name, doc string) Event[P] { return Event[P]{name: name, doc: doc} }

// Name is the wire name of the event.
func (e Event[P]) Name() string { return e.name }

// Send emits the event with its payload.
func (e Event[P]) Send(to Emitter, payload P) {
	if to != nil {
		to(e.name, payload)
	}
}

// Spec describes the event for the registry and the generator.
func (e Event[P]) Spec() Spec {
	return Spec{Name: e.name, Doc: e.doc, Payload: reflect.TypeFor[P]()}
}

// Signal is an event without payload: the UI handler receives `undefined`.
type Signal struct {
	name string
	doc  string
}

// NewSignal declares an event without payload.
func NewSignal(name, doc string) Signal { return Signal{name: name, doc: doc} }

// Name is the wire name of the event.
func (s Signal) Name() string { return s.name }

// Send emits the event.
func (s Signal) Send(to Emitter) {
	if to != nil {
		to(s.name, nil)
	}
}

// Spec describes the event for the registry and the generator (no payload type).
func (s Signal) Spec() Spec { return Spec{Name: s.name, Doc: s.doc} }

// Spec is one entry of the registry: the wire name, its documentation and the payload type (nil for
// a Signal).
type Spec struct {
	Name    string
	Doc     string
	Payload reflect.Type
}

// EnumSpec lists the values of a string type that the TypeScript side sees as a union of literals
// (sync.Phase → 'idle' | 'syncing' | …). A string type without one is a plain `string`.
type EnumSpec struct {
	Type   reflect.Type
	Values []string
}

// Enum declares the values of a string type, in the order they are listed.
func Enum[T ~string](values ...T) EnumSpec {
	out := make([]string, len(values))
	for i, v := range values {
		out[i] = string(v)
	}
	return EnumSpec{Type: reflect.TypeFor[T](), Values: out}
}
