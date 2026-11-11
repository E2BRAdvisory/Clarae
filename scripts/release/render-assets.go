//go:build ignore

// render-assets renders the text/template files of apps/desktop/build (macOS Info.plist, Windows info.json,
// the NSIS wails_tools.nsh) from apps/desktop/build/project.json, the way `wails build` did before the
// move to Wails v3 (ADR-0051): the templates keep their {{.Name}}, {{.OutputFilename}} and {{.Info.*}} fields,
// so the bundle and the installers do not change.
//
//	go run scripts/release/render-assets.go -project <project.json> [-version 1.2.3] -out <file> <template>
//	go run scripts/release/render-assets.go -project <project.json> -field name|outputfilename|productname
//
// <file> may be the template itself (it is read before it is written). -version sets info.productVersion
// (MAJOR.MINOR.PATCH): project.json does not carry it, the build stamps it.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"text/template"
)

type protocol struct {
	Scheme      string `json:"scheme"`
	Description string `json:"description"`
	Role        string `json:"role"`
}

type association struct {
	Ext         string `json:"ext"`
	Name        string `json:"name"`
	Description string `json:"description"`
	IconName    string `json:"iconName"`
	Role        string `json:"role"`
}

type info struct {
	CompanyName       string        `json:"companyName"`
	ProductName       string        `json:"productName"`
	ProductIdentifier string        `json:"productIdentifier"`
	ProductVersion    string        `json:"productVersion"`
	Copyright         string        `json:"copyright"`
	Comments          string        `json:"comments"`
	FileAssociations  []association `json:"fileAssociations"`
	Protocols         []protocol    `json:"protocols"`
}

type project struct {
	Name           string `json:"name"`
	OutputFilename string `json:"outputfilename"`
	Info           info   `json:"info"`
	Author         struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	} `json:"author"`
}

func main() {
	projectPath := flag.String("project", "", "project.json")
	version := flag.String("version", "", "info.productVersion to stamp (MAJOR.MINOR.PATCH)")
	out := flag.String("out", "", "output file")
	field := flag.String("field", "", "print one field instead of rendering: name, outputfilename or productname")
	flag.Parse()
	if *projectPath == "" || (*field == "" && (*out == "" || flag.NArg() != 1)) {
		fmt.Fprintln(os.Stderr, "usage: render-assets -project <project.json> [-version V] -out <file> <template> | -field <name>")
		os.Exit(2)
	}

	raw, err := os.ReadFile(*projectPath)
	check(err)
	var data project
	check(json.Unmarshal(raw, &data))
	if *version != "" {
		data.Info.ProductVersion = *version
	}

	if *field != "" {
		switch *field {
		case "name":
			fmt.Println(data.Name)
		case "outputfilename":
			fmt.Println(data.OutputFilename)
		case "productname":
			fmt.Println(data.Info.ProductName)
		default:
			check(fmt.Errorf("unknown field %q", *field))
		}
		return
	}

	if data.Info.ProductVersion == "" {
		check(fmt.Errorf("no product version: pass -version (%s has no info.productVersion)", *projectPath))
	}
	tpl, err := os.ReadFile(flag.Arg(0))
	check(err)
	t, err := template.New("asset").Option("missingkey=error").Parse(string(tpl))
	check(err)
	// Rendered in memory first: with -out equal to the template, a failure must not leave it truncated.
	var buf bytes.Buffer
	check(t.Execute(&buf, data))
	check(os.WriteFile(*out, buf.Bytes(), 0o644))
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "render-assets:", err)
		os.Exit(1)
	}
}
