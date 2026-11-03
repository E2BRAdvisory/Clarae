package transport

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"memobrain/shared/apiclient"
)

// API types of the sharing, directory and configuration endpoints (generated
// from api/openapi.yaml).
type (
	// Share is a vault, folder or document shared with users and groups.
	Share = apiclient.Share
	// Grant is one principal's access to a share.
	Grant = apiclient.Grant
	// Mount is an accepted share, with the scope that syncs it.
	Mount = apiclient.Mount
	// SharePage is a page of GET /shares.
	SharePage = apiclient.SharePage
	// CreateShare is the body of POST /shares.
	CreateShare = apiclient.CreateShare
	// NewGrant is a recipient given while creating a share.
	NewGrant = apiclient.NewGrant
	// DirectoryUser is a user found by the directory search.
	DirectoryUser = apiclient.DirectoryUser
	// DirectoryGroup is a group found by the directory search.
	DirectoryGroup = apiclient.DirectoryGroup
	// EffectiveConfig is GET /config/effective (§2.6.6).
	EffectiveConfig = apiclient.EffectiveConfig
)

// ListSharesPage returns a page of the shares the caller owns or manages ("owned") or was invited
// to ("received"), newest first: the first page with cursor "", the next one with the NextCursor
// of the page before (absent on the last). limit 0 takes the server's default page size.
func (c *Client) ListSharesPage(ctx context.Context, scope, cursor string, limit int) (SharePage, error) {
	res, err := c.api.ListSharesWithResponse(ctx, &apiclient.ListSharesParams{
		Scope: apiclient.ListSharesParamsScope(scope), Limit: ptrIf(limit), Cursor: ptrIf(cursor),
	})
	if err != nil {
		return SharePage{}, err
	}
	return want(res.HTTPResponse, res.Body, res.JSON200)
}

// ListShares returns every share the caller owns or manages ("owned") or was invited to
// ("received"), reading all the pages.
func (c *Client) ListShares(ctx context.Context, scope string) ([]Share, error) {
	return allPages(func(cursor string) ([]Share, *string, error) {
		p, err := c.ListSharesPage(ctx, scope, cursor, drainPageSize)
		return p.Items, p.NextCursor, err
	})
}

// drainPageSize is the page size of the lists read whole (the largest the API serves).
const drainPageSize = 500

// maxPages bounds the walk through one list: past it, or on a cursor that does not move, the
// server is not ending the list, and the walk fails instead of looping.
const maxPages = 10_000

// allPages reads every page of a paginated list (api/openapi.yaml, Pagination): it follows the
// next cursor until a page has none, whatever the number of items of each page (a page may be
// empty and still have a next one). An empty list is empty, never nil.
func allPages[T any](page func(cursor string) ([]T, *string, error)) ([]T, error) {
	out := []T{}
	cursor := ""
	for range maxPages {
		items, next, err := page(cursor)
		if err != nil {
			return nil, err
		}
		out = append(out, items...)
		if next == nil || *next == "" {
			return out, nil
		}
		if *next == cursor {
			return nil, errors.New("paginated list: the server repeated a cursor")
		}
		cursor = *next
	}
	return nil, fmt.Errorf("paginated list: no last page after %d pages", maxPages)
}

// GetShare returns one share.
func (c *Client) GetShare(ctx context.Context, id string) (Share, error) {
	sid, err := parseID("share", id)
	if err != nil {
		return Share{}, err
	}
	res, err := c.api.GetShareWithResponse(ctx, sid)
	if err != nil {
		return Share{}, err
	}
	return want(res.HTTPResponse, res.Body, res.JSON200)
}

// CreateShare shares a vault, folder or document.
func (c *Client) CreateShare(ctx context.Context, in CreateShare) (Share, error) {
	res, err := c.api.CreateShareWithResponse(ctx, in)
	if err != nil {
		return Share{}, err
	}
	return want(res.HTTPResponse, res.Body, res.JSON201)
}

// RevokeShare ends a share (owner).
func (c *Client) RevokeShare(ctx context.Context, id string) error {
	sid, err := parseID("share", id)
	if err != nil {
		return err
	}
	res, err := c.api.RevokeShareWithResponse(ctx, sid)
	if err != nil {
		return err
	}
	return ok(res.HTTPResponse, res.Body)
}

// UpdateShare renames a share and/or sets or removes its expiry (owner or manager).
func (c *Client) UpdateShare(ctx context.Context, id string, name *string, expires *time.Time, clearExpiry bool) (Share, error) {
	sid, err := parseID("share", id)
	if err != nil {
		return Share{}, err
	}
	body := apiclient.UpdateShare{DisplayName: name, ExpiresAt: expires}
	if clearExpiry {
		body.ClearExpiry = &clearExpiry
	}
	res, err := c.api.UpdateShareWithResponse(ctx, sid, body)
	if err != nil {
		return Share{}, err
	}
	return want(res.HTTPResponse, res.Body, res.JSON200)
}

// PutGrant adds a grant or changes its level.
func (c *Client) PutGrant(ctx context.Context, share, ptype, pid, permission string) (Grant, error) {
	sid, err := parseID("share", share)
	if err != nil {
		return Grant{}, err
	}
	principal, err := parseID("principal", pid)
	if err != nil {
		return Grant{}, err
	}
	res, err := c.api.PutGrantWithResponse(ctx, sid, apiclient.PrincipalType(ptype), principal, apiclient.GrantInput{Permission: apiclient.SharePermission(permission)})
	if err != nil {
		return Grant{}, err
	}
	return want(res.HTTPResponse, res.Body, res.JSON200)
}

// DeleteGrant removes a grant.
func (c *Client) DeleteGrant(ctx context.Context, share, ptype, pid string) error {
	sid, err := parseID("share", share)
	if err != nil {
		return err
	}
	principal, err := parseID("principal", pid)
	if err != nil {
		return err
	}
	res, err := c.api.DeleteGrantWithResponse(ctx, sid, apiclient.PrincipalType(ptype), principal)
	if err != nil {
		return err
	}
	return ok(res.HTTPResponse, res.Body)
}

// AcceptShare accepts an invitation.
func (c *Client) AcceptShare(ctx context.Context, id string) (Share, error) {
	sid, err := parseID("share", id)
	if err != nil {
		return Share{}, err
	}
	res, err := c.api.AcceptShareWithResponse(ctx, sid)
	if err != nil {
		return Share{}, err
	}
	return want(res.HTTPResponse, res.Body, res.JSON200)
}

// DeclineShare declines an invitation.
func (c *Client) DeclineShare(ctx context.Context, id string) (Share, error) {
	sid, err := parseID("share", id)
	if err != nil {
		return Share{}, err
	}
	res, err := c.api.DeclineShareWithResponse(ctx, sid)
	if err != nil {
		return Share{}, err
	}
	return want(res.HTTPResponse, res.Body, res.JSON200)
}

// SharedWithMe lists every accepted share, each with the scope that syncs it, reading all the
// pages: the mounts are reconciled with it, and a share left on an unread page would look revoked.
func (c *Client) SharedWithMe(ctx context.Context) ([]Mount, error) {
	return allPages(func(cursor string) ([]Mount, *string, error) {
		res, err := c.api.ListSharedWithMeWithResponse(ctx, &apiclient.ListSharedWithMeParams{
			Limit: ptrIf(drainPageSize), Cursor: ptrIf(cursor),
		})
		if err != nil {
			return nil, nil, err
		}
		p, err := want(res.HTTPResponse, res.Body, res.JSON200)
		return p.Items, p.NextCursor, err
	})
}

// SearchUsers searches the directory for people to share with.
func (c *Client) SearchUsers(ctx context.Context, q string) ([]DirectoryUser, error) {
	res, err := c.api.SearchDirectoryUsersWithResponse(ctx, &apiclient.SearchDirectoryUsersParams{Q: &q})
	if err != nil {
		return nil, err
	}
	return want(res.HTTPResponse, res.Body, res.JSON200)
}

// SearchGroups searches the directory for groups to share with.
func (c *Client) SearchGroups(ctx context.Context, q string) ([]DirectoryGroup, error) {
	res, err := c.api.SearchDirectoryGroupsWithResponse(ctx, &apiclient.SearchDirectoryGroupsParams{Q: &q})
	if err != nil {
		return nil, err
	}
	return want(res.HTTPResponse, res.Body, res.JSON200)
}

// GetEffectiveConfig fetches the effective configuration. With a matching ETag the
// server answers 304 and changed is false (cfg is then zero).
func (c *Client) GetEffectiveConfig(ctx context.Context, etag string) (cfg EffectiveConfig, newETag string, changed bool, err error) {
	res, err := c.api.GetEffectiveConfigWithResponse(ctx, &apiclient.GetEffectiveConfigParams{IfNoneMatch: ptrIf(etag)})
	if err != nil {
		return cfg, "", false, err
	}
	if res.StatusCode() == http.StatusNotModified {
		return cfg, etag, false, nil
	}
	if cfg, err = want(res.HTTPResponse, res.Body, res.JSON200); err != nil {
		return cfg, "", false, err
	}
	return cfg, res.HTTPResponse.Header.Get("ETag"), true, nil
}
