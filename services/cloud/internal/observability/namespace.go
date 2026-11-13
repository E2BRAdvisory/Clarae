package observability

import "clarae/services/cloud/internal/config"

// namespace is the Prometheus namespace of every collector of the service: METRICS_NAMESPACE,
// otherwise "memobrain" for the realm of a 1.x installation (so that its dashboards and alerts
// keep working after the upgrade) and "clarae" for anything else.
//
// The collectors are package-level (promauto) and register while the package initialises, before
// main has loaded the configuration. This is therefore the one place where the environment is read
// outside config.Load, through config.MetricsNamespaceFromEnv, which keeps the rule in one place
// and which Load validates. Go initialises a package-level variable before the ones that use it.
var namespace = config.MetricsNamespaceFromEnv()
