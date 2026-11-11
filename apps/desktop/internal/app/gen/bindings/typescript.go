//go:build !js

// The Go struct -> TypeScript class converter behind models.ts.
//
// Ported from github.com/wailsapp/wails/v2 (v2.17.1, internal/typescriptify), itself based on
// github.com/tkrajina/typescriptify-golang-structs by Tomo Krajina, licensed under the Apache License 2.0
// (LICENSE-typescriptify.txt). Wails is licensed under the MIT License (LICENSE-wails.txt).
//
// Changes from the upstream code, which keeps its output byte for byte (generate_test.go compares it with
// what `wails generate module` writes): the options this repository does not use are gone (prefix and
// suffix, interface output, enums, custom code blocks, backup files, per-type overrides), the dependencies
// on leaanthony/slicer and tkrajina/go-reflector are replaced by the standard library, and the progress
// lines upstream printed are not printed. The `ts_type` and `ts_transform` struct tags still apply.
package main

import (
	"fmt"
	"log"
	"os"
	"reflect"
	"regexp"
	"strings"
)

const (
	tsTransformTag      = "ts_transform"
	tsTypeTag           = "ts_type"
	tsConvertValuesFunc = `convertValues(a: any, classs: any, asMap: boolean = false): any {
	if (!a) {
		return a;
	}
	if (a.slice && a.map) {
		return (a as any[]).map(elem => this.convertValues(elem, classs));
	} else if ("object" === typeof a) {
		if (asMap) {
			for (const key of Object.keys(a)) {
				a[key] = new classs(a[key]);
			}
			return a;
		}
		return new classs(a);
	}
	return a;
}`
	jsVariableNameRegex = `^([A-Z]|[a-z]|\$|_)([A-Z]|[a-z]|[0-9]|\$|_)*$`
	tsIndent            = "    "
)

var (
	jsVariableUnsafeChars = regexp.MustCompile(`[^A-Za-z0-9_]`)
	jsVariableName        = regexp.MustCompile(jsVariableNameRegex)
)

// tsKinds maps the Go kinds that have a TypeScript primitive; everything else is `any`.
var tsKinds = map[reflect.Kind]string{
	reflect.Bool:      "boolean",
	reflect.Interface: "any",
	reflect.Int:       "number",
	reflect.Int8:      "number",
	reflect.Int16:     "number",
	reflect.Int32:     "number",
	reflect.Int64:     "number",
	reflect.Uint:      "number",
	reflect.Uint8:     "number",
	reflect.Uint16:    "number",
	reflect.Uint32:    "number",
	reflect.Uint64:    "number",
	reflect.Float32:   "number",
	reflect.Float64:   "number",
	reflect.String:    "string",
}

func nameTypeOf(typeOf reflect.Type) string {
	tname := typeOf.Name()
	gidx := strings.IndexRune(tname, '[')
	if gidx > 0 { // its a generic type
		rem := strings.SplitN(tname, "[", 2)
		tname = rem[0] + "_" + jsVariableUnsafeChars.ReplaceAllLiteralString(rem[1], "_")
	}
	return tname
}

// typeOptions are the `ts_type` and `ts_transform` tags of a field.
type typeOptions struct {
	TSType      string
	TSTransform string
}

// converter writes the classes of the structs of one Go package (the namespace of models.ts).
type converter struct {
	namespace    string
	knownStructs map[string]bool // "package.Struct" of every struct that has a class, in any namespace
	structTypes  []reflect.Type

	alreadyConverted map[string]bool // throwaway, used while converting
}

func (t *converter) add(structValue any) {
	t.structTypes = append(t.structTypes, reflect.TypeOf(structValue))
}

func (t *converter) deepFields(typeOf reflect.Type) []reflect.StructField {
	fields := make([]reflect.StructField, 0)

	if typeOf.Kind() == reflect.Pointer {
		typeOf = typeOf.Elem()
	}

	if typeOf.Kind() != reflect.Struct {
		return fields
	}

	for i := 0; i < typeOf.NumField(); i++ {
		f := typeOf.Field(i)
		kind := f.Type.Kind()
		isPointer := kind == reflect.Pointer && f.Type.Elem().Kind() == reflect.Struct
		switch {
		case f.Anonymous && kind == reflect.Struct:
			fields = append(fields, t.deepFields(f.Type)...)
		case f.Anonymous && isPointer:
			fields = append(fields, t.deepFields(f.Type.Elem())...)
		default:
			// Check we have a json tag
			jsonTag := t.getJSONFieldName(f, isPointer)
			if jsonTag != "" {
				fields = append(fields, f)
			}
		}
	}

	return fields
}

// convert returns the TypeScript of the added structs, each preceded by a newline.
func (t *converter) convert() (string, error) {
	t.alreadyConverted = make(map[string]bool)
	result := ""
	for _, typeOf := range t.structTypes {
		typeScriptCode, err := t.convertType(typeOf)
		if err != nil {
			return "", err
		}
		result += "\n" + strings.Trim(typeScriptCode, " \r\n")
	}
	return result, nil
}

func fieldOptions(field reflect.StructField) typeOptions {
	return typeOptions{TSTransform: field.Tag.Get(tsTransformTag), TSType: field.Tag.Get(tsTypeTag)}
}

func (t *converter) getJSONFieldName(field reflect.StructField, isPtr bool) string {
	jsonFieldName := ""
	// function, complex, and channel types cannot be json-encoded
	if field.Type.Kind() == reflect.Chan ||
		field.Type.Kind() == reflect.Func ||
		field.Type.Kind() == reflect.UnsafePointer ||
		field.Type.Kind() == reflect.Complex128 ||
		field.Type.Kind() == reflect.Complex64 {
		return ""
	}
	jsonTag, hasTag := field.Tag.Lookup("json")
	if !hasTag && field.IsExported() {
		jsonFieldName = field.Name
		if isPtr {
			jsonFieldName += "?"
		}
	}
	if len(jsonTag) > 0 {
		jsonTagParts := strings.Split(jsonTag, ",")
		if len(jsonTagParts) > 0 {
			jsonFieldName = strings.Trim(jsonTagParts[0], " ")
		}
		hasOmitEmpty := false
		ignored := false
		for _, part := range jsonTagParts {
			if part == "" {
				break
			}
			if part == "omitempty" {
				hasOmitEmpty = true
				break
			}
			if part == "-" {
				ignored = true
				break
			}
		}
		if !ignored && isPtr || hasOmitEmpty {
			jsonFieldName = fmt.Sprintf("%s?", jsonFieldName)
		}
	}
	return jsonFieldName
}

func (t *converter) convertType(typeOf reflect.Type) (string, error) {
	if _, found := t.alreadyConverted[typeOf.String()]; found { // Already converted
		return "", nil
	}
	fields := t.deepFields(typeOf)
	if differentNamespaces(t.namespace, typeOf) {
		return "", nil
	}

	t.alreadyConverted[typeOf.String()] = true

	entityName := nameTypeOf(typeOf)

	if typeClashWithReservedKeyword(entityName) {
		warnAboutTypesClash(entityName)
	}

	result := "export " + fmt.Sprintf("class %s {\n", entityName)
	builder := typeScriptClassBuilder{namespace: t.namespace}

	// prepend adds the class of a type a field refers to, ahead of the class being written.
	prepend := func(typeOf reflect.Type) error {
		typeScriptChunk, err := t.convertType(typeOf)
		if err != nil {
			return err
		}
		if typeScriptChunk != "" {
			result = typeScriptChunk + "\n" + result
		}
		return nil
	}

	for _, field := range fields {
		isPtr := field.Type.Kind() == reflect.Pointer
		if isPtr {
			field.Type = field.Type.Elem()
		}
		jsonFieldName := t.getJSONFieldName(field, isPtr)
		if len(jsonFieldName) == 0 || jsonFieldName == "-" {
			continue
		}

		var err error
		fldOpts := fieldOptions(field)
		switch {
		case fldOpts.TSTransform != "" || fldOpts.TSType != "":
			err = builder.AddSimpleField(jsonFieldName, field, fldOpts)
		case field.Type.Kind() == reflect.Struct:
			// Anonymous structures is ignored
			// It is possible to generate them but hard to generate correct name
			if field.Type.Name() != "" {
				if err := prepend(field.Type); err != nil {
					return "", err
				}
			}

			isKnownType := t.knownStructs[getStructFQN(field.Type.String())]
			builder.AddStructField(jsonFieldName, field, !isKnownType)
		case field.Type.Kind() == reflect.Map:
			// Also convert map key types if needed
			var keyTypeToConvert reflect.Type
			switch field.Type.Key().Kind() {
			case reflect.Struct:
				keyTypeToConvert = field.Type.Key()
			case reflect.Pointer:
				keyTypeToConvert = field.Type.Key().Elem()
			}
			if keyTypeToConvert != nil {
				if err := prepend(keyTypeToConvert); err != nil {
					return "", err
				}
			}
			// Also convert map value types if needed
			var valueTypeToConvert reflect.Type
			switch field.Type.Elem().Kind() {
			case reflect.Struct:
				valueTypeToConvert = field.Type.Elem()
			case reflect.Pointer:
				valueTypeToConvert = field.Type.Elem().Elem()
			}
			if valueTypeToConvert != nil {
				if err := prepend(valueTypeToConvert); err != nil {
					return "", err
				}
			}

			builder.AddMapField(jsonFieldName, field)
		case field.Type.Kind() == reflect.Slice || field.Type.Kind() == reflect.Array:
			if field.Type.Elem().Kind() == reflect.Pointer { // extract ptr type
				field.Type = field.Type.Elem()
			}

			arrayDepth := 1
			for field.Type.Elem().Kind() == reflect.Slice || field.Type.Elem().Kind() == reflect.Array { // Slice of slices:
				field.Type = field.Type.Elem()
				arrayDepth++
			}

			if field.Type.Elem().Kind() == reflect.Pointer { // extract ptr type
				field.Type = field.Type.Elem()
			}

			if field.Type.Elem().Kind() == reflect.Struct { // Slice of structs:
				if err := prepend(field.Type.Elem()); err != nil {
					return "", err
				}
				builder.AddArrayOfStructsField(jsonFieldName, field, arrayDepth)
			} else { // Slice of simple fields:
				err = builder.AddSimpleArrayField(jsonFieldName, field, arrayDepth, fldOpts)
			}
		default:
			err = builder.AddSimpleField(jsonFieldName, field, fldOpts)
		}
		if err != nil {
			return "", err
		}
	}

	result += strings.Join(builder.fields, "\n") + "\n"
	constructorBody := strings.Join(builder.constructorBody, "\n")
	needsConvertValue := strings.Contains(constructorBody, "this.convertValues")
	result += fmt.Sprintf("\n%sstatic createFrom(source: any = {}) {\n", tsIndent)
	result += fmt.Sprintf("%s%sreturn new %s(source);\n", tsIndent, tsIndent, entityName)
	result += fmt.Sprintf("%s}\n", tsIndent)
	result += fmt.Sprintf("\n%sconstructor(source: any = {}) {\n", tsIndent)
	result += tsIndent + tsIndent + "if ('string' === typeof source) source = JSON.parse(source);\n"
	result += constructorBody + "\n"
	result += fmt.Sprintf("%s}\n", tsIndent)
	if needsConvertValue {
		result += "\n" + indentLines(strings.ReplaceAll(tsConvertValuesFunc, "\t", tsIndent), 1) + "\n"
	}

	result += "}"

	return result, nil
}

type typeScriptClassBuilder struct {
	fields          []string
	constructorBody []string
	namespace       string
}

func (t *typeScriptClassBuilder) AddMapField(fieldName string, field reflect.StructField) {
	keyType := field.Type.Key()
	valueType := field.Type.Elem()
	valueTypeName := nameTypeOf(valueType)
	valueTypeSuffix := ""
	valueTypePrefix := ""
	if valueType.Kind() == reflect.Pointer {
		valueType = valueType.Elem()
		valueTypeName = nameTypeOf(valueType)
	}
	if valueType.Kind() == reflect.Array || valueType.Kind() == reflect.Slice {
		arrayDepth := 1
		for valueType.Elem().Kind() == reflect.Array || valueType.Elem().Kind() == reflect.Slice {
			valueType = valueType.Elem()
			arrayDepth++
		}
		valueType = valueType.Elem()
		valueTypeName = nameTypeOf(valueType)
		valueTypeSuffix = strings.Repeat(">", arrayDepth)
		valueTypePrefix = strings.Repeat("Array<", arrayDepth)
	}
	if valueType.Kind() == reflect.Pointer {
		valueType = valueType.Elem()
		valueTypeName = nameTypeOf(valueType)
	}
	if name, ok := tsKinds[valueType.Kind()]; ok {
		valueTypeName = name
	}
	if valueType.Kind() == reflect.Map {
		// TODO: support nested maps
		valueTypeName = "any" // valueType.Elem().Name()
	}
	if valueType.Kind() == reflect.Struct && differentNamespaces(t.namespace, valueType) {
		valueTypeName = valueType.String()
	}
	strippedFieldName := strings.ReplaceAll(fieldName, "?", "")
	isOptional := strings.HasSuffix(fieldName, "?")

	keyTypeStr := ""
	// Key should always be a JS primitive. JS will read it as a string either way.
	if typeStr, isSimple := tsKinds[keyType.Kind()]; isSimple {
		keyTypeStr = typeStr
	} else {
		keyTypeStr = tsKinds[reflect.String]
	}

	var dotField string
	if jsVariableName.MatchString(strippedFieldName) {
		dotField = fmt.Sprintf(".%s", strippedFieldName)
	} else {
		dotField = fmt.Sprintf(`["%s"]`, strippedFieldName)
		if isOptional {
			fieldName = fmt.Sprintf(`"%s"?`, strippedFieldName)
		}
	}
	t.fields = append(t.fields, fmt.Sprintf("%s%s: Record<%s, %s>;", tsIndent, fieldName, keyTypeStr, valueTypePrefix+valueTypeName+valueTypeSuffix))
	if valueType.Kind() == reflect.Struct {
		t.constructorBody = append(t.constructorBody, fmt.Sprintf("%s%sthis%s = this.convertValues(source[\"%s\"], %s, true);",
			tsIndent, tsIndent, dotField, strippedFieldName, valueTypePrefix+valueTypeName+valueTypeSuffix))
	} else {
		t.constructorBody = append(t.constructorBody, fmt.Sprintf("%s%sthis%s = source[\"%s\"];",
			tsIndent, tsIndent, dotField, strippedFieldName))
	}
}

func (t *typeScriptClassBuilder) AddSimpleArrayField(fieldName string, field reflect.StructField, arrayDepth int, opts typeOptions) error {
	fieldType := nameTypeOf(field.Type.Elem())
	kind := field.Type.Elem().Kind()
	typeScriptType, ok := tsKinds[kind]
	if !ok {
		typeScriptType = "any"
	}

	if len(fieldName) > 0 {
		strippedFieldName := strings.ReplaceAll(fieldName, "?", "")
		if len(opts.TSType) > 0 {
			t.addField(fieldName, opts.TSType, false)
			t.addInitializerFieldLine(strippedFieldName, fmt.Sprintf("source[\"%s\"]", strippedFieldName))
			return nil
		} else if len(typeScriptType) > 0 {
			t.addField(fieldName, fmt.Sprint(typeScriptType, strings.Repeat("[]", arrayDepth)), false)
			t.addInitializerFieldLine(strippedFieldName, fmt.Sprintf("source[\"%s\"]", strippedFieldName))
			return nil
		}
	}

	return fmt.Errorf("cannot find type for %s (%s/%s)", kind.String(), fieldName, fieldType)
}

func (t *typeScriptClassBuilder) AddSimpleField(fieldName string, field reflect.StructField, opts typeOptions) error {
	fieldType := nameTypeOf(field.Type)
	kind := field.Type.Kind()

	typeScriptType, ok := tsKinds[kind]
	if !ok {
		typeScriptType = "any"
	}

	if len(opts.TSType) > 0 {
		typeScriptType = opts.TSType
	}

	if len(typeScriptType) > 0 && len(fieldName) > 0 {
		strippedFieldName := strings.ReplaceAll(fieldName, "?", "")
		t.addField(fieldName, typeScriptType, false)
		if opts.TSTransform == "" {
			t.addInitializerFieldLine(strippedFieldName, fmt.Sprintf("source[\"%s\"]", strippedFieldName))
		} else {
			val := fmt.Sprintf(`source["%s"]`, strippedFieldName)
			expression := strings.ReplaceAll(opts.TSTransform, "__VALUE__", val)
			t.addInitializerFieldLine(strippedFieldName, expression)
		}
		return nil
	}

	return fmt.Errorf("cannot find type for %s (%s/%s)", kind.String(), fieldName, fieldType)
}

func (t *typeScriptClassBuilder) AddStructField(fieldName string, field reflect.StructField, isAnyType bool) {
	strippedFieldName := strings.ReplaceAll(fieldName, "?", "")
	classname := "null"
	namespace := strings.Split(field.Type.String(), ".")[0]
	fqname := nameTypeOf(field.Type)
	if namespace != t.namespace {
		fqname = namespace + "." + fqname
	}

	if !isAnyType {
		classname = fqname
	}

	// Anonymous struct
	if field.Type.Name() == "" {
		classname = "Object"
	}

	t.addField(fieldName, fqname, isAnyType)
	t.addInitializerFieldLine(strippedFieldName, fmt.Sprintf("this.convertValues(source[\"%s\"], %s)", strippedFieldName, classname))
}

func (t *typeScriptClassBuilder) AddArrayOfStructsField(fieldName string, field reflect.StructField, arrayDepth int) {
	fieldType := nameTypeOf(field.Type.Elem())
	if differentNamespaces(t.namespace, field.Type.Elem()) {
		fieldType = field.Type.Elem().String()
	}
	strippedFieldName := strings.ReplaceAll(fieldName, "?", "")
	t.addField(fieldName, fmt.Sprint(fieldType, strings.Repeat("[]", arrayDepth)), false)
	t.addInitializerFieldLine(strippedFieldName, fmt.Sprintf("this.convertValues(source[\"%s\"], %s)", strippedFieldName, fieldType))
}

func (t *typeScriptClassBuilder) addInitializerFieldLine(fld, initializer string) {
	var dotField string
	if jsVariableName.MatchString(fld) {
		dotField = fmt.Sprintf(".%s", fld)
	} else {
		dotField = fmt.Sprintf(`["%s"]`, fld)
	}
	t.constructorBody = append(t.constructorBody, fmt.Sprint(tsIndent, tsIndent, "this", dotField, " = ", initializer, ";"))
}

func (t *typeScriptClassBuilder) addField(fld, fldType string, isAnyType bool) {
	isOptional := strings.HasSuffix(fld, "?")
	strippedFieldName := strings.ReplaceAll(fld, "?", "")
	if !jsVariableName.MatchString(strippedFieldName) {
		fld = fmt.Sprintf(`"%s"`, strippedFieldName)
		if isOptional {
			fld += "?"
		}
	}
	if isAnyType {
		fldType = strings.Split(fldType, ".")[0]
		t.fields = append(t.fields, fmt.Sprint(tsIndent, "// Go type: ", fldType, "\n", tsIndent, fld, ": any;"))
	} else {
		t.fields = append(t.fields, fmt.Sprint(tsIndent, fld, ": ", fldType, ";"))
	}
}

func indentLines(str string, i int) string {
	lines := strings.Split(str, "\n")
	for n := range lines {
		lines[n] = strings.Repeat("\t", i) + lines[n]
	}
	return strings.Join(lines, "\n")
}

func getStructFQN(in string) string {
	result := strings.ReplaceAll(in, "[]", "")
	result = strings.ReplaceAll(result, "*", "")
	return result
}

func differentNamespaces(namespace string, typeOf reflect.Type) bool {
	if strings.ContainsRune(typeOf.String(), '.') {
		typeNamespace := strings.Split(typeOf.String(), ".")[0]
		if namespace != typeNamespace {
			return true
		}
	}
	return false
}

func typeClashWithReservedKeyword(input string) bool {
	in := strings.ToLower(strings.TrimSpace(input))
	for _, v := range jsReservedKeywords {
		if in == v {
			return true
		}
	}

	return false
}

func warnAboutTypesClash(entity string) {
	l := log.New(os.Stderr, "", 0)
	l.Printf("Usage of reserved keyword found and not supported: %s", entity)
}

var jsReservedKeywords = []string{
	"abstract", "arguments", "await", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
	"continue", "debugger", "default", "delete", "do", "double", "else", "enum", "eval", "export", "extends",
	"false", "final", "finally", "float", "for", "function", "goto", "if", "implements", "import", "in",
	"instanceof", "int", "interface", "let", "long", "native", "new", "null", "package", "private",
	"protected", "public", "return", "short", "static", "super", "switch", "synchronized", "this", "throw",
	"throws", "transient", "true", "try", "typeof", "var", "void", "volatile", "while", "with", "yield",
	"object",
}
