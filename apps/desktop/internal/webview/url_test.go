package webview

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateURL(t *testing.T) {
	long := "https://example.com/" + strings.Repeat("a", MaxURLBytes)
	tests := []struct {
		name string
		in   string
		want BlockReason // "" = accepted
	}{
		// accepted
		{"https", "https://example.com", ""},
		{"http with path and query", "http://example.com:8080/a/b?c=d#e", ""},
		{"upper case scheme", "HTTPS://Example.COM/", ""},
		{"IDN host", "https://bücher.example/", ""},
		{"percent encoded path", "https://example.com/a%20b", ""},
		{"empty port", "https://example.com:/", ""},
		{"IPv6", "http://[2001:db8::1]:8080/", ""},
		{"long but within the limit", "https://example.com/" + strings.Repeat("a", 1000), ""},
		// what is not http(s)
		{"clarae", "clarae://open?vault=x", BlockScheme},
		{"file", "file:///etc/passwd", BlockScheme},
		{"wails", "wails://wails/index.html", BlockScheme},
		{"javascript", "javascript:alert(1)", BlockScheme},
		{"data", "data:text/html,<h1>x</h1>", BlockScheme},
		{"blob", "blob:https://example.com/uuid", BlockScheme},
		{"about", "about:blank", BlockScheme},
		{"ftp", "ftp://example.com/", BlockScheme},
		{"unknown", "x-unknown://host/", BlockScheme},
		{"mixed case javascript", "JaVaScRiPt:alert(1)", BlockScheme},
		{"no scheme", "example.com", BlockMalformed},
		{"relative", "/path", BlockMalformed},
		{"scheme relative", "//example.com/", BlockMalformed},
		// no authority
		{"opaque", "http:example.com", BlockMalformed},
		{"one slash", "http:/example.com", BlockHost},
		{"no host", "http:///path", BlockHost},
		{"only a port", "http://:80/", BlockHost},
		{"only a dot", "http://./", BlockHost},
		{"empty label", "http://a..b/", BlockHost},
		{"leading dot", "http://.example.com/", BlockHost},
		// credentials
		{"user and password", "https://user:secret@example.com/", BlockCredentials},
		{"user only", "https://user@example.com/", BlockCredentials},
		{"empty userinfo", "https://@example.com/", BlockCredentials},
		{"userinfo that looks like a host", "https://example.com:80@evil.example/", BlockCredentials},
		{"userinfo with a backslash", `https://good.example\@evil.example/`, BlockCharacters},
		// characters
		{"empty", "", BlockEmpty},
		{"newline", "https://example.com/\nx", BlockCharacters},
		{"tab", "https://exa\tmple.com/", BlockCharacters},
		{"NUL", "https://example.com/\x00", BlockCharacters},
		{"DEL", "https://example.com/\x7f", BlockCharacters},
		{"C1 control", "https://example.com/\u0085", BlockCharacters},
		{"space inside", "https://example.com/a b", BlockCharacters},
		{"leading space", " https://example.com/", BlockCharacters},
		{"trailing space", "https://example.com/ ", BlockCharacters},
		{"no-break space", "https://example.com/ ", BlockCharacters},
		{"zero width space", "https://exam\u200bple.com/", BlockCharacters},
		{"right-to-left override", "https://example.com/\u202e", BlockCharacters},
		{"backslash as slash", `https:\\example.com\path`, BlockCharacters},
		{"invalid UTF-8", "https://example.com/\xff", BlockCharacters},
		{"too long", long, BlockTooLong},
		// port
		{"port zero", "https://example.com:0/", BlockPort},
		{"port too large", "https://example.com:65536/", BlockPort},
		{"huge port", "https://example.com:99999999999999999999/", BlockPort},
		{"port 65535", "https://example.com:65535/", ""},
		{"non numeric port", "https://example.com:http/", BlockMalformed},
		// hosts a browser would refuse
		{"percent in host", "https://exa%6dple.com/", BlockMalformed},
		{"IPv6 zone", "http://[fe80::1%25eth0]/", BlockHost},
		{"IPv4 with a part too large", "http://256.1.1.1/", BlockHost},
		{"too many parts", "http://1.2.3.4.5/", BlockHost},
		{"last part too large for the parts", "http://1.2.65536/", BlockHost},
		{"bad octal", "http://01.09.0.1/", BlockHost},
		{"bad hex", "http://0x1g.1/", BlockHost},
		{"a name that only looks like hex", "http://0xzz/", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateURL(tc.in)
			if tc.want == "" {
				if err != nil {
					t.Fatalf("ValidateURL(%q) = %v, want it accepted", tc.in, err)
				}
				return
			}
			var ue *URLError
			if !errors.As(err, &ue) || !errors.Is(err, ErrInvalidURL) {
				t.Fatalf("ValidateURL(%q) = %v, want a URLError", tc.in, err)
			}
			if ue.Reason != tc.want {
				t.Fatalf("ValidateURL(%q): reason %q, want %q", tc.in, ue.Reason, tc.want)
			}
			if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "example") {
				t.Fatalf("the error repeats the URL: %v", err)
			}
		})
	}
}

// Private hosts are accepted by ValidateURL and told apart by Inspect, in every form a browser reads.
func TestInspectPrivateHosts(t *testing.T) {
	tests := []struct {
		in      string
		host    string
		private bool
	}{
		{"http://localhost:3000/", "localhost", true},
		{"http://LOCALHOST./", "localhost", true},
		{"http://app.localhost/", "app.localhost", true},
		{"http://127.0.0.1:5173/", "127.0.0.1", true},
		{"http://127.1/", "127.0.0.1", true},
		{"http://2130706433/", "127.0.0.1", true},
		{"http://0x7f.1/", "127.0.0.1", true},
		{"http://0x7f000001/", "127.0.0.1", true},
		{"http://0177.0.0.1/", "127.0.0.1", true},
		{"http://0.0.0.0/", "0.0.0.0", true},
		{"http://0/", "0.0.0.0", true},
		{"http://[::1]/", "::1", true},
		{"http://[::ffff:127.0.0.1]/", "127.0.0.1", true},
		{"http://[::]/", "::", true},
		{"http://[fd00::1]/", "fd00::1", true},
		{"http://[fe80::1]/", "fe80::1", true},
		{"http://10.0.0.5/", "10.0.0.5", true},
		{"http://172.16.0.1/", "172.16.0.1", true},
		{"http://172.31.255.255/", "172.31.255.255", true},
		{"http://192.168.1.1/", "192.168.1.1", true},
		{"http://169.254.169.254/latest/meta-data", "169.254.169.254", true},
		{"http://100.64.0.1/", "100.64.0.1", true},
		{"http://198.18.0.1/", "198.18.0.1", true},
		{"http://224.0.0.1/", "224.0.0.1", true},
		{"http://nas/", "nas", true},
		{"http://homeassistant.local:8123/", "homeassistant.local", true},
		{"http://printer.lan/", "printer.lan", true},
		{"http://git.internal/", "git.internal", true},
		{"http://router.home.arpa/", "router.home.arpa", true},
		// public
		{"https://example.com/", "example.com", false},
		{"https://github.com/", "github.com", false},
		{"https://8.8.8.8/", "8.8.8.8", false},
		{"http://172.32.0.1/", "172.32.0.1", false},
		{"http://100.128.0.1/", "100.128.0.1", false},
		{"http://169.253.0.1/", "169.253.0.1", false},
		{"http://[2001:db8::1]/", "2001:db8::1", false},
		{"https://notlocal.example/", "notlocal.example", false},
		{"https://local.example.com/", "local.example.com", false},
		{"https://example.com.localhost.evil.org/", "example.com.localhost.evil.org", false},
		{"http://134744072/", "8.8.8.8", false},
		// IPv6 forms of a private IPv4 address (a stack that translates reaches the same machine)
		{"http://[::127.0.0.1]/", "::7f00:1", true},
		{"http://[::192.168.0.1]/", "::c0a8:1", true},
		{"http://[64:ff9b::7f00:1]/", "64:ff9b::7f00:1", true},
		{"http://[64:ff9b::a00:1]/", "64:ff9b::a00:1", true},
		{"http://[64:ff9b::a9fe:a9fe]/", "64:ff9b::a9fe:a9fe", true},
		{"http://[64:ff9b:1::1]/", "64:ff9b:1::1", true},
		{"http://[2002:7f00:1::]/", "2002:7f00:1::", true},
		{"http://[2002:c0a8:1::1]/", "2002:c0a8:1::1", true},
		{"http://[64:ff9b::808:808]/", "64:ff9b::808:808", false},
		{"http://[2002:808:808::]/", "2002:808:808::", false},
		{"http://[::8.8.8.8]/", "::808:808", false},
	}
	for _, tc := range tests {
		info, err := Inspect(tc.in)
		if err != nil {
			t.Errorf("Inspect(%q) = %v", tc.in, err)
			continue
		}
		if info.Host != tc.host || info.Private != tc.private {
			t.Errorf("Inspect(%q) = %+v, want host %q private %v", tc.in, info, tc.host, tc.private)
		}
	}
}

func TestDescribeKeepsNoSecrets(t *testing.T) {
	for in, want := range map[string]string{ //nolint:gosec // test data: URLs that must not leak
		"https://example.com/path?token=abc#frag": "https://example.com",
		"https://user:pw@example.com:8443/":       "https://example.com",
		"javascript:alert(1)":                     "javascript:[no host]",
		"%%%":                                     "[unparsable]",
	} {
		if got := describe(in); got != want {
			t.Errorf("describe(%q) = %q, want %q", in, got, want)
		}
	}
}

func FuzzInspect(f *testing.F) {
	for _, s := range []string{"https://example.com", "http://[::1]:80/", "http://0x7f.1", "javascript:alert(1)", "http://a@b/", ""} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		info, err := Inspect(s)
		if err != nil {
			return
		}
		// What is accepted is always http(s), with a host and no credentials, whatever the bytes.
		low := strings.ToLower(s)
		if !strings.HasPrefix(low, "http://") && !strings.HasPrefix(low, "https://") {
			t.Fatalf("accepted %q", s)
		}
		if info.Host == "" || strings.ContainsAny(s, " \t\r\n\\") {
			t.Fatalf("accepted %q with host %q", s, info.Host)
		}
	})
}

func TestInspectAuthority(t *testing.T) {
	for in, want := range map[string]string{
		"http://nas.local/":             "nas.local:80",
		"https://nas.local/":            "nas.local:443",
		"http://nas.local:8123/x":       "nas.local:8123",
		"HTTP://NAS.local:0080/":        "nas.local:80",
		"http://127.1:5173/":            "127.0.0.1:5173",
		"http://[::1]:8080/":            "[::1]:8080",
		"https://example.com:443/a?b=c": "example.com:443",
	} {
		info, err := Inspect(in)
		if err != nil || info.Authority != want {
			t.Errorf("Inspect(%q) = %+v, %v; want authority %q", in, info, err, want)
		}
	}
}
