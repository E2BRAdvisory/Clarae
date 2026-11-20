package nativeview

import "testing"

func TestDisableSwitch(t *testing.T) {
	// The web views are on unless the value is "off": nothing a user may have in the environment by chance turns
	// them off.
	for _, v := range []string{"", "0", "false", "no", "on", "1", "offf", "of", "disabled", "true"} {
		if disabledBy(v) {
			t.Errorf("disabledBy(%q) = true", v)
		}
	}
	for _, v := range []string{"off", "OFF", "Off", " off", "off ", "\toff\n"} {
		if !disabledBy(v) {
			t.Errorf("disabledBy(%q) = false", v)
		}
	}
	if disableEnv != "CLARAE_WEBVIEW" {
		t.Errorf("the name of the switch changed: %s (guides and the matrix of tests name it)", disableEnv)
	}
}

func TestEnvironmentSwitch(t *testing.T) {
	t.Setenv(disableEnv, "")
	if !enabledByEnvironment() {
		t.Error("on by default: an empty variable turned the views off")
	}
	t.Setenv(disableEnv, "off")
	if enabledByEnvironment() {
		t.Error("CLARAE_WEBVIEW=off left the views on")
	}
}
