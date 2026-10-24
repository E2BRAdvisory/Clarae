package configprofiles

import (
	"bytes"
	"context"
	_ "embed" // the JSON Schema is part of the binary
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/santhosh-tekuri/jsonschema/v6"

	"nodus/services/cloud/internal/audit"
	"nodus/services/cloud/internal/db"
	"nodus/services/cloud/internal/db/dbgen"
	"nodus/services/cloud/internal/httpproblem"
	"nodus/services/cloud/internal/notify"
	"nodus/shared/syncproto"
)

// schemaJSON is a copy of api/config-profile.schema.json (a test keeps them identical):
// the module cannot embed a file outside its own tree.
//
//go:embed schema.json
var schemaJSON []byte

var (
	schemaOnce sync.Once
	schema     *jsonschema.Schema
	schemaErr  error
)

func compiledSchema() (*jsonschema.Schema, error) {
	schemaOnce.Do(func() {
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(schemaJSON))
		if err != nil {
			schemaErr = err
			return
		}
		c := jsonschema.NewCompiler()
		if err := c.AddResource("config-profile.schema.json", doc); err != nil {
			schemaErr = err
			return
		}
		schema, schemaErr = c.Compile("config-profile.schema.json")
	})
	return schema, schemaErr
}

// Validate checks a profile document against the JSON Schema.
func Validate(config []byte) error {
	sc, err := compiledSchema()
	if err != nil {
		return err
	}
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(config))
	if err != nil {
		return httpproblem.Errorf(syncproto.CodeValidationFailed, "config is not valid JSON: %v", err)
	}
	if err := sc.Validate(inst); err != nil {
		return httpproblem.Errorf(syncproto.CodeValidationFailed, "config does not match the schema: %v", err)
	}
	return nil
}

// topLevelKeys are the properties of the schema, used to check locked keys.
func topLevelKeys() ([]string, error) {
	var s struct {
		Properties map[string]json.RawMessage `json:"properties"`
	}
	if err := json.Unmarshal(schemaJSON, &s); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(s.Properties))
	for k := range s.Properties {
		keys = append(keys, k)
	}
	return keys, nil
}

// Merge overlays b on a: objects merge key by key, anything else is replaced. Neither input is modified.
func Merge(a, b map[string]any) map[string]any {
	out := make(map[string]any, len(a)+len(b))
	for k, v := range a {
		out[k] = clone(v)
	}
	for k, v := range b {
		if bm, ok := v.(map[string]any); ok {
			if am, ok := out[k].(map[string]any); ok {
				out[k] = Merge(am, bm)
				continue
			}
		}
		out[k] = clone(v)
	}
	return out
}

func clone(v any) any {
	switch t := v.(type) {
	case map[string]any:
		return Merge(nil, t)
	case []any:
		out := make([]any, len(t))
		for i := range t {
			out[i] = clone(t[i])
		}
		return out
	}
	return v
}

// Effective is the configuration a user receives.
type Effective struct {
	Version    int64
	Config     map[string]any
	LockedKeys []string
}

// Service implements the configuration module.
type Service struct{ db *db.DB }

// NewService wires the module.
func NewService(d *db.DB) *Service { return &Service{db: d} }

func decode(raw []byte) (map[string]any, error) {
	m := map[string]any{}
	if len(raw) == 0 {
		return m, nil
	}
	return m, json.Unmarshal(raw, &m)
}

// EffectiveFor resolves, in order: product defaults, the global profile, the profiles of
// the user's groups by increasing priority (§2.6.6). The user's own overrides are applied by
// the client, which ignores them for the locked keys returned here.
func (s *Service) EffectiveFor(ctx context.Context, userID uuid.UUID) (Effective, error) {
	q := s.db.Queries()
	rev, err := q.GetConfigRevision(ctx)
	if err != nil {
		return Effective{}, err
	}
	cfg := ProductDefaults()
	var locked []string
	if g, err := q.GetGlobalConfigProfile(ctx); err == nil {
		over, derr := decode(g.Config)
		if derr != nil {
			return Effective{}, derr
		}
		cfg = Merge(cfg, over)
		locked = append(locked, g.LockedKeys...)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return Effective{}, err
	}
	profiles, err := q.ListUserConfigProfiles(ctx, userID)
	if err != nil {
		return Effective{}, err
	}
	for _, p := range profiles {
		over, derr := decode(p.Config)
		if derr != nil {
			return Effective{}, derr
		}
		cfg = Merge(cfg, over)
		locked = append(locked, p.LockedKeys...)
	}
	slices.Sort(locked)
	locked = slices.Compact(locked)
	if locked == nil {
		locked = []string{}
	}
	return Effective{Version: rev, Config: cfg, LockedKeys: locked}, nil
}

// Changed records that something affecting configuration changed: it bumps the revision
// clients see and announces it when the surrounding transaction commits.
func (s *Service) Changed(ctx context.Context, tx pgx.Tx) error {
	rev, err := dbgen.New(tx).BumpConfigRevision(ctx)
	if err != nil {
		return err
	}
	return notify.PublishConfig(ctx, tx, rev)
}

// ProfileInput is a profile to create or replace.
type ProfileInput struct {
	Name        string
	Description string
	IsGlobal    bool
	Config      json.RawMessage
	LockedKeys  []string
}

func validateInput(in ProfileInput) (string, []string, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" || len([]rune(name)) > 100 {
		return "", nil, httpproblem.Errorf(syncproto.CodeValidationFailed, "a profile name has 1..100 characters")
	}
	if len(in.Config) == 0 {
		in.Config = json.RawMessage(`{}`)
	}
	if err := Validate(in.Config); err != nil {
		return "", nil, err
	}
	known, err := topLevelKeys()
	if err != nil {
		return "", nil, err
	}
	locked := make([]string, 0, len(in.LockedKeys))
	for _, k := range in.LockedKeys {
		top, _, _ := strings.Cut(k, ".")
		if !slices.Contains(known, top) {
			return "", nil, httpproblem.Errorf(syncproto.CodeValidationFailed, "locked key %q is not a configuration key", k)
		}
		locked = append(locked, k)
	}
	return name, locked, nil
}

func unique(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}

// Create adds a profile; making it global replaces the previous global one.
func (s *Service) Create(ctx context.Context, actor uuid.UUID, in ProfileInput) (dbgen.ConfigProfile, error) {
	name, locked, err := validateInput(in)
	if err != nil {
		return dbgen.ConfigProfile{}, err
	}
	cfg := in.Config
	if len(cfg) == 0 {
		cfg = json.RawMessage(`{}`)
	}
	var p dbgen.ConfigProfile
	err = s.db.WithTx(ctx, func(ctx context.Context, q *dbgen.Queries, tx pgx.Tx) error {
		if in.IsGlobal {
			if err := s.demoteGlobal(ctx, q, uuid.Nil, actor); err != nil {
				return err
			}
		}
		var err error
		p, err = q.CreateConfigProfile(ctx, dbgen.CreateConfigProfileParams{
			ID: uuid.Must(uuid.NewV7()), Name: name, Description: nilIfEmpty(in.Description), IsGlobal: in.IsGlobal,
			Config: cfg, LockedKeys: locked, UpdatedBy: &actor,
		})
		if err != nil {
			return err
		}
		if err := audit.Record(ctx, q, actor, "config.profile.create", "config_profile", p.ID.String(), map[string]any{"name": name, "global": in.IsGlobal}); err != nil {
			return err
		}
		return s.Changed(ctx, tx)
	})
	if unique(err) {
		return dbgen.ConfigProfile{}, httpproblem.Errorf(syncproto.CodeNameInUse, "a profile named %q exists", name)
	}
	return p, err
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// demoteGlobal clears the global flag of the current global profile (not keep).
func (s *Service) demoteGlobal(ctx context.Context, q *dbgen.Queries, keep, actor uuid.UUID) error {
	cur, err := q.GetGlobalConfigProfile(ctx)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && cur.ID == keep) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = q.UpdateConfigProfile(ctx, dbgen.UpdateConfigProfileParams{
		ID: cur.ID, Name: cur.Name, Description: cur.Description, IsGlobal: false, Config: cur.Config, LockedKeys: cur.LockedKeys, UpdatedBy: &actor,
	})
	return err
}

// Update replaces a profile and increments its version.
func (s *Service) Update(ctx context.Context, actor, id uuid.UUID, in ProfileInput) (dbgen.ConfigProfile, error) {
	name, locked, err := validateInput(in)
	if err != nil {
		return dbgen.ConfigProfile{}, err
	}
	cfg := in.Config
	if len(cfg) == 0 {
		cfg = json.RawMessage(`{}`)
	}
	var p dbgen.ConfigProfile
	err = s.db.WithTx(ctx, func(ctx context.Context, q *dbgen.Queries, tx pgx.Tx) error {
		if _, err := q.GetConfigProfile(ctx, id); errors.Is(err, pgx.ErrNoRows) {
			return httpproblem.NotFound("profile")
		} else if err != nil {
			return err
		}
		if in.IsGlobal {
			if err := s.demoteGlobal(ctx, q, id, actor); err != nil {
				return err
			}
		}
		var err error
		p, err = q.UpdateConfigProfile(ctx, dbgen.UpdateConfigProfileParams{
			ID: id, Name: name, Description: nilIfEmpty(in.Description), IsGlobal: in.IsGlobal, Config: cfg, LockedKeys: locked, UpdatedBy: &actor,
		})
		if err != nil {
			return err
		}
		if err := audit.Record(ctx, q, actor, "config.profile.update", "config_profile", id.String(), map[string]any{"version": p.Version}); err != nil {
			return err
		}
		return s.Changed(ctx, tx)
	})
	if unique(err) {
		return dbgen.ConfigProfile{}, httpproblem.Errorf(syncproto.CodeNameInUse, "a profile named %q exists", name)
	}
	return p, err
}

// Delete removes a profile and its assignments.
func (s *Service) Delete(ctx context.Context, actor, id uuid.UUID) error {
	return s.db.WithTx(ctx, func(ctx context.Context, q *dbgen.Queries, tx pgx.Tx) error {
		n, err := q.DeleteConfigProfile(ctx, id)
		if err != nil {
			return err
		}
		if n == 0 {
			return httpproblem.NotFound("profile")
		}
		if err := audit.Record(ctx, q, actor, "config.profile.delete", "config_profile", id.String(), nil); err != nil {
			return err
		}
		return s.Changed(ctx, tx)
	})
}

// Get returns a profile.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (dbgen.ConfigProfile, error) {
	p, err := s.db.Queries().GetConfigProfile(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return dbgen.ConfigProfile{}, httpproblem.NotFound("profile")
	}
	return p, err
}

// List returns every profile, the global one first.
func (s *Service) List(ctx context.Context) ([]dbgen.ConfigProfile, error) {
	return s.db.Queries().ListConfigProfiles(ctx)
}

// Assignment ties a profile to a group with a priority (higher wins).
type Assignment struct {
	ProfileID uuid.UUID
	Priority  int32
}

// SetGroupAssignments replaces the profiles assigned to a group.
func (s *Service) SetGroupAssignments(ctx context.Context, actor, groupID uuid.UUID, as []Assignment) error {
	return s.db.WithTx(ctx, func(ctx context.Context, q *dbgen.Queries, tx pgx.Tx) error {
		if _, err := q.GetGroup(ctx, groupID); errors.Is(err, pgx.ErrNoRows) {
			return httpproblem.NotFound("group")
		} else if err != nil {
			return err
		}
		if err := q.ClearGroupAssignments(ctx, groupID); err != nil {
			return err
		}
		for _, a := range as {
			if _, err := q.GetConfigProfile(ctx, a.ProfileID); errors.Is(err, pgx.ErrNoRows) {
				return httpproblem.NotFound("profile")
			} else if err != nil {
				return err
			}
			if err := q.AssignProfile(ctx, dbgen.AssignProfileParams{ProfileID: a.ProfileID, GroupID: groupID, Priority: a.Priority}); err != nil {
				return err
			}
		}
		if err := audit.Record(ctx, q, actor, "config.assignments.set", "group", groupID.String(), as); err != nil {
			return err
		}
		return s.Changed(ctx, tx)
	})
}
