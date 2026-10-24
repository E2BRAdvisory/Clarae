package hashing

import (
	"strings"
	"testing"
)

const helloHex = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" // sha256("hello")

func TestSum(t *testing.T) {
	if got := Sum([]byte("hello")).Hex(); got != helloHex {
		t.Fatalf("Sum = %s, want %s", got, helloHex)
	}
	h, n, err := SumReader(strings.NewReader("hello"))
	if err != nil || n != 5 || h.Hex() != helloHex {
		t.Fatalf("SumReader = %s,%d,%v", h, n, err)
	}
	if !(Hash{}).IsZero() || h.IsZero() {
		t.Fatal("IsZero broken")
	}
}

func TestParseHex(t *testing.T) {
	h, err := ParseHex(strings.ToUpper(helloHex))
	if err != nil || h.Hex() != helloHex {
		t.Fatalf("ParseHex upper: %v %s", err, h)
	}
	for _, bad := range []string{"", "abc", helloHex[:63], helloHex + "0", strings.Repeat("zz", 32)} {
		if _, err := ParseHex(bad); err == nil {
			t.Errorf("ParseHex(%q) should fail", bad)
		}
		if IsHex(bad) {
			t.Errorf("IsHex(%q) should be false", bad)
		}
	}
}
