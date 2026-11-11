//go:build !js

// What the bindings of a set of services expose: their methods and the structs those methods exchange.
//
// Ported from github.com/wailsapp/wails/v2 (v2.17.1, internal/binding: binding.go, reflect.go,
// boundMethod.go), MIT License, Copyright (c) 2018-Present Lea Anthony (LICENSE-wails.txt). The call
// machinery, obfuscation, enums and the TypeScript naming options are gone; the walk over the types is the
// same, so the set of methods and of classes is the one `wails generate module` finds.
package main

import (
	"fmt"
	"reflect"
	"sort"
	"strings"
)

// method is one exported method of a service.
type method struct {
	name    string
	inputs  []string // reflect.Type.String() of each parameter, as Wails records them
	outputs []string
}

// bindings is the result of reflecting over the services.
type bindings struct {
	// methods is package -> service -> method name -> method
	methods map[string]map[string]map[string]*method
	// structs is package -> struct name -> a zero value of the struct, for every struct that needs a class
	structs map[string]map[string]any
}

// collect reflects over services, which must all be pointers to structs (what App.Services returns).
func collect(services []any) (*bindings, error) {
	b := &bindings{
		methods: map[string]map[string]map[string]*method{},
		structs: map[string]map[string]any{},
	}
	for _, s := range services {
		if err := b.add(s); err != nil {
			return nil, fmt.Errorf("cannot bind value to app: %w", err)
		}
	}
	return b, nil
}

func isStructPtr(value any) bool {
	return reflect.ValueOf(value).Kind() == reflect.Pointer &&
		reflect.ValueOf(value).Elem().Kind() == reflect.Struct
}

func normalizeStructName(name string) string {
	return strings.NewReplacer(",", "-", "*", "", "]", "__", "[", "__").Replace(name)
}

func (b *bindings) add(service any) error {
	if !isStructPtr(service) {
		return fmt.Errorf("%T is not a pointer to a struct", service)
	}

	structType := reflect.TypeOf(service)
	structName := structType.Elem().Name()
	structNameNormalized := normalizeStructName(structName)
	pkgPath := strings.TrimSuffix(structType.Elem().String(), fmt.Sprintf(".%s", structName))

	for i := 0; i < structType.NumMethod(); i++ {
		methodType := structType.Method(i).Type
		m := &method{name: structType.Method(i).Name}

		// The receiver is the first parameter of a method taken from the type, not from a value.
		for in := 1; in < methodType.NumIn(); in++ {
			input := methodType.In(in)
			m.inputs = append(m.inputs, input.String())
			b.addStructsOf(input)
		}
		for out := 0; out < methodType.NumOut(); out++ {
			output := methodType.Out(out)
			m.outputs = append(m.outputs, output.String())
			b.addStructsOf(output)
		}

		if b.methods[pkgPath] == nil {
			b.methods[pkgPath] = map[string]map[string]*method{}
		}
		if b.methods[pkgPath][structNameNormalized] == nil {
			b.methods[pkgPath][structNameNormalized] = map[string]*method{}
		}
		b.methods[pkgPath][structNameNormalized][m.name] = m
	}
	return nil
}

// addStructsOf registers the struct a parameter is (or points to, or is a slice of): one level, like
// Wails; addStruct then follows the fields.
func (b *bindings) addStructsOf(t reflect.Type) {
	if t.Kind() == reflect.Slice {
		t = t.Elem()
	}
	if t.Kind() == reflect.Pointer && t.Elem().Kind() == reflect.Struct {
		typ := t.Elem()
		b.addStruct(getPackageName(t.String()), typ.Name(), reflect.Indirect(reflect.New(typ)).Interface())
	}
	if t.Kind() == reflect.Struct {
		b.addStruct(getPackageName(t.String()), t.Name(), reflect.Indirect(reflect.New(t)).Interface())
	}
}

// addStruct registers a struct and, recursively, the structs of its exported fields.
func (b *bindings) addStruct(packageName string, structName string, s any) {
	if b.structs[packageName] == nil {
		b.structs[packageName] = map[string]any{}
	}
	if b.structs[packageName][structName] != nil {
		return
	}
	b.structs[packageName][structName] = s

	structType := reflect.TypeOf(s)
	for hasElements(structType) {
		structType = structType.Elem()
	}

	for i := 0; i < structType.NumField(); i++ {
		field := structType.Field(i)
		if field.Anonymous || !field.IsExported() {
			continue
		}
		fType := field.Type
		if fType.Kind() != reflect.Struct {
			for hasElements(fType) {
				fType = fType.Elem()
			}
		}
		if fType.Kind() != reflect.Struct {
			continue
		}
		fqname := fType.String()
		sNameSplit := strings.SplitN(fqname, ".", 2)
		if len(sNameSplit) < 2 {
			continue
		}
		if hasExportedJSONFields(fType) {
			b.addStruct(getPackageName(fqname), sNameSplit[1], reflect.Indirect(reflect.New(fType)).Interface())
		}
	}
}

func hasExportedJSONFields(typeOf reflect.Type) bool {
	for i := 0; i < typeOf.NumField(); i++ {
		jsonFieldName := ""
		f := typeOf.Field(i)
		// function, complex, and channel types cannot be json-encoded
		if f.Type.Kind() == reflect.Chan ||
			f.Type.Kind() == reflect.Func ||
			f.Type.Kind() == reflect.UnsafePointer ||
			f.Type.Kind() == reflect.Complex128 ||
			f.Type.Kind() == reflect.Complex64 {
			continue
		}
		jsonTag, hasTag := f.Tag.Lookup("json")
		if !hasTag && f.IsExported() {
			return true
		}
		if len(jsonTag) == 0 {
			continue
		}
		jsonTagParts := strings.Split(jsonTag, ",")
		if len(jsonTagParts) > 0 {
			jsonFieldName = jsonTagParts[0]
		}
		if jsonFieldName != "" {
			return true
		}
	}
	return false
}

func getPackageName(in string) string {
	result := strings.Split(in, ".")[0]
	result = strings.ReplaceAll(result, "[]", "")
	result = strings.ReplaceAll(result, "*", "")
	return result
}

func hasElements(typ reflect.Type) bool {
	kind := typ.Kind()
	return kind == reflect.Pointer || kind == reflect.Array || kind == reflect.Slice || kind == reflect.Map
}

// sortedKeys returns the keys of a map in order, so the output does not depend on map iteration.
func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
