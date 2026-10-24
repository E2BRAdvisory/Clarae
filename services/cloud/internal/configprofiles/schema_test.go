package configprofiles

import (
	"bytes"
	"os"
	"reflect"
	"testing"
)

func TestEmbeddedSchemaMatchesTheContract(t *testing.T) {
	want, err := os.ReadFile("../../../../api/config-profile.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(want, schemaJSON) {
		t.Fatal("internal/configprofiles/schema.json differs from api/config-profile.schema.json: copy the api file over it")
	}
}

func TestValidate(t *testing.T) {
	ok := []string{
		`{}`,
		`{"features":{"audio_recorder":false,"anything_else":true},"sync":{"interval_seconds":60}}`,
		`{"editor":{"fontSize":14,"linkFormat":"relative"},"hotkeys":{"palette:open":"Mod-p"},"servers":[{"name":"x","url":"https://x.example"}]}`,
		`{"appearance":{"accent":"#a1b2c3"},"templates":{"library_share_id":"0194f0a8-5e1c-7b1d-9a3e-2b8f4e7c1a10"}}`,
	}
	for _, s := range ok {
		if err := Validate([]byte(s)); err != nil {
			t.Errorf("%s: %v", s, err)
		}
	}
	bad := []string{
		`[]`, `{"unknown":1}`, `{"sync":{"interval_seconds":1}}`, `{"sync":{"interval_seconds":"30"}}`,
		`{"features":{"x":"yes"}}`, `{"editor":{"linkFormat":"wikilink"}}`, `{"appearance":{"accent":"red"}}`,
		`{"servers":[{"name":"x"}]}`, `{"editor":{"fontSize":4}}`, `not json`,
	}
	for _, s := range bad {
		if err := Validate([]byte(s)); err == nil {
			t.Errorf("%s must be refused", s)
		}
	}
}

func TestMergeIsDeepAndDoesNotAlias(t *testing.T) {
	a := map[string]any{"sync": map[string]any{"interval_seconds": 30, "max_file_size_bytes": 100}, "servers": []any{"a"}, "x": 1}
	b := map[string]any{"sync": map[string]any{"interval_seconds": 60}, "servers": []any{"b", "c"}, "y": 2}
	got := Merge(a, b)
	want := map[string]any{"sync": map[string]any{"interval_seconds": 60, "max_file_size_bytes": 100}, "servers": []any{"b", "c"}, "x": 1, "y": 2}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	got["sync"].(map[string]any)["interval_seconds"] = 5
	if a["sync"].(map[string]any)["interval_seconds"] != 30 || b["sync"].(map[string]any)["interval_seconds"] != 60 {
		t.Fatal("Merge must not modify or alias its inputs")
	}
}
