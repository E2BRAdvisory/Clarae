// The feature flags of the Config Profile (`features.*`), generated from api/config-profile.schema.json
// by `task gen` (src/gen/features.ts). Import from '@memobrain/api-client/features': the subpath has no
// dependency, so the workbench and the console share it without pulling the REST client in.
import { FEATURE_DEFAULTS, type Feature } from './gen/features';

export { FEATURES, FEATURE_DEFAULTS, Feature } from './gen/features';

/**
 * Whether a flag is on in the `features` section of a configuration: the value it sets when it is a
 * boolean, otherwise the schema's default. A flag the schema does not know is on (a function newer
 * than this build stays available until an administrator switches it off).
 */
export function featureEnabled(
  features: Readonly<Record<string, unknown>> | undefined | null,
  name: Feature | (string & {}),
): boolean {
  const v = features?.[name];
  if (typeof v === 'boolean') return v;
  return (FEATURE_DEFAULTS as Readonly<Record<string, boolean>>)[name] ?? true;
}
