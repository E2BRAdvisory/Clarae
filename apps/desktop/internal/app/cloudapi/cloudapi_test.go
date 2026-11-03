package cloudapi

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"memobrain/shared/apiclient"
)

// sameShape reports the first difference between a DTO and its API type: field names, order, JSON
// tags, and types (identical, or a DTO of the API type at the same place: Share.Grants).
func sameShape(dto, api reflect.Type, path string) string {
	if dto == api {
		return ""
	}
	if dto.Kind() != api.Kind() {
		return path + ": " + dto.String() + " is not " + api.String()
	}
	switch dto.Kind() {
	case reflect.Pointer, reflect.Slice:
		return sameShape(dto.Elem(), api.Elem(), path+"[]")
	case reflect.Struct:
		if dto.NumField() != api.NumField() {
			return path + ": the DTO has " + dto.String() + " fields that differ in number from " + api.String()
		}
		for i := range dto.NumField() {
			d, a := dto.Field(i), api.Field(i)
			if d.Name != a.Name {
				return path + ": field " + d.Name + " where the API has " + a.Name
			}
			if d.Tag.Get("json") != a.Tag.Get("json") {
				return path + "." + d.Name + `: json:"` + d.Tag.Get("json") + `", the API has json:"` + a.Tag.Get("json") + `"`
			}
			if diff := sameShape(d.Type, a.Type, path+"."+d.Name); diff != "" {
				return diff
			}
		}
		return ""
	}
	return path + ": " + dto.String() + " is not " + api.String()
}

func TestTypesMatchTheAPI(t *testing.T) {
	pairs := []struct{ dto, api any }{
		{Vault{}, apiclient.Vault{}},
		{Device{}, apiclient.Device{}},
		{Usage{}, apiclient.Usage{}},
		{Share{}, apiclient.Share{}},
		{SharePage{}, apiclient.SharePage{}},
		{Grant{}, apiclient.Grant{}},
		{NewGrant{}, apiclient.NewGrant{}},
		{UpdateShare{}, apiclient.UpdateShare{}},
		{DirectoryUser{}, apiclient.DirectoryUser{}},
		{DirectoryGroup{}, apiclient.DirectoryGroup{}},
	}
	for _, p := range pairs {
		dto, api := reflect.TypeOf(p.dto), reflect.TypeOf(p.api)
		if diff := sameShape(dto, api, dto.Name()); diff != "" {
			t.Errorf("cloudapi.%s differs from apiclient.%s: %s", dto.Name(), api.Name(), diff)
		}
	}
}

// Every field Wails cannot type by itself (UUID, time, enum) names its TypeScript type, so that the
// generated model is the Schema and not `number[]`, `any` or `string`.
func TestFieldsWithoutATypeScriptTypeAreTagged(t *testing.T) {
	for _, v := range []any{Vault{}, Device{}, Usage{}, Share{}, SharePage{}, Grant{}, NewGrant{}, UpdateShare{}, DirectoryUser{}, DirectoryGroup{}} {
		typ := reflect.TypeOf(v)
		for i := range typ.NumField() {
			f := typ.Field(i)
			ft := f.Type
			if ft.Kind() == reflect.Pointer {
				ft = ft.Elem()
			}
			needsTag := ft == reflect.TypeFor[uuid.UUID]() || ft == reflect.TypeFor[time.Time]() ||
				(ft.Kind() == reflect.String && ft.PkgPath() != "")
			if needsTag && f.Tag.Get("ts_type") == "" {
				t.Errorf("%s.%s (%s) has no ts_type tag", typ.Name(), f.Name, f.Type)
			}
		}
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The DTOs marshal to the JSON of the API, absent optional fields included.
func TestJSONIsTheOneOfTheAPI(t *testing.T) {
	id := uuid.MustParse("0198f1c2-aaaa-7bbb-8ccc-000000000001")
	at := time.Date(2026, 11, 2, 10, 30, 0, 123_000_000, time.UTC)
	perm, status, prefix := apiclient.SharePermissionManager, apiclient.GrantStatusAccepted, "Projects/Alfa"
	full := apiclient.Share{
		CreatedAt: at, DisplayName: "Alfa", ExpiresAt: &at, FileId: &id, Id: id, MyPermission: &perm, MyStatus: &status,
		OwnerId: id, OwnerName: "Ada", PathPrefix: &prefix, ResourceType: apiclient.ResourceTypeFolder, VaultId: id, VaultName: "Work",
		Grants: &[]apiclient.Grant{{CreatedAt: at, GrantedBy: &id, Permission: perm, PrincipalId: id, PrincipalName: "Bob", PrincipalType: apiclient.GrantPrincipalTypeUser, Status: status}},
	}
	minimal := apiclient.Share{CreatedAt: at, Id: id, OwnerId: id, VaultId: id, ResourceType: apiclient.ResourceTypeVault}
	for _, s := range []apiclient.Share{full, minimal} {
		if got, want := mustJSON(t, ShareOf(s)), mustJSON(t, s); !bytes.Equal(got, want) {
			t.Errorf("share:\n got %s\nwant %s", got, want)
		}
	}
	v := apiclient.Vault{CreatedAt: at, DeletedAt: &at, FileCount: 3, Id: id, Kind: apiclient.Shared, LastSeq: 9, Name: "Work", OwnerId: id, TotalBytes: 42}
	if got, want := mustJSON(t, VaultOf(v)), mustJSON(t, v); !bytes.Equal(got, want) {
		t.Errorf("vault:\n got %s\nwant %s", got, want)
	}
	d := apiclient.Device{CreatedAt: at, Id: id, Name: "Laptop", Platform: "darwin"}
	got := string(mustJSON(t, DevicesOf([]apiclient.Device{d}, id.String())[0]))
	want := strings.TrimSuffix(string(mustJSON(t, d)), "}") + `,"current":true}`
	if got != want {
		t.Errorf("device:\n got %s\nwant %s", got, want)
	}
	if ds := DevicesOf([]apiclient.Device{d}, ""); ds[0].Current {
		t.Error("a device is current while this device is unknown")
	}
	if VaultsOf(nil) == nil || SharesOf(nil) == nil || DevicesOf(nil, "") == nil || DirectoryUsersOf(nil) == nil || DirectoryGroupsOf(nil) == nil {
		t.Error("an empty list is nil (null in JSON)")
	}
}

// What the UI sends (the JSON of the Schemas) reaches the API client unchanged.
func TestInputsDecodeTheJSONOfTheAPI(t *testing.T) {
	var u UpdateShare
	if err := json.Unmarshal([]byte(`{"display_name":"Beta","expires_at":"2026-12-01T00:00:00Z","clear_expiry":false}`), &u); err != nil {
		t.Fatal(err)
	}
	api := u.API()
	if *api.DisplayName != "Beta" || !api.ExpiresAt.Equal(time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)) || *api.ClearExpiry {
		t.Fatalf("update = %+v", api)
	}
	var g NewGrant
	if err := json.Unmarshal([]byte(`{"principal_type":"group","principal_id":"0198f1c2-aaaa-7bbb-8ccc-000000000001","permission":"editor"}`), &g); err != nil {
		t.Fatal(err)
	}
	if ng := g.API(); ng.PrincipalType != apiclient.NewGrantPrincipalTypeGroup || ng.Permission != apiclient.SharePermissionEditor || ng.PrincipalId.String() != "0198f1c2-aaaa-7bbb-8ccc-000000000001" {
		t.Fatalf("grant = %+v", ng)
	}
}
