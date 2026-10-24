package importer

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"
)

func init() {
	Register(&source{id: "csv", detect: detectCSV, exec: execCSV}, SourceInfo{Input: "file", Extensions: []string{"csv", "tsv", "txt"}})
}

func detectCSV(p string) (bool, error) {
	switch strings.ToLower(filepath.Ext(p)) {
	case ".csv", ".tsv":
		return true, nil
	}
	return false, nil
}

// detectDelimiter picks the candidate that splits the first lines into the most consistent
// number of columns (more than one).
func detectDelimiter(data []byte) string {
	sample := data
	if len(sample) > 64<<10 {
		sample = sample[:64<<10]
	}
	lines := strings.Split(strings.ReplaceAll(string(sample), "\r\n", "\n"), "\n")
	if len(lines) > 21 {
		lines = lines[:21]
	}
	best, bestScore := ",", 0
	for _, d := range []string{",", ";", "\t", "|"} {
		counts := map[int]int{}
		for _, l := range lines {
			if strings.TrimSpace(l) != "" {
				counts[strings.Count(l, d)]++
			}
		}
		for n, freq := range counts {
			if n == 0 {
				continue
			}
			if score := freq*10 + n; score > bestScore {
				best, bestScore = d, score
			}
		}
	}
	return best
}

// parseCSV reads all records; delim "" detects the delimiter. The returned delimiter is the
// one used.
func parseCSV(data []byte, delim string) ([][]string, string, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	if delim == "" {
		delim = detectDelimiter(data)
	}
	rs := []rune(delim)
	if len(rs) != 1 || rs[0] == '"' || rs[0] == '\n' || rs[0] == '\r' {
		return nil, "", fmt.Errorf("invalid: bad CSV delimiter %q", delim)
	}
	rd := csv.NewReader(bytes.NewReader(data))
	rd.Comma = rs[0]
	rd.FieldsPerRecord = -1
	rd.LazyQuotes = true
	var rows [][]string
	for {
		rec, err := rd.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, "", fmt.Errorf("invalid: CSV: %w", err)
		}
		empty := true
		for _, c := range rec {
			if strings.TrimSpace(c) != "" {
				empty = false
				break
			}
		}
		if !empty {
			rows = append(rows, rec)
		}
	}
	return rows, delim, nil
}

// columnKeys turns header cells into unique, non-empty property names.
func columnKeys(header []string) []string {
	keys := make([]string, len(header))
	seen := map[string]bool{}
	for i, h := range header {
		k := strings.Join(strings.Fields(h), " ")
		if k == "" {
			k = fmt.Sprintf("column-%d", i+1)
		}
		base, n := k, 2
		for seen[strings.ToLower(k)] {
			k = fmt.Sprintf("%s-%d", base, n)
			n++
		}
		seen[strings.ToLower(k)] = true
		keys[i] = k
	}
	return keys
}

func isListKey(k string) bool {
	switch strings.ToLower(k) {
	case "tags", "tag", "aliases", "alias":
		return true
	}
	return false
}

// rowProps converts a record into frontmatter properties, skipping the given columns.
func rowProps(keys, rec []string, skip map[int]bool) []Prop {
	var props []Prop
	for i, k := range keys {
		if skip[i] || i >= len(rec) {
			continue
		}
		cellVal := strings.TrimSpace(rec[i])
		if cellVal == "" {
			continue
		}
		if isListKey(k) {
			parts := strings.FieldsFunc(cellVal, func(r rune) bool { return r == ',' || r == ';' })
			name := strings.ToLower(k)
			switch name {
			case "tag":
				name = "tags"
			case "alias":
				name = "aliases"
			}
			if name == "tags" {
				if l := tagList(parts); len(l) > 0 {
					props = append(props, Prop{Key: name, Value: l})
				}
				continue
			}
			var l []string
			for _, p := range parts {
				if p = strings.TrimSpace(p); p != "" {
					l = append(l, p)
				}
			}
			props = append(props, Prop{Key: name, Value: l})
			continue
		}
		if v := inferValue(cellVal); v != nil {
			props = append(props, Prop{Key: k, Value: v})
		}
	}
	return props
}

func colIndex(keys []string, name string) (int, bool) {
	name = strings.ToLower(strings.TrimSpace(name))
	for i, k := range keys {
		if strings.ToLower(k) == name {
			return i, true
		}
	}
	return 0, false
}

func execCSV(r *run, p string) error {
	rc, err := openCapped(p, r.lim)
	if err != nil {
		return err
	}
	data, err := io.ReadAll(rc)
	_ = rc.Close()
	if err != nil {
		return err
	}
	rows, delim, err := parseCSV(data, r.opts.CSV.Delimiter)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return errors.New("invalid: the CSV file has no rows")
	}
	var header []string
	if r.opts.CSV.NoHeader {
		for i := range rows[0] {
			header = append(header, fmt.Sprintf("Column %d", i+1))
		}
	} else {
		header, rows = rows[0], rows[1:]
	}
	cols := len(header)
	for _, row := range rows {
		cols = max(cols, len(row))
	}
	for len(header) < cols {
		header = append(header, "")
	}
	keys := columnKeys(header)
	r.rep.csvColumns, r.rep.csvDelimiter = keys, delim

	titleCol, bodyCol := 0, -1
	if t := r.opts.CSV.TitleColumn; t != "" {
		i, ok := colIndex(keys, t)
		if !ok {
			return fmt.Errorf("invalid: title column %q not found", t)
		}
		titleCol = i
	}
	if b := r.opts.CSV.BodyColumn; b != "" {
		i, ok := colIndex(keys, b)
		if !ok {
			return fmt.Errorf("invalid: body column %q not found", b)
		}
		bodyCol = i
	}
	skip := map[int]bool{titleCol: true}
	if bodyCol >= 0 {
		skip[bodyCol] = true
	}
	r.setTotal(len(rows))
	for n, rec := range rows {
		if err := r.step(fmt.Sprintf("row %d", n+1)); err != nil {
			return err
		}
		title := ""
		if titleCol < len(rec) {
			title = strings.TrimSpace(rec[titleCol])
		}
		if title == "" {
			title = fmt.Sprintf("Row %d", n+1)
		}
		body := ""
		if bodyCol >= 0 && bodyCol < len(rec) {
			body = normalizeText(rec[bodyCol])
		}
		src := fmt.Sprintf("row %d", n+1)
		_ = r.putNote(src, title, "", sanitizeName(title), buildNote(rowProps(keys, rec, skip), body))
	}
	return nil
}
