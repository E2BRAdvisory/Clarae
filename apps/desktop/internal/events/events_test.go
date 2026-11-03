package events

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

type phase string

const (
	phaseA phase = "a"
	phaseB phase = "b"
)

type inner struct {
	When time.Time `json:"when"`
}

type base struct {
	ID     string `json:"id"`
	Shadow int    `json:"shadow"`
}

type payload struct {
	base
	Shadow   string            `json:"shadow"` // the outer field wins over the embedded one
	Phase    phase             `json:"phase"`
	Count    int               `json:"count,omitempty"`
	Big      int64             `json:"big,string"`
	Ptr      *inner            `json:"ptr"`
	Opt      *inner            `json:"opt,omitempty"`
	List     []inner           `json:"list"`
	Raw      []byte            `json:"raw"`
	Map      map[string][]int  `json:"map"`
	Any      any               `json:"any"`
	Skipped  string            `json:"-"`
	NoTag    bool              // the Go name is the JSON name
	hidden   string            // not marshalled
	Nested   struct{ X int }   `json:"nested"`
	RawJSON  json.RawMessage   `json:"rawJson"`
	Enumlist []phase           `json:"enumlist"`
	Strs     map[string]string `json:"strs"`
}

func TestTypeScript(t *testing.T) {
	_ = payload{hidden: "never sent"}
	ev := New[payload]("thing:changed", "Something changed.")
	sig := NewSignal("app:poke", "No payload.")
	out, err := TypeScript([]Spec{ev.Spec(), sig.Spec()}, []EnumSpec{Enum(phaseA, phaseB)})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{
		"  thingChanged: 'thing:changed',",
		"  appPoke: 'app:poke',",
		"  'thing:changed': EventsPayload;",
		"  'app:poke': undefined;",
		"export type EventsPhase = 'a' | 'b';",
		"  id: string;",
		"  shadow: string;",
		"  phase: EventsPhase;",
		"  count?: number;",
		"  big: string;",
		"  ptr: EventsInner | null;",
		"  opt?: EventsInner;",
		"  list: EventsInner[];",
		"  raw: string;",
		"  map: Record<string, number[]>;",
		"  any: unknown;",
		"  NoTag: boolean;",
		"  nested: {\n    X: number;\n  };",
		"  rawJson: unknown;",
		"  enumlist: EventsPhase[];",
		"export interface EventsInner {\n  when: string;\n}",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q in\n%s", want, s)
		}
	}
	for _, unwanted := range []string{"Skipped", "hidden", "shadow: number"} {
		if strings.Contains(s, unwanted) {
			t.Errorf("unexpected %q in\n%s", unwanted, s)
		}
	}
}

type marshals struct{}

func (marshals) MarshalJSON() ([]byte, error) { return []byte(`1`), nil }

type withChan struct {
	C chan int `json:"c"`
}

func TestTypeScriptRefuses(t *testing.T) {
	cases := map[string][]Spec{
		"listed twice":         {New[inner]("a:b", "").Spec(), New[inner]("a:b", "").Spec()},
		"must look like":       {New[inner]("Bad Name", "").Spec()},
		"same key":             {New[inner]("a:b-c", "").Spec(), New[inner]("a-b:c", "").Spec()},
		"its own MarshalJSON":  {New[marshals]("a:b", "").Spec()},
		"JSON cannot carry":    {New[withChan]("a:b", "").Spec()},
		"give the payload a n": {New[generic[int]]("a:b", "").Spec()},
	}
	for want, specs := range cases {
		if _, err := TypeScript(specs, nil); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err = %v", want, err)
		}
	}
	if _, err := TypeScript(nil, []EnumSpec{Enum(phaseA), Enum(phaseB)}); err == nil {
		t.Error("an enum listed twice was accepted")
	}
}

type generic[T any] struct {
	V T `json:"v"`
}

func TestSend(t *testing.T) {
	var got []string
	rec := func(name string, p any) { got = append(got, name); _ = p }
	New[int]("a:b", "").Send(rec, 1)
	NewSignal("c:d", "").Send(rec)
	New[int]("e:f", "").Send(nil, 1) // dropped
	if strings.Join(got, ",") != "a:b,c:d" {
		t.Fatalf("got %v", got)
	}
}
