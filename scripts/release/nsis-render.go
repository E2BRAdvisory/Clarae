//go:build ignore

// nsis-render renders apps/desktop/build/windows/installer/wails_tools.nsh the way `wails build -nsis` does
// (a Go text/template filled from wails.json), so makensis can be run by hand. The release script needs that
// to sign memobrain.exe BEFORE it is packed into the installer, which `wails build -nsis` does not allow.
//
//	go run scripts/release/nsis-render.go <wails.json> <wails_tools.nsh>   (the .nsh is rewritten in place)
package main

import (
	"encoding/json"
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
	CompanyName      string        `json:"companyName"`
	ProductName      string        `json:"productName"`
	ProductVersion   string        `json:"productVersion"`
	Copyright        string        `json:"copyright"`
	FileAssociations []association `json:"fileAssociations"`
	Protocols        []protocol    `json:"protocols"`
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: nsis-render <wails.json> <wails_tools.nsh>")
		os.Exit(2)
	}
	raw, err := os.ReadFile(os.Args[1])
	check(err)
	var data struct {
		Name string `json:"name"`
		Info info   `json:"info"`
	}
	check(json.Unmarshal(raw, &data))
	if data.Info.ProductVersion == "" {
		check(fmt.Errorf("%s has no info.productVersion", os.Args[1]))
	}
	tpl, err := os.ReadFile(os.Args[2])
	check(err)
	t, err := template.New("nsh").Parse(string(tpl))
	check(err)
	out, err := os.Create(os.Args[2])
	check(err)
	check(t.Execute(out, data))
	check(out.Close())
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "nsis-render:", err)
		os.Exit(1)
	}
}
