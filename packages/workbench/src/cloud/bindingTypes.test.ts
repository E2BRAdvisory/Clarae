// The cloud-management bindings speak the types of api/openapi.yaml (ADR-0045 §6): the models Wails
// generates from the core's package cloudapi must equal the Schemas of @clarae/api-client, field
// for field, optional for optional, enum for enum. These assertions are checked by `tsc` (the
// typecheck of the package), so a drift between the Go DTOs and the OpenAPI fails the build; the
// Go side checks the same types against shared/go/apiclient (cloudapi_test.go).
import { describe, expectTypeOf, it } from 'vitest';
import type { Schemas } from '@clarae/api-client';
import type * as SharingAPI from '../../wailsjs/go/app/SharingAPI';
import type * as SyncAPI from '../../wailsjs/go/app/SyncAPI';

/** A model as plain data: the generated classes add `convertValues`, the JSON does not. */
type Plain<T> = Omit<T, 'convertValues'>;
/** What a binding resolves to, as plain data (one element for a list). */
type Result<F> = F extends (...args: never[]) => Promise<infer R>
  ? R extends readonly (infer E)[]
    ? Plain<E>
    : Plain<R>
  : never;
/** An intersection as one object type, to compare it with a generated model. */
type Flat<T> = { [K in keyof T]: T[K] };
/** The n-th parameter of a binding, as plain data (one element for a list). */
type Param<F, N extends number> = F extends (...args: infer A) => unknown
  ? A[N] extends readonly (infer E)[]
    ? Plain<E>
    : Plain<A[N]>
  : never;

describe('the cloud-management bindings return the OpenAPI types', () => {
  it('cloud vaults', () => {
    expectTypeOf<Result<typeof SyncAPI.ListCloudVaults>>().toEqualTypeOf<Schemas['Vault']>();
    expectTypeOf<Result<typeof SyncAPI.ListDeletedCloudVaults>>().toEqualTypeOf<Schemas['Vault']>();
    expectTypeOf<Result<typeof SyncAPI.RenameCloudVault>>().toEqualTypeOf<Schemas['Vault']>();
    expectTypeOf<Result<typeof SyncAPI.RestoreCloudVault>>().toEqualTypeOf<Schemas['Vault']>();
  });

  it('devices and usage', () => {
    // `current` is the one field of the core: only it knows which device it runs on.
    expectTypeOf<Result<typeof SyncAPI.Devices>>().toEqualTypeOf<
      Flat<Schemas['Device'] & { current: boolean }>
    >();
    expectTypeOf<Result<typeof SyncAPI.Usage>>().toEqualTypeOf<Schemas['Usage']>();
  });

  it('shares and grants', () => {
    expectTypeOf<Result<typeof SharingAPI.Invitations>>().toEqualTypeOf<Schemas['Share']>();
    // A page: its items are the Share model, as the other bindings' (Plain of the class).
    expectTypeOf<Plain<Result<typeof SharingAPI.ListShares>['items'][number]>>().toEqualTypeOf<
      Schemas['Share']
    >();
    expectTypeOf<Result<typeof SharingAPI.ListShares>['next_cursor']>().toEqualTypeOf<
      Schemas['SharePage']['next_cursor']
    >();
    expectTypeOf<keyof Result<typeof SharingAPI.ListShares>>().toEqualTypeOf<
      keyof Schemas['SharePage']
    >();
    expectTypeOf<Result<typeof SharingAPI.VaultShares>>().toEqualTypeOf<Schemas['Share']>();
    expectTypeOf<Result<typeof SharingAPI.Share>>().toEqualTypeOf<Schemas['Share']>();
    expectTypeOf<Result<typeof SharingAPI.CreateShare>>().toEqualTypeOf<Schemas['Share']>();
    expectTypeOf<Result<typeof SharingAPI.CreateCloudShare>>().toEqualTypeOf<Schemas['Share']>();
    expectTypeOf<Result<typeof SharingAPI.UpdateShare>>().toEqualTypeOf<Schemas['Share']>();
    expectTypeOf<Result<typeof SharingAPI.SetGrant>>().toEqualTypeOf<Schemas['Grant']>();
    expectTypeOf<Param<typeof SharingAPI.CreateShare, 4>>().toEqualTypeOf<Schemas['NewGrant']>();
    expectTypeOf<Param<typeof SharingAPI.CreateCloudShare, 3>>().toEqualTypeOf<
      Schemas['NewGrant']
    >();
    expectTypeOf<Param<typeof SharingAPI.UpdateShare, 1>>().toEqualTypeOf<Schemas['UpdateShare']>();
  });

  it('the directory', () => {
    expectTypeOf<Result<typeof SharingAPI.SearchDirectoryUsers>>().toEqualTypeOf<
      Schemas['DirectoryUser']
    >();
    expectTypeOf<Result<typeof SharingAPI.SearchDirectoryGroups>>().toEqualTypeOf<
      Schemas['DirectoryGroup']
    >();
  });
});
