// Package other is a second Go package of the bindings fixture: its structs land in their own namespace
// of models.ts and the services of fixture name them as other.X.
package other

// Tag is a struct of another package.
type Tag struct {
	Name  string `json:"name"`
	Score int    `json:"score,omitempty"`
}

// Labels is a struct that only a map of another package refers to.
type Labels struct {
	Items []string `json:"items"`
}
