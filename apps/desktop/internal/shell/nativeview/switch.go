package nativeview

// The switch that turns the native web views off (ADR-0062). It has no build tag: the drivers of Windows and
// Linux read it, and a machine that is neither tests it all the same.

import (
	"os"
	"strings"
)

// disableEnv names the variable that turns the native web views of Windows and Linux off. They are on by default,
// with a fallback to the system browser when the runtime or the toolkit cannot show them (ADR-0062); the variable is
// for whoever has a machine where they misbehave. Only the value "off" (any case, spaces around it ignored) turns
// them off: nothing else a user may have in the environment by chance (an empty value, "0", "false", "no") does.
const disableEnv = "CLARAE_WEBVIEW"

// disabledBy says whether a value of disableEnv turns the native web views off.
func disabledBy(value string) bool { return strings.EqualFold(strings.TrimSpace(value), "off") }

// enabledByEnvironment says whether the environment leaves the native web views on.
func enabledByEnvironment() bool { return !disabledBy(os.Getenv(disableEnv)) }
