package features_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"clarae/shared/features/internal/featuregen"
)

// adminGuide documents every key of the Config Profile in a table (section "Chiavi del profilo").
const adminGuide = "docs/admin-guide/profili-quote-audit.md"

type docRow struct{ typ, def, lockable, clients string }

// docTable reads the table whose header starts with "| Chiave | Tipo | Default |".
func docTable(t *testing.T) map[string]docRow {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, adminGuide))
	if err != nil {
		t.Fatal(err)
	}
	rows := map[string]docRow{}
	in := false
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "|") {
			if in {
				break
			}
			continue
		}
		cells := strings.Split(strings.Trim(line, "|"), "|")
		for i := range cells {
			cells[i] = strings.TrimSpace(cells[i])
		}
		if !in {
			in = len(cells) == 6 && cells[0] == "Chiave" && cells[1] == "Tipo" && cells[2] == "Default"
			continue
		}
		if strings.HasPrefix(cells[0], "---") {
			continue
		}
		if len(cells) != 6 {
			t.Fatalf("%s: a row of the keys table has %d cells: %s", adminGuide, len(cells), line)
		}
		key := strings.Trim(cells[0], "`")
		if _, dup := rows[key]; dup {
			t.Errorf("%s: %s is documented twice", adminGuide, key)
		}
		rows[key] = docRow{typ: cells[1], def: cells[2], lockable: cells[4], clients: cells[5]}
	}
	if len(rows) == 0 {
		t.Fatalf("%s: the table of the profile keys (| Chiave | Tipo | Default | ...) is missing", adminGuide)
	}
	return rows
}

// The admin guide documents exactly the keys of the schema, with their type and default.
func TestAdminGuideDocumentsEveryKey(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(root, featuregen.SchemaPath))
	if err != nil {
		t.Fatal(err)
	}
	s, err := featuregen.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	rows := docTable(t)
	for _, k := range s.Keys {
		r, ok := rows[k.Path]
		if !ok {
			t.Errorf("%s: no row for %s (add it to the table)", adminGuide, k.Path)
			continue
		}
		delete(rows, k.Path)
		if k.Type == "enum" {
			if !strings.HasPrefix(r.typ, "enum:") {
				t.Errorf("%s: type of %s is %q, want enum: <values>", adminGuide, k.Path, r.typ)
			}
			for _, v := range k.Enum {
				if !strings.Contains(r.typ, "`"+v+"`") {
					t.Errorf("%s: type of %s does not list `%s`", adminGuide, k.Path, v)
				}
			}
		} else if r.typ != "`"+k.Type+"`" {
			t.Errorf("%s: type of %s is %s, the schema says %s", adminGuide, k.Path, r.typ, k.Type)
		}
		want := "—"
		if k.Default != nil {
			b, _ := json.Marshal(k.Default)
			want = "`" + string(b) + "`"
		}
		if r.def != want {
			t.Errorf("%s: default of %s is %s, the schema says %s", adminGuide, k.Path, r.def, want)
		}
		if r.lockable != "sì" && r.lockable != "no" {
			t.Errorf("%s: lockable of %s is %q (sì or no)", adminGuide, k.Path, r.lockable)
		}
		if r.clients == "" {
			t.Errorf("%s: clients of %s are empty (— when none applies it)", adminGuide, k.Path)
		}
	}
	for k := range rows {
		t.Errorf("%s: %s is not a key of the schema", adminGuide, k)
	}
}
