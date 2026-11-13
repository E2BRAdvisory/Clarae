// Package fixture holds services shaped like the bindings of the application, with every kind of field and
// method signature the generator has to handle. generate_test.go compares what the generator writes for it
// with testdata/golden, which `wails generate module` (Wails v2.17.1) wrote for the same package: the two
// must stay byte for byte equal. To change the fixture, regenerate the golden with
// testdata/regen-golden.sh and review the diff.
package fixture

import (
	"time"

	"clarae/apps/desktop/internal/app/gen/bindings/fixture/other"
)

// Base is embedded: its fields belong to the structs that embed it.
type Base struct {
	ID      string `json:"id"`
	Created int64  `json:"created"`
}

// Note exercises the field kinds.
type Note struct {
	Base
	*Extra
	Title      string                    `json:"title"`
	Body       string                    `json:"body,omitempty"`
	Count      int                       `json:"count"`
	Ratio      float64                   `json:"ratio"`
	Flag       bool                      `json:"flag"`
	Raw        []byte                    `json:"raw"`
	Any        any                       `json:"any"`
	Tags       []string                  `json:"tags"`
	Grid       [][]int                   `json:"grid"`
	Pairs      [2]string                 `json:"pairs"`
	Children   []Note                    `json:"children"`
	Links      []*Link                   `json:"links"`
	Matrix     [][]Link                  `json:"matrix"`
	Parent     *Link                     `json:"parent"`
	Pointer    *int                      `json:"pointer"`
	Nested     Link                      `json:"nested"`
	Props      map[string]string         `json:"props"`
	ByID       map[string]Link           `json:"byId"`
	ByPtr      map[string]*Link          `json:"byPtr"`
	Lists      map[string][]Link         `json:"lists"`
	Counts     map[int]int               `json:"counts"`
	Maps       map[string]map[string]int `json:"maps"`
	Foreign    other.Tag                 `json:"foreign"`
	ForeignPtr *other.Tag                `json:"foreignPtr"`
	ForeignAll []other.Tag               `json:"foreignAll"`
	ForeignMap map[string]other.Labels   `json:"foreignMap"`
	When       time.Time                 `json:"when"`
	WhenPtr    *time.Time                `json:"whenPtr,omitempty"`
	Stamp      time.Time                 `json:"stamp" ts_type:"string"`
	StampList  []time.Time               `json:"stampList" ts_type:"string[]"`
	Kind       string                    `json:"kind" ts_type:"'a' | 'b'"`
	Date       string                    `json:"date" ts_transform:"new Date(__VALUE__)" ts_type:"Date"`
	Odd        string                    `json:"odd-name"`
	OddPtr     *Link                     `json:"odd ptr,omitempty"`
	OddMap     map[string]string         `json:"odd.map"`
	Inline     struct{ A int }           `json:"inline"`
	Hidden     string                    `json:"-"`
	Untagged   string
	UntaggedP  *Link
	private    string   //nolint:unused // an unexported field gets no TypeScript field
	Handler    func()   `json:"handler"`
	Chan       chan int `json:"chan"`
}

// Extra is embedded through a pointer.
type Extra struct {
	Note2 string `json:"note2,omitempty"`
}

// Link is a nested struct.
type Link struct {
	Target string `json:"target"`
	Parent *Link  `json:"parent,omitempty"`
	Group  *Group `json:"group,omitempty"`
}

// Group refers back to Note (a cycle).
type Group struct {
	Notes []Note `json:"notes"`
}

// Page is generic.
type Page[T any] struct {
	Items []T    `json:"items"`
	Next  string `json:"next,omitempty"`
}

// Options has only unexported fields: it gets no class.
type Options struct{ secret string } //nolint:unused // see above

// NoteAPI exercises the method signatures.
type NoteAPI struct{}

// NewNoteAPI returns the service.
func NewNoteAPI() *NoteAPI { return &NoteAPI{} }

func (a *NoteAPI) Nothing()                              {}
func (a *NoteAPI) OnlyError() error                      { return nil }
func (a *NoteAPI) OnlyValue() string                     { return "" }
func (a *NoteAPI) ValueAndError() (Note, error)          { return Note{}, nil }
func (a *NoteAPI) PointerAndError() (*Note, error)       { return nil, nil }
func (a *NoteAPI) ListAndError() ([]Note, error)         { return nil, nil }
func (a *NoteAPI) PointerListAndError() ([]*Link, error) { return nil, nil }
func (a *NoteAPI) TwoValues() (string, int)              { return "", 0 }
func (a *NoteAPI) ThreeValues() (string, int, error)     { return "", 0, nil }
func (a *NoteAPI) Bytes(b []byte) ([]byte, error)        { return b, nil }
func (a *NoteAPI) Scalars(s string, i int, u uint8, f float32, b bool) error {
	return nil
}
func (a *NoteAPI) Structs(n Note, l *Link, ls []Link, ps []*Link) error { return nil }
func (a *NoteAPI) Maps(m map[string]string, n map[string]Link, o map[string][]string) (map[string]Link, error) {
	return nil, nil
}
func (a *NoteAPI) Slices(s []string, ss [][]string, i []int) ([][]string, error) { return nil, nil }
func (a *NoteAPI) Variadic(parts ...string) error                                { return nil }
func (a *NoteAPI) Anything(v any, vs []any) (any, error)                         { return nil, nil }
func (a *NoteAPI) Foreign(t other.Tag, p *other.Tag) ([]other.Tag, error)        { return nil, nil }
func (a *NoteAPI) ForeignMap() (map[string]other.Tag, error)                     { return nil, nil }
func (a *NoteAPI) Generic() (Page[Link], error)                                  { return Page[Link]{}, nil }
func (a *NoteAPI) GenericPtr(p *Page[string]) error                              { return nil }
func (a *NoteAPI) Time(t time.Time) (time.Time, error)                           { return t, nil }
func (a *NoteAPI) Empty(o Options) (*Options, error)                             { return nil, nil }
func (a *NoteAPI) unexported()                                                   {} //nolint:unused // an unexported method is not bound

// TagAPI is a second service in the same package.
type TagAPI struct{}

// NewTagAPI returns the service.
func NewTagAPI() *TagAPI { return &TagAPI{} }

func (a *TagAPI) List() ([]other.Tag, error) { return nil, nil }
func (a *TagAPI) Rename(from, to string) (other.Labels, error) {
	return other.Labels{}, nil
}

// Services are the fixture's services, in the order they are bound.
func Services() []any { return []any{NewNoteAPI(), NewTagAPI()} }
