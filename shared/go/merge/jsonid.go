package merge

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
)

type rawObject map[string]json.RawMessage

func decodeObject(b []byte) (rawObject, error) {
	var o rawObject
	if len(bytes.TrimSpace(b)) == 0 {
		return rawObject{}, nil
	}
	if err := json.Unmarshal(b, &o); err != nil {
		return nil, err
	}
	if o == nil {
		o = rawObject{}
	}
	return o, nil
}

func encodeObject(o rawObject) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "\t")
	if err := enc.Encode(o); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func jsonEqual(a, b json.RawMessage) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return bytes.Equal(a, b)
	}
	xa, _ := json.Marshal(x)
	ya, _ := json.Marshal(y)
	return bytes.Equal(xa, ya)
}

// elementsByID decodes an array of objects keyed by "id", keeping order.
func elementsByID(raw json.RawMessage) (order []string, byID map[string]json.RawMessage, err error) {
	byID = map[string]json.RawMessage{}
	if len(raw) == 0 {
		return nil, byID, nil
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil, nil, err
	}
	for i, el := range arr {
		var head struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(el, &head); err != nil || head.ID == "" {
			return nil, nil, fmt.Errorf("element %d has no id", i)
		}
		if _, dup := byID[head.ID]; !dup {
			order = append(order, head.ID)
		}
		byID[head.ID] = el
	}
	return order, byID, nil
}

func marshalElements(order []string, byID map[string]json.RawMessage) json.RawMessage {
	out := make([]json.RawMessage, 0, len(order))
	for _, id := range order {
		out = append(out, byID[id])
	}
	b, _ := json.Marshal(out)
	return b
}

// excalidrawVersion reads the reconciliation fields of an element.
func excalidrawVersion(el json.RawMessage) (version, nonce int64) {
	var v struct {
		Version      int64 `json:"version"`
		VersionNonce int64 `json:"versionNonce"`
	}
	_ = json.Unmarshal(el, &v)
	return v.Version, v.VersionNonce
}

// Excalidraw merges two drawings of the same author by element id: the
// element with the higher version wins, ties go to the lower versionNonce
// (Excalidraw's own reconciliation); ids are united, deleted elements stay
// deleted (isDeleted is just a field of the winning version) and the files
// map is united. Other top-level keys follow the side that changed them.
func Excalidraw(base, ours, theirs []byte) (Result, error) {
	bo, err := decodeObject(base)
	if err != nil {
		bo = rawObject{}
	}
	oo, err := decodeObject(ours)
	if err != nil {
		return Result{}, fmt.Errorf("ours: %w", err)
	}
	to, err := decodeObject(theirs)
	if err != nil {
		return Result{}, fmt.Errorf("theirs: %w", err)
	}
	out := rawObject{}
	for k, v := range to {
		out[k] = v
	}
	// Scalars/appState: a side that differs from base wins; both -> ours (same author, newer).
	for k, ov := range oo {
		if k == "elements" || k == "files" {
			continue
		}
		bv, inBase := bo[k]
		tv, inTheirs := to[k]
		if !inTheirs || !inBase || !jsonEqual(ov, bv) {
			if !inTheirs || !jsonEqual(ov, tv) {
				out[k] = ov
			}
		}
	}

	oOrder, oEls, err := elementsByID(oo["elements"])
	if err != nil {
		return Result{}, fmt.Errorf("ours: %w", err)
	}
	tOrder, tEls, err := elementsByID(to["elements"])
	if err != nil {
		return Result{}, fmt.Errorf("theirs: %w", err)
	}
	order := append([]string(nil), tOrder...)
	merged := map[string]json.RawMessage{}
	for id, el := range tEls {
		merged[id] = el
	}
	for _, id := range oOrder {
		oel := oEls[id]
		tel, both := tEls[id]
		if !both {
			order = append(order, id)
			merged[id] = oel
			continue
		}
		ov, on := excalidrawVersion(oel)
		tv, tn := excalidrawVersion(tel)
		if ov > tv || (ov == tv && on < tn) {
			merged[id] = oel
		}
	}
	out["elements"] = marshalElements(order, merged)

	files := map[string]json.RawMessage{}
	for _, src := range []json.RawMessage{oo["files"], to["files"]} {
		if len(src) == 0 {
			continue
		}
		var m map[string]json.RawMessage
		if json.Unmarshal(src, &m) == nil {
			for k, v := range m {
				files[k] = v
			}
		}
	}
	if len(files) > 0 || oo["files"] != nil || to["files"] != nil {
		b, _ := json.Marshal(files)
		out["files"] = b
	}
	b, err := encodeObject(out)
	if err != nil {
		return Result{}, err
	}
	return Result{Merged: b, Clean: true}, nil
}

// Canvas merges two JSON Canvas files of the same author by node and edge id.
// An id changed on both sides (against base) is decided by server time: the
// newer revision wins and the loser's whole file becomes a conflict copy.
func Canvas(base, ours, theirs []byte, opt Options) (Result, error) {
	bo, err := decodeObject(base)
	if err != nil {
		bo = rawObject{}
	}
	oo, err := decodeObject(ours)
	if err != nil {
		return Result{}, fmt.Errorf("ours: %w", err)
	}
	to, err := decodeObject(theirs)
	if err != nil {
		return Result{}, fmt.Errorf("theirs: %w", err)
	}
	out := rawObject{}
	for k, v := range to {
		out[k] = v
	}
	res := Result{Clean: true}
	loser := None
	newer := Theirs
	if opt.oursNewer() {
		newer = Ours
	}
	for k, ov := range oo {
		if k == "nodes" || k == "edges" {
			continue
		}
		if _, ok := out[k]; !ok {
			out[k] = ov
		}
	}
	for _, key := range []string{"nodes", "edges"} {
		_, bEls, _ := elementsByID(bo[key])
		oOrder, oEls, err := elementsByID(oo[key])
		if err != nil {
			return Result{}, fmt.Errorf("ours %s: %w", key, err)
		}
		tOrder, tEls, err := elementsByID(to[key])
		if err != nil {
			return Result{}, fmt.Errorf("theirs %s: %w", key, err)
		}
		order := append([]string(nil), tOrder...)
		merged := map[string]json.RawMessage{}
		for id, el := range tEls {
			merged[id] = el
		}
		// Ids that existed in base and vanished on one side were deleted there.
		for _, id := range oOrder {
			oel := oEls[id]
			tel, inT := tEls[id]
			bel, inB := bEls[id]
			switch {
			case !inT && inB:
				// theirs deleted it; ours kept it: keep only if ours changed it.
				if !jsonEqual(oel, bel) {
					order = append(order, id)
					merged[id] = oel
				}
			case !inT:
				order = append(order, id)
				merged[id] = oel
			case jsonEqual(oel, tel):
			case inB && jsonEqual(oel, bel): // only theirs changed
			case inB && jsonEqual(tel, bel): // only ours changed
				merged[id] = oel
			default: // both changed
				res.Conflicts = append(res.Conflicts, Hunk{Where: key + " " + id, Ours: string(oel), Theirs: string(tel)})
				if newer == Ours {
					merged[id] = oel
					loser = Theirs
				} else {
					loser = Ours
				}
			}
		}
		// Ids ours deleted while theirs left them untouched.
		for _, id := range tOrder {
			if _, inO := oEls[id]; inO {
				continue
			}
			bel, inB := bEls[id]
			if inB && jsonEqual(tEls[id], bel) {
				delete(merged, id)
				order = removeString(order, id)
			}
		}
		out[key] = marshalElements(order, merged)
	}
	b, err := encodeObject(out)
	if err != nil {
		return Result{}, err
	}
	res.Merged = b
	if loser != None {
		res.Clean = false
		res.CopyOf = loser
	}
	return res, nil
}

func removeString(s []string, v string) []string {
	out := s[:0]
	for _, x := range s {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}

// ConfigLWW merges a settings JSON file with last-write-wins per top-level
// key (§3.4.5). A key changed on one side only takes that change; changed on
// both, the newer server time wins. It never produces a conflict copy.
func ConfigLWW(base, ours, theirs []byte, opt Options) (Result, error) {
	bo, err := decodeObject(base)
	if err != nil {
		bo = rawObject{}
	}
	oo, err := decodeObject(ours)
	if err != nil {
		return Result{}, fmt.Errorf("ours: %w", err)
	}
	to, err := decodeObject(theirs)
	if err != nil {
		return Result{}, fmt.Errorf("theirs: %w", err)
	}
	keys := map[string]bool{}
	for _, m := range []rawObject{bo, oo, to} {
		for k := range m {
			keys[k] = true
		}
	}
	sorted := make([]string, 0, len(keys))
	for k := range keys {
		sorted = append(sorted, k)
	}
	sort.Strings(sorted)
	out := rawObject{}
	for _, k := range sorted {
		b, inB := bo[k]
		o, inO := oo[k]
		t, inT := to[k]
		eq := func(x json.RawMessage, xok bool, y json.RawMessage, yok bool) bool {
			return xok == yok && (!xok || jsonEqual(x, y))
		}
		var v json.RawMessage
		var ok bool
		switch {
		case eq(o, inO, t, inT):
			v, ok = o, inO
		case eq(o, inO, b, inB):
			v, ok = t, inT
		case eq(t, inT, b, inB):
			v, ok = o, inO
		case opt.oursNewer():
			v, ok = o, inO
		default:
			v, ok = t, inT
		}
		if ok {
			out[k] = v
		}
	}
	enc, err := encodeObject(out)
	if err != nil {
		return Result{}, err
	}
	return Result{Merged: enc, Clean: true}, nil
}
