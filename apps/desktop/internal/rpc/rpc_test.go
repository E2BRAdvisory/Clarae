package rpc

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

type Calc struct{ calls int }

type Pair struct {
	A int    `json:"a"`
	B string `json:"b"`
}

func (c *Calc) Add(a, b int) int           { c.calls++; return a + b }
func (c *Calc) Nothing()                   { c.calls++ }
func (c *Calc) Fail(msg string) error      { return errors.New(msg) }
func (c *Calc) Div(a, b int) (int, error)  { return a / b, nil } // panics on b == 0
func (c *Calc) Echo(p Pair) Pair           { return p }
func (c *Calc) Bytes(b []byte) []byte      { return append(b, '!') }
func (c *Calc) Tags() []string             { return nil }
func (c *Calc) When(t time.Time) time.Time { return t.Add(time.Hour) }
func (c *Calc) Maybe(ok bool) (string, error) {
	return "v", map[bool]error{true: nil, false: errors.New("no")}[ok]
}
func (c *Calc) Lists(m map[string][]int) []string { return []string{"x"} }
func (c *Calc) unexported()                       {} //nolint:unused // proves that unexported methods are not exposed

func newCalc(t *testing.T) *Dispatcher {
	t.Helper()
	d := New()
	if err := d.Register(&Calc{}); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestCallConvertsArgumentsAndResults(t *testing.T) {
	d := newCalc(t)
	tests := []struct {
		method, args, want string
	}{
		{"Add", `[2,3]`, `5`},
		{"Nothing", `[]`, `null`},
		{"Nothing", ``, `null`},
		{"Echo", `[{"a":1,"b":"x"}]`, `{"a":1,"b":"x"}`},
		{"Bytes", `["aGk="]`, `"aGkh"`}, // []byte is base64, like Wails
		{"Tags", `[]`, `null`},          // a nil slice is null, like Wails
		{"When", `["2026-10-29T10:00:00Z"]`, `"2026-10-29T11:00:00Z"`},
		{"Maybe", `[true]`, `"v"`},
		{"Lists", `[{"k":[1,2]}]`, `["x"]`},
	}
	for _, tt := range tests {
		got, err := d.Call("Calc", tt.method, tt.args)
		if err != nil || got != tt.want {
			t.Errorf("%s%s = %q, %v; want %q", tt.method, tt.args, got, err, tt.want)
		}
	}
}

func TestCallErrors(t *testing.T) {
	d := newCalc(t)
	tests := []struct {
		name, service, method, args, wantErr string
	}{
		{"error result rejects with its message", "Calc", "Fail", `["boom"]`, "boom"},
		{"error from a value+error method", "Calc", "Maybe", `[false]`, "no"},
		{"unknown service", "Nope", "Add", `[1,2]`, `unknown service "Nope"`},
		{"unknown method", "Calc", "Nope", `[]`, "unknown method Calc.Nope"},
		{"unexported methods are not callable", "Calc", "unexported", `[]`, "unknown method"},
		{"too few arguments", "Calc", "Add", `[1]`, "takes 2 arguments, got 1"},
		{"too many arguments", "Calc", "Add", `[1,2,3]`, "takes 2 arguments, got 3"},
		{"wrong argument type", "Calc", "Add", `["a",2]`, "argument 1"},
		{"arguments are not an array", "Calc", "Add", `{"a":1}`, "JSON array"},
		{"a panic is an error, not a crash", "Calc", "Div", `[1,0]`, "panicked"},
	}
	for _, tt := range tests {
		_, err := d.Call(tt.service, tt.method, tt.args)
		if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
			t.Errorf("%s: err = %v, want it to contain %q", tt.name, err, tt.wantErr)
		}
	}
}

func TestMethodsAreSortedAndExported(t *testing.T) {
	got := newCalc(t).Methods()["Calc"]
	want := []string{"Add", "Bytes", "Div", "Echo", "Fail", "Lists", "Maybe", "Nothing", "Tags", "When"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("methods = %v, want %v", got, want)
	}
}

type Variadic struct{}

func (Variadic) F(...int) {}

type TwoValues struct{}

func (TwoValues) F() (int, int) { return 1, 2 }

func TestRegisterRefusesWhatWailsCannotBind(t *testing.T) {
	d := New()
	if err := d.Register(&Variadic{}); err == nil {
		t.Error("a variadic method was accepted")
	}
	if err := d.Register(&TwoValues{}); err == nil {
		t.Error("a method with two values was accepted")
	}
	if err := d.Register(Calc{}); err == nil {
		t.Error("a struct value (not a pointer) was accepted")
	}
	if err := d.Register(&Calc{}); err != nil {
		t.Fatal(err)
	}
	if err := d.Register(&Calc{}); err == nil {
		t.Error("registering a service twice was accepted")
	}
}
