// Package dataset generates deterministic synthetic Markdown vaults for the
// performance suite (M7-WP1). A vault is never committed: Ensure writes it
// into a cache directory and reuses it while the generation parameters match.
//
// The shape mimics a real knowledge base: log-normal note sizes (median about
// 1.8 KB, a thin tail of very large notes), a Zipf vocabulary, headings,
// frontmatter properties, tags with a skewed popularity, wikilinks whose
// in-degree follows a power law (a few hubs, a long tail), a few unresolved
// links (ghosts) and references to attachments.
package dataset

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
)

// Version is bumped whenever the generator output changes, invalidating caches.
const Version = 1

// Config selects the vault to generate.
type Config struct {
	Notes int    // number of Markdown notes
	Seed  uint64 // same seed and Notes always give identical files
}

// Manifest describes a generated vault (written as .perfdata.json).
type Manifest struct {
	Version     int    `json:"version"`
	Notes       int    `json:"notes"`
	Seed        uint64 `json:"seed"`
	Bytes       int64  `json:"bytes"`
	Links       int    `json:"links"`
	Attachments int    `json:"attachments"`
}

const manifestName = ".perfdata.json"

// Ensure generates the vault in dir unless a manifest with the same
// parameters is already there. It returns the manifest.
func Ensure(dir string, cfg Config) (Manifest, error) {
	if cfg.Notes <= 0 {
		return Manifest{}, fmt.Errorf("dataset: Notes must be positive")
	}
	if raw, err := os.ReadFile(filepath.Join(dir, manifestName)); err == nil {
		var m Manifest
		if json.Unmarshal(raw, &m) == nil && m.Version == Version && m.Notes == cfg.Notes && m.Seed == cfg.Seed {
			return m, nil
		}
	}
	if err := os.RemoveAll(dir); err != nil {
		return Manifest{}, err
	}
	m, err := Generate(dir, cfg)
	if err != nil {
		return Manifest{}, err
	}
	raw, _ := json.Marshal(m)
	return m, os.WriteFile(filepath.Join(dir, manifestName), raw, 0o600)
}

// Generate writes the vault into dir (created if missing) and returns its manifest.
func Generate(dir string, cfg Config) (Manifest, error) {
	g := newGen(cfg)
	m := Manifest{Version: Version, Notes: cfg.Notes, Seed: cfg.Seed}
	for i := 0; i < cfg.Notes; i++ {
		body, links := g.note(i)
		abs := filepath.Join(dir, filepath.FromSlash(g.paths[i]))
		if err := os.MkdirAll(filepath.Dir(abs), 0o750); err != nil {
			return m, err
		}
		if err := os.WriteFile(abs, body, 0o600); err != nil {
			return m, err
		}
		m.Bytes += int64(len(body))
		m.Links += links
	}
	// A small share of the referenced attachments really exists.
	for a := 0; a < g.attachments; a += 20 {
		abs := filepath.Join(dir, "attachments", fmt.Sprintf("img-%d.png", a))
		if err := os.MkdirAll(filepath.Dir(abs), 0o750); err != nil {
			return m, err
		}
		if err := os.WriteFile(abs, []byte("\x89PNG\r\n\x1a\nsynthetic"), 0o600); err != nil {
			return m, err
		}
		m.Attachments++
	}
	return m, nil
}

type gen struct {
	cfg         Config
	vocab       []string
	titles      []string
	paths       []string
	tags        []string
	attachments int
	wordZipf    *rand.Zipf
	rng         *rand.Rand
}

func newGen(cfg Config) *gen {
	rng := rand.New(rand.NewPCG(cfg.Seed, 0x6e6f647573)) //nolint:gosec // deterministic test data
	g := &gen{cfg: cfg, rng: rng, attachments: max(100, cfg.Notes/10)}
	// Vocabulary: pronounceable pseudo words so that trigram search behaves like on prose.
	cons, vows := "bcdfghklmnprstvz", "aeiou"
	g.vocab = make([]string, 8000)
	for i := range g.vocab {
		n := 2 + rng.IntN(3)
		var sb strings.Builder
		for s := 0; s < n; s++ {
			sb.WriteByte(cons[rng.IntN(len(cons))])
			sb.WriteByte(vows[rng.IntN(len(vows))])
		}
		if rng.IntN(3) == 0 {
			sb.WriteByte(cons[rng.IntN(len(cons))])
		}
		g.vocab[i] = sb.String()
	}
	// A few frequent words with meaning so that queries have hits at every scale.
	copy(g.vocab, strings.Fields("project budget review meeting notes plan risk task idea journal client invoice roadmap decision summary"))
	g.tags = make([]string, 300)
	for i := range g.tags {
		g.tags[i] = g.vocab[200+i]
	}
	g.titles = make([]string, cfg.Notes)
	g.paths = make([]string, cfg.Notes)
	folders := max(5, int(math.Sqrt(float64(cfg.Notes))/4))
	for i := range g.titles {
		// The running index keeps every title (and so every file name) unique.
		g.titles[i] = fmt.Sprintf("%s %s %d", g.vocab[rng.IntN(1500)], g.vocab[rng.IntN(1500)], i)
		g.paths[i] = fmt.Sprintf("area-%02d/sub-%02d/%s.md", i%folders, (i/folders)%12, g.titles[i])
	}
	return g
}

func (g *gen) word() string { return g.vocab[g.wordZipf.Uint64()] }

// size draws the note size in bytes: log-normal, clamped, with a thin heavy tail.
func (g *gen) size() int {
	s := math.Exp(math.Log(1800) + 1.0*g.rng.NormFloat64())
	if g.rng.IntN(2000) == 0 {
		s = 150_000 + g.rng.Float64()*350_000
	}
	return int(math.Min(math.Max(s, 120), 600_000))
}

// linkTarget picks a note with a power-law in-degree: low indices are hubs.
func (g *gen) linkTarget() int {
	return int(float64(g.cfg.Notes)*math.Pow(g.rng.Float64(), 3.0)) % g.cfg.Notes
}

// note renders note i. Each note reseeds the generator, so the output does
// not depend on the order of generation.
func (g *gen) note(i int) ([]byte, int) {
	g.rng = rand.New(rand.NewPCG(g.cfg.Seed^(uint64(i)*0x9e3779b97f4a7c15), uint64(i)+1)) //nolint:gosec // deterministic test data
	g.wordZipf = rand.NewZipf(g.rng, 1.15, 4, uint64(len(g.vocab)-1))                     //nolint:gosec // vocabulary size is a small positive constant
	var sb strings.Builder
	target := g.size()
	sb.WriteString("---\n")
	fmt.Fprintf(&sb, "status: %s\n", []string{"active", "done", "draft", "archived"}[g.rng.IntN(4)])
	fmt.Fprintf(&sb, "amount: %d\n", g.rng.IntN(5000))
	fmt.Fprintf(&sb, "created: 20%02d-%02d-%02d\n", 15+g.rng.IntN(11), 1+g.rng.IntN(12), 1+g.rng.IntN(28))
	if g.rng.IntN(5) == 0 {
		fmt.Fprintf(&sb, "aliases: [%s alias %d]\n", g.vocab[g.rng.IntN(3000)], i)
	}
	if nt := g.rng.IntN(4); nt > 0 {
		sb.WriteString("tags: [")
		for t := 0; t < nt; t++ {
			if t > 0 {
				sb.WriteString(", ")
			}
			sb.WriteString(g.tags[int(math.Pow(g.rng.Float64(), 2.5)*float64(len(g.tags)))])
		}
		sb.WriteString("]\n")
	}
	sb.WriteString("---\n")
	fmt.Fprintf(&sb, "# %s\n\n", g.titles[i])
	links, section := 0, 0
	for sb.Len() < target {
		if section%6 == 0 {
			fmt.Fprintf(&sb, "\n## %s %s\n\n", g.word(), g.word())
		}
		section++
		words := 25 + g.rng.IntN(60)
		for w := 0; w < words; w++ {
			sb.WriteString(g.word())
			switch r := g.rng.IntN(100); {
			case r < 2 && links < 15:
				fmt.Fprintf(&sb, " [[%s]]", g.titles[g.linkTarget()])
				links++
			case r == 2 && g.rng.IntN(2) == 0:
				fmt.Fprintf(&sb, " [[ghost %s]]", g.vocab[g.rng.IntN(400)])
				links++
			case r == 3:
				fmt.Fprintf(&sb, " #%s", g.tags[g.rng.IntN(len(g.tags))])
			case r == 4 && g.rng.IntN(4) == 0:
				fmt.Fprintf(&sb, " ![[img-%d.png]]", g.rng.IntN(g.attachments))
			}
			sb.WriteByte(' ')
		}
		sb.WriteString("\n\n")
		if g.rng.IntN(12) == 0 {
			fmt.Fprintf(&sb, "- [ ] %s %s\n- [x] %s\n\n", g.word(), g.word(), g.word())
		}
	}
	// Every note links somewhere so that the graph has no mass of orphans.
	for ; links < 2; links++ {
		fmt.Fprintf(&sb, "See [[%s]].\n", g.titles[g.linkTarget()])
	}
	return []byte(sb.String()), links
}
