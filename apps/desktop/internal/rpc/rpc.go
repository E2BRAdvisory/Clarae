// Package rpc calls the methods of the bound API structs by name, with JSON arguments and results.
// Wails does exactly that between the web view and Go; this package does it for the Go core
// compiled to WebAssembly, whose callers (a page and its worker) have no Wails runtime (ADR-0030).
//
// The semantics follow Wails: every exported method of a registered struct is callable as
// Service.Method; the arguments are a JSON array, one element per parameter; a method returns
// nothing, a value, an error, or a value and an error; a non-nil error rejects the call with its
// message; []byte travels as base64 and time.Time as RFC 3339 (encoding/json).
package rpc

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"sync"
)

var errorType = reflect.TypeOf((*error)(nil)).Elem()

// Dispatcher routes calls to registered services.
type Dispatcher struct {
	mu       sync.RWMutex
	services map[string]*service
}

type service struct {
	recv    reflect.Value
	methods map[string]reflect.Value
}

// New returns an empty dispatcher.
func New() *Dispatcher { return &Dispatcher{services: map[string]*service{}} }

// Register exposes every exported method of svc (a pointer to a struct) under the struct's type
// name, as Wails does. A method that Wails could not bind is refused here too: variadic, or more
// than one non-error result.
func (d *Dispatcher) Register(svc any) error {
	v := reflect.ValueOf(svc)
	if v.Kind() != reflect.Pointer || v.IsNil() || v.Elem().Kind() != reflect.Struct {
		return fmt.Errorf("rpc: %T is not a pointer to a struct", svc)
	}
	name := v.Elem().Type().Name()
	s := &service{recv: v, methods: map[string]reflect.Value{}}
	for i := 0; i < v.NumMethod(); i++ {
		method := v.Type().Method(i).Name
		fn := v.Method(i)
		t := fn.Type()
		if t.IsVariadic() {
			return fmt.Errorf("rpc: %s.%s is variadic", name, method)
		}
		results := t.NumOut()
		if results > 0 && t.Out(results-1) == errorType {
			results--
		}
		if results > 1 {
			return fmt.Errorf("rpc: %s.%s returns more than one value besides the error", name, method)
		}
		s.methods[method] = fn
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, dup := d.services[name]; dup {
		return fmt.Errorf("rpc: service %s is already registered", name)
	}
	d.services[name] = s
	return nil
}

// Methods lists the callable methods per service, sorted.
func (d *Dispatcher) Methods() map[string][]string {
	d.mu.RLock()
	defer d.mu.RUnlock()
	out := make(map[string][]string, len(d.services))
	for name, s := range d.services {
		for m := range s.methods {
			out[name] = append(out[name], m)
		}
		sort.Strings(out[name])
	}
	return out
}

// Call runs service.method with argsJSON (a JSON array, "" meaning none) and returns the result
// as JSON ("null" when the method returns nothing). A panic in the method is an error, not a crash.
func (d *Dispatcher) Call(serviceName, method, argsJSON string) (result string, err error) {
	d.mu.RLock()
	s := d.services[serviceName]
	d.mu.RUnlock()
	if s == nil {
		return "", fmt.Errorf("rpc: unknown service %q", serviceName)
	}
	fn, ok := s.methods[method]
	if !ok {
		return "", fmt.Errorf("rpc: unknown method %s.%s", serviceName, method)
	}
	t := fn.Type()

	var raw []json.RawMessage
	if argsJSON != "" {
		if err := json.Unmarshal([]byte(argsJSON), &raw); err != nil {
			return "", fmt.Errorf("rpc: %s.%s: arguments must be a JSON array: %w", serviceName, method, err)
		}
	}
	if len(raw) != t.NumIn() {
		return "", fmt.Errorf("rpc: %s.%s takes %d arguments, got %d", serviceName, method, t.NumIn(), len(raw))
	}
	args := make([]reflect.Value, t.NumIn())
	for i := range args {
		p := reflect.New(t.In(i))
		if err := json.Unmarshal(raw[i], p.Interface()); err != nil {
			return "", fmt.Errorf("rpc: %s.%s argument %d: %w", serviceName, method, i+1, err)
		}
		args[i] = p.Elem()
	}

	defer func() {
		if r := recover(); r != nil {
			result, err = "", fmt.Errorf("rpc: %s.%s panicked: %v", serviceName, method, r)
		}
	}()
	out := fn.Call(args)

	if n := len(out); n > 0 && t.Out(n-1) == errorType {
		if e, _ := out[n-1].Interface().(error); e != nil {
			return "", e
		}
		out = out[:n-1]
	}
	if len(out) == 0 {
		return "null", nil
	}
	data, err := json.Marshal(out[0].Interface())
	if err != nil {
		return "", errors.Join(fmt.Errorf("rpc: %s.%s: result is not JSON", serviceName, method), err)
	}
	return string(data), nil
}
