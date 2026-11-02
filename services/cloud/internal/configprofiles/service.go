package configprofiles

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/santhosh-tekuri/jsonschema/v6"

	"memobrain/services/cloud/internal/audit"
	"memobrain/services/cloud/internal/configprofiles/configprofilesdb"
	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/groups"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/notify"
	"memobrain/services/cloud/internal/settings"
	"memobrain/shared/features"
	"memobrain/shared/syncproto"
)

// schemaJSON is api/config-profile.schema.json, embedded by package features (its copy is
// written by `task gen` and checked by the features tests).
var schemaJSON = features.SchemaJSON

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
	q := configprofilesdb.New(s.db.Pool)
	rev, err := settings.ConfigRevision(ctx, s.db.Pool)
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
	rev, err := settings.BumpConfigRevision(ctx, tx)
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
	// ExpectedVersion, when set, makes Update apply only to that version of the profile
	// (optimistic concurrency between administrators); Create ignores it.
	ExpectedVersion *int32
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
func (s *Service) Create(ctx context.Context, actor uuid.UUID, in ProfileInput) (configprofilesdb.ConfigProfile, error) {
	name, locked, err := validateInput(in)
	if err != nil {
		return configprofilesdb.ConfigProfile{}, err
	}
	cfg := in.Config
	if len(cfg) == 0 {
		cfg = json.RawMessage(`{}`)
	}
	var p configprofilesdb.ConfigProfile
	err = s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := configprofilesdb.New(tx)
		if in.IsGlobal {
			if err := s.demoteGlobal(ctx, q, uuid.Nil, actor); err != nil {
				return err
			}
		}
		var err error
		p, err = q.CreateConfigProfile(ctx, configprofilesdb.CreateConfigProfileParams{
			ID: uuid.Must(uuid.NewV7()), Name: name, Description: nilIfEmpty(in.Description), IsGlobal: in.IsGlobal,
			Config: cfg, LockedKeys: locked, UpdatedBy: &actor,
		})
		if err != nil {
			return err
		}
		if err := snapshot(ctx, q, p); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, "config.profile.create", "config_profile", p.ID.String(), map[string]any{"name": name, "global": in.IsGlobal}); err != nil {
			return err
		}
		return s.Changed(ctx, tx)
	})
	if unique(err) {
		return configprofilesdb.ConfigProfile{}, httpproblem.Errorf(syncproto.CodeNameInUse, "a profile named %q exists", name)
	}
	return p, err
}

// snapshot stores the state of a profile in its history (version numbers are unique per profile).
func snapshot(ctx context.Context, q *configprofilesdb.Queries, p configprofilesdb.ConfigProfile) error {
	return q.InsertProfileVersion(ctx, configprofilesdb.InsertProfileVersionParams{
		ProfileID: p.ID, Version: p.Version, Name: p.Name, Description: p.Description, IsGlobal: p.IsGlobal,
		Config: p.Config, LockedKeys: p.LockedKeys, UpdatedBy: p.UpdatedBy, UpdatedAt: p.UpdatedAt,
	})
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// demoteGlobal clears the global flag of the current global profile (not keep).
func (s *Service) demoteGlobal(ctx context.Context, q *configprofilesdb.Queries, keep, actor uuid.UUID) error {
	cur, err := q.GetGlobalConfigProfile(ctx)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && cur.ID == keep) {
		return nil
	}
	if err != nil {
		return err
	}
	demoted, err := q.UpdateConfigProfile(ctx, configprofilesdb.UpdateConfigProfileParams{
		ID: cur.ID, Name: cur.Name, Description: cur.Description, IsGlobal: false, Config: cur.Config, LockedKeys: cur.LockedKeys, UpdatedBy: &actor,
	})
	if err != nil {
		return err
	}
	return snapshot(ctx, q, demoted)
}

// Update replaces a profile and increments its version.
func (s *Service) Update(ctx context.Context, actor, id uuid.UUID, in ProfileInput) (configprofilesdb.ConfigProfile, error) {
	name, locked, err := validateInput(in)
	if err != nil {
		return configprofilesdb.ConfigProfile{}, err
	}
	cfg := in.Config
	if len(cfg) == 0 {
		cfg = json.RawMessage(`{}`)
	}
	var p configprofilesdb.ConfigProfile
	err = s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := configprofilesdb.New(tx)
		cur, err := q.LockConfigProfile(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return httpproblem.NotFound("profile")
		} else if err != nil {
			return err
		}
		if in.ExpectedVersion != nil && *in.ExpectedVersion != cur.Version {
			return httpproblem.Errorf(syncproto.CodeRevConflict,
				"the profile is at version %d, not %d: another change was saved meanwhile", cur.Version, *in.ExpectedVersion)
		}
		if in.IsGlobal {
			if err := s.demoteGlobal(ctx, q, id, actor); err != nil {
				return err
			}
		}
		p, err = q.UpdateConfigProfile(ctx, configprofilesdb.UpdateConfigProfileParams{
			ID: id, Name: name, Description: nilIfEmpty(in.Description), IsGlobal: in.IsGlobal, Config: cfg, LockedKeys: locked, UpdatedBy: &actor,
		})
		if err != nil {
			return err
		}
		if err := snapshot(ctx, q, p); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, "config.profile.update", "config_profile", id.String(), map[string]any{"version": p.Version}); err != nil {
			return err
		}
		return s.Changed(ctx, tx)
	})
	if unique(err) {
		return configprofilesdb.ConfigProfile{}, httpproblem.Errorf(syncproto.CodeNameInUse, "a profile named %q exists", name)
	}
	return p, err
}

// Delete removes a profile and its assignments.
func (s *Service) Delete(ctx context.Context, actor, id uuid.UUID) error {
	return s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := configprofilesdb.New(tx)
		n, err := q.DeleteConfigProfile(ctx, id)
		if err != nil {
			return err
		}
		if n == 0 {
			return httpproblem.NotFound("profile")
		}
		if err := audit.Record(ctx, tx, actor, "config.profile.delete", "config_profile", id.String(), nil); err != nil {
			return err
		}
		return s.Changed(ctx, tx)
	})
}

// Get returns a profile.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (configprofilesdb.ConfigProfile, error) {
	p, err := configprofilesdb.New(s.db.Pool).GetConfigProfile(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return configprofilesdb.ConfigProfile{}, httpproblem.NotFound("profile")
	}
	return p, err
}

// List returns every profile, the global one first.
func (s *Service) List(ctx context.Context) ([]configprofilesdb.ConfigProfile, error) {
	return configprofilesdb.New(s.db.Pool).ListConfigProfiles(ctx)
}

// Assignment ties a profile to a group with a priority (higher wins).
type Assignment struct {
	ProfileID uuid.UUID `json:"profile_id"`
	Priority  int32     `json:"priority"`
}

// assignmentsAudit is the details of config.assignments.set: an object, as
// the audit console expects of every entry, listing the new assignments.
func assignmentsAudit(as []Assignment) map[string]any {
	if as == nil {
		as = []Assignment{}
	}
	return map[string]any{"assignments": as}
}

// SetGroupAssignments replaces the profiles assigned to a group.
func (s *Service) SetGroupAssignments(ctx context.Context, actor, groupID uuid.UUID, as []Assignment) error {
	return s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := configprofilesdb.New(tx)
		if _, err := groups.GetGroup(ctx, tx, groupID); errors.Is(err, pgx.ErrNoRows) {
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
			if err := q.AssignProfile(ctx, configprofilesdb.AssignProfileParams{ProfileID: a.ProfileID, GroupID: groupID, Priority: a.Priority}); err != nil {
				return err
			}
		}
		if err := audit.Record(ctx, tx, actor, "config.assignments.set", "group", groupID.String(), assignmentsAudit(as)); err != nil {
			return err
		}
		return s.Changed(ctx, tx)
	})
}

// Versions returns the history of a profile, newest first.
func (s *Service) Versions(ctx context.Context, id uuid.UUID) ([]configprofilesdb.ConfigProfileVersion, error) {
	if _, err := s.Get(ctx, id); err != nil {
		return nil, err
	}
	return configprofilesdb.New(s.db.Pool).ListProfileVersions(ctx, id)
}

// Restore makes an old version the new current one (a rollback adds a version, it never rewrites history).
// Whether the profile is global is a property of the profile now, not of the restored content.
func (s *Service) Restore(ctx context.Context, actor, id uuid.UUID, version int32) (configprofilesdb.ConfigProfile, error) {
	cur, err := s.Get(ctx, id)
	if err != nil {
		return configprofilesdb.ConfigProfile{}, err
	}
	old, err := configprofilesdb.New(s.db.Pool).GetProfileVersion(ctx, configprofilesdb.GetProfileVersionParams{ProfileID: id, Version: version})
	if errors.Is(err, pgx.ErrNoRows) {
		return configprofilesdb.ConfigProfile{}, httpproblem.NotFound("version")
	}
	if err != nil {
		return configprofilesdb.ConfigProfile{}, err
	}
	desc := ""
	if old.Description != nil {
		desc = *old.Description
	}
	return s.Update(ctx, actor, id, ProfileInput{
		Name: old.Name, Description: desc, IsGlobal: cur.IsGlobal, Config: old.Config, LockedKeys: old.LockedKeys,
	})
}
