package quota

import "testing"

func TestLevelFor(t *testing.T) {
	cases := []struct {
		used, quota int64
		want        Level
	}{
		{0, 100, LevelOK},
		{79, 100, LevelOK},
		{80, 100, LevelWarning},
		{94, 100, LevelWarning},
		{95, 100, LevelCritical},
		{99, 100, LevelCritical},
		{100, 100, LevelFull},
		{150, 100, LevelFull},
		{1 << 40, Unlimited, LevelOK},
		{0, 0, LevelFull},
	}
	for _, c := range cases {
		if got := LevelFor(c.used, c.quota, 80, 95); got != c.want {
			t.Errorf("used %d of %d: %s, want %s", c.used, c.quota, got, c.want)
		}
	}
}
