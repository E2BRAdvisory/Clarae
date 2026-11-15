package webview

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"unicode"
)

// MaxURLBytes bounds the length of a URL (in bytes): a sanity limit, well above what a person types
// or an address book keeps, and a few times what an authorization redirect carries.
const MaxURLBytes = 16 << 10

// ErrInvalidURL is wrapped by every URLError.
var ErrInvalidURL = errors.New("invalid URL")

// BlockReason says why a URL, a navigation or a new window was refused. The values are stable:
// they go in the events of the UI.
type BlockReason string

// The reasons ValidateURL gives, and the two that only the policy of a view gives.
const (
	// BlockEmpty: nothing to open.
	BlockEmpty BlockReason = "empty"
	// BlockTooLong: more than MaxURLBytes.
	BlockTooLong BlockReason = "too-long"
	// BlockCharacters: a control, white space or invisible formatting character, or a backslash
	// (browsers read it as a slash, so two parsers would not agree on the host).
	BlockCharacters BlockReason = "characters"
	// BlockMalformed: the text does not parse as an absolute URL with an authority.
	BlockMalformed BlockReason = "malformed"
	// BlockScheme: not http or https.
	BlockScheme BlockReason = "scheme"
	// BlockCredentials: user:password@ in the URL.
	BlockCredentials BlockReason = "credentials"
	// BlockHost: no host, or a host no browser would accept.
	BlockHost BlockReason = "host"
	// BlockPort: a port outside 1..65535.
	BlockPort BlockReason = "port"
	// BlockPrivateNetwork: a page that was not opened on a private host tried to go to one (see Inspect).
	BlockPrivateNetwork BlockReason = "private-network"
	// BlockThrottled: the page asked for new windows faster than one a second.
	BlockThrottled BlockReason = "throttled"
	// BlockOther: the platform refused it for a reason of its own.
	BlockOther BlockReason = "other"
)

// URLError is the error of ValidateURL. It never carries the URL: a URL may hold a token.
type URLError struct {
	Reason BlockReason
}

func (e *URLError) Error() string { return "invalid URL: " + string(e.Reason) }

// Unwrap lets errors.Is(err, ErrInvalidURL) recognise it.
func (e *URLError) Unwrap() error { return ErrInvalidURL }

func refuse(r BlockReason) error { return &URLError{Reason: r} }

// URLInfo is what ValidateURL learned about an accepted URL.
type URLInfo struct {
	// Host is the host as the browser reads it: lower case, without the brackets of an IPv6
	// address or the dot that ends a name, and a numeric IPv4 form (2130706433, 0x7f.1, 0177.0.0.1)
	// written as the dotted quad it means.
	Host string
	// Authority is Host and the port (the default one of the scheme when the URL has none), "host:port";
	// an IPv6 address is in brackets. It is what the private hosts a user chose are told apart by.
	Authority string
	// Private: the host is the computer itself, a private network or a local name. See Inspect.
	Private bool
}

// ValidateURL accepts the URLs a guest may be pointed at: http and https, absolute, with a host, a
// valid port, and neither credentials nor control characters. Everything else is refused, whatever
// it is: clarae:, file:, wails:, javascript:, data:, blob:, about:, an unknown scheme, a URL with no
// authority (http:host). The same rule applies when a view is opened, when the UI navigates it, and
// to every navigation of the main frame that the page itself decides, redirects included.
//
// It says nothing about where the host is: Inspect does, and Manager uses it.
func ValidateURL(raw string) error {
	_, err := Inspect(raw)
	return err
}

// Inspect is ValidateURL that also classifies the host.
//
// Private hosts. A page that reaches http://localhost:port, an address of the local network or a
// link-local one (the cloud metadata address 169.254.169.254 among them) talks to services that were
// never meant for the web: the dev server of this application, the loopback listener of the sign-in
// (internal/auth, D-08), a router, a database console. So the rule of Manager is: the URL the user
// registers, or navigates to, may be private (a self-hosted tool is the point of an application);
// but a page that was not opened on a private host cannot take the view there by itself, by a link,
// a script or a redirect. Inspect only tells the two apart. A numeric host in any of the forms a
// browser accepts is read the way the browser reads it, so 2130706433 and 0x7f.1 are 127.0.0.1;
// names are not resolved (a name that points at a private address is not recognised: that is DNS
// rebinding, which this check does not claim to stop), but localhost, *.localhost, *.local, *.lan,
// *.internal, *.home.arpa and a name with a single label are private.
func Inspect(raw string) (URLInfo, error) {
	if raw == "" {
		return URLInfo{}, refuse(BlockEmpty)
	}
	if len(raw) > MaxURLBytes {
		return URLInfo{}, refuse(BlockTooLong)
	}
	for _, r := range raw {
		if r == '\\' || r == unicode.ReplacementChar || unicode.IsControl(r) || unicode.IsSpace(r) || unicode.Is(unicode.Cf, r) {
			return URLInfo{}, refuse(BlockCharacters)
		}
	}
	u, err := url.Parse(raw)
	if err != nil {
		return URLInfo{}, refuse(BlockMalformed)
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
	case "":
		return URLInfo{}, refuse(BlockMalformed)
	default:
		return URLInfo{}, refuse(BlockScheme)
	}
	if u.Opaque != "" {
		return URLInfo{}, refuse(BlockMalformed)
	}
	if u.User != nil {
		return URLInfo{}, refuse(BlockCredentials)
	}
	if p := u.Port(); p != "" {
		if n, err := strconv.Atoi(p); err != nil || n < 1 || n > 65535 {
			return URLInfo{}, refuse(BlockPort)
		}
	}
	host, private, ok := classifyHost(u.Hostname())
	if !ok {
		return URLInfo{}, refuse(BlockHost)
	}
	port := u.Port()
	if port == "" {
		port = "80"
		if strings.EqualFold(u.Scheme, "https") {
			port = "443"
		}
	}
	port = strings.TrimLeft(port, "0") // 0080 is 80
	return URLInfo{Host: host, Authority: net.JoinHostPort(host, port), Private: private}, nil
}

// classifyHost reads a host the way a browser does (the URL standard) and says whether it is
// private. ok is false for a host the browser would refuse.
func classifyHost(h string) (host string, private, ok bool) {
	if h == "" || strings.Contains(h, "%") {
		return "", false, false
	}
	if strings.Contains(h, ":") { // an IPv6 address (Hostname strips the brackets)
		ip, err := netip.ParseAddr(h)
		if err != nil || !ip.Is6() {
			return "", false, false
		}
		ip = ip.Unmap()
		return ip.String(), privateAddr(ip), true
	}
	h = strings.ToLower(h)
	h = strings.TrimSuffix(h, ".") // "localhost." is localhost
	if h == "" || strings.HasPrefix(h, ".") || strings.Contains(h, "..") {
		return "", false, false
	}
	if endsInNumber(h) {
		ip, ok := parseIPv4(h)
		if !ok {
			return "", false, false
		}
		return ip.String(), privateAddr(ip), true
	}
	return h, privateName(h), true
}

// endsInNumber is the check of the URL standard that sends a host to the IPv4 parser: its last label
// is all digits, or 0x followed by hex digits.
func endsInNumber(h string) bool {
	last := h
	if i := strings.LastIndexByte(h, '.'); i >= 0 {
		last = h[i+1:]
	}
	if last == "" {
		return false
	}
	if allDigits(last, 10) {
		return true
	}
	if len(last) >= 2 && (last[:2] == "0x" || last[:2] == "0X") {
		return allDigits(last[2:], 16)
	}
	return false
}

func allDigits(s string, base int) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
		case base == 16 && (c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'):
		default:
			return false
		}
	}
	return true
}

// parseIPv4 is the IPv4 parser of the URL standard: one to four parts, each decimal, octal (leading
// 0) or hex (0x), the last one filling the bytes that are left.
func parseIPv4(h string) (netip.Addr, bool) {
	parts := strings.Split(h, ".")
	if len(parts) > 4 {
		return netip.Addr{}, false
	}
	nums := make([]uint64, len(parts))
	for i, p := range parts {
		n, ok := parseIPv4Number(p)
		if !ok {
			return netip.Addr{}, false
		}
		nums[i] = n
	}
	for _, n := range nums[:len(nums)-1] {
		if n > 255 {
			return netip.Addr{}, false
		}
	}
	last := nums[len(nums)-1]
	if last >= 1<<(8*(5-uint(len(nums)))) {
		return netip.Addr{}, false
	}
	v := last
	for i, n := range nums[:len(nums)-1] {
		v += n << (8 * (3 - uint(i)))
	}
	return netip.AddrFrom4([4]byte{byte(v >> 24 & 0xff), byte(v >> 16 & 0xff), byte(v >> 8 & 0xff), byte(v & 0xff)}), true
}

func parseIPv4Number(s string) (uint64, bool) {
	if s == "" {
		return 0, false
	}
	base := 10
	switch {
	case len(s) >= 2 && (s[:2] == "0x" || s[:2] == "0X"):
		s, base = s[2:], 16
	case len(s) >= 2 && s[0] == '0':
		s, base = s[1:], 8
	}
	if s == "" {
		return 0, true
	}
	if !allDigits(s, base) || (base == 8 && strings.ContainsAny(s, "89")) {
		return 0, false
	}
	n, err := strconv.ParseUint(s, base, 64)
	return n, err == nil
}

var cgnat = netip.MustParsePrefix("100.64.0.0/10")
var benchmark = netip.MustParsePrefix("198.18.0.0/15")
var thisNetwork = netip.MustParsePrefix("0.0.0.0/8")

// privateAddr: loopback, the unspecified address, private ranges (RFC 1918, unique local), link
// local, shared address space (CGNAT, where VPN overlays live), multicast.
func privateAddr(ip netip.Addr) bool {
	ip = ip.Unmap()
	if v4, ok := embeddedIPv4(ip); ok && privateAddr(v4) {
		return true // an IPv6 form of a private IPv4 address reaches the same machine
	}
	if nat64Local.Contains(ip) {
		return true
	}
	return ip.IsLoopback() || ip.IsUnspecified() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() || ip.IsMulticast() ||
		cgnat.Contains(ip) || benchmark.Contains(ip) || thisNetwork.Contains(ip)
}

var (
	nat64Local = netip.MustParsePrefix("64:ff9b:1::/48") // local-use NAT64 (RFC 8215)
	nat64      = netip.MustParsePrefix("64:ff9b::/96")   // NAT64 (RFC 6052)
	sixToFour  = netip.MustParsePrefix("2002::/16")      // 6to4: the IPv4 address is bits 16 to 48
	v4Compat   = netip.MustParsePrefix("::/96")          // IPv4-compatible (deprecated, still parsed)
)

// embeddedIPv4 returns the IPv4 address that an IPv6 address of one of the translation forms carries
// (IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::a.b.c.d, 6to4 2002:ab:cd::): a stack that translates
// reaches that machine, so the check of a private host looks at it too.
func embeddedIPv4(ip netip.Addr) (netip.Addr, bool) {
	if !ip.Is6() || ip.Is4In6() {
		return netip.Addr{}, false
	}
	b := ip.As16()
	switch {
	case v4Compat.Contains(ip), nat64.Contains(ip):
		return netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}), true
	case sixToFour.Contains(ip):
		return netip.AddrFrom4([4]byte{b[2], b[3], b[4], b[5]}), true
	}
	return netip.Addr{}, false
}

// privateName: a name that only means something on the local machine or network.
func privateName(h string) bool {
	if !strings.Contains(h, ".") {
		return true // "localhost", "nas", "homeassistant"
	}
	for _, suffix := range []string{".localhost", ".local", ".lan", ".internal", ".home.arpa", ".localdomain"} {
		if strings.HasSuffix(h, suffix) {
			return true
		}
	}
	return false
}

// describe gives a URL for a log line: scheme and host only, a URL may hold a token.
func describe(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return "[unparsable]"
	}
	if u.Host == "" {
		return u.Scheme + ":[no host]"
	}
	return fmt.Sprintf("%s://%s", strings.ToLower(u.Scheme), u.Hostname())
}
