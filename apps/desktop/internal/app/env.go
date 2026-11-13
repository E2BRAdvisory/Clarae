package app

import (
	"sync"

	"github.com/rs/zerolog"

	"clarae/shared/envcompat"
)

// warnedEnv remembers the variables of 1.x already reported in this process (the log says it once).
var warnedEnv sync.Map

// envValue reads the variable CLARAE_<name>, or the one with the prefix of 1.x when the first is
// not set (envcompat: the environment of an installation made for 1.x keeps working, an
// administrator's switch that turns the updates off included), and says in the log, once per
// variable, that the old name is the one in use.
func envValue(logger zerolog.Logger, name string) string {
	v, deprecated := envcompat.Lookup(name)
	if deprecated {
		if _, seen := warnedEnv.LoadOrStore(name, true); !seen {
			logger.Warn().Str("variable", envcompat.LegacyPrefix+name).Str("use", envcompat.Prefix+name).
				Msg("environment variable with the name of the previous version: rename it")
		}
	}
	return v
}
