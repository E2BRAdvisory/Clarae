// Package templates implements note templates (variable expansion, template
// listing), daily-note and unique-note naming. Date formats follow the Moment.js
// token syntax Obsidian uses; only the common subset below is supported:
//
//	YYYY YY          year (4 / 2 digits)
//	Q                quarter
//	MMMM MMM MM M    month (name, short name, 2 digits, 1 digit)
//	DD D Do          day of month (2 digits, 1 digit, ordinal: 1st, 2nd)
//	dddd ddd d       weekday (name, short name, number 0-6, Sunday = 0)
//	HH H hh h        hour (24h, 12h; 2 digits / 1 digit)
//	mm m ss s        minute, second
//	A a              AM/PM, am/pm
//	X x              Unix seconds / milliseconds
//	Z ZZ             UTC offset (+01:00 / +0100)
//	[text]           literal text
//
// Any other character is copied as is (separators, '/', '-', ...). Names are
// available in English and Italian ("en", "it"); anything else falls back to English.
package templates

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// tokens are matched longest first at every position of the layout.
var tokens = []string{
	"YYYY", "MMMM", "dddd",
	"MMM", "ddd", "Do", "DD", "HH", "hh", "mm", "ss", "MM", "YY", "ZZ",
	"M", "D", "d", "H", "h", "m", "s", "A", "a", "Q", "X", "x", "Z",
}

type part struct {
	token   string // "" for a literal
	literal string
}

// tokenize splits a layout into tokens and literals.
func tokenize(layout string) []part {
	var out []part
	var lit strings.Builder
	flush := func() {
		if lit.Len() > 0 {
			out = append(out, part{literal: lit.String()})
			lit.Reset()
		}
	}
	// Once a '[' finds no ']' after it, no later one can: stop searching (an unclosed '[' per
	// character would otherwise scan the rest of the layout each time).
	unclosed := false
	for i := 0; i < len(layout); {
		if layout[i] == '[' && !unclosed {
			if end := strings.IndexByte(layout[i+1:], ']'); end >= 0 {
				lit.WriteString(layout[i+1 : i+1+end])
				i += end + 2
				continue
			}
			unclosed = true
		}
		matched := false
		for _, tok := range tokens {
			if strings.HasPrefix(layout[i:], tok) {
				flush()
				out = append(out, part{token: tok})
				i += len(tok)
				matched = true
				break
			}
		}
		if !matched {
			// Copy one whole rune so multibyte literals survive (an invalid byte becomes U+FFFD).
			r, size := utf8.DecodeRuneInString(layout[i:])
			lit.WriteRune(r)
			i += size
		}
	}
	flush()
	return out
}

type nameSet struct{ months, shortMonths, days, shortDays []string }

var names = map[string]nameSet{
	"en": {
		months:      []string{"January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"},
		shortMonths: []string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"},
		days:        []string{"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"},
		shortDays:   []string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"},
	},
	"it": {
		months:      []string{"gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"},
		shortMonths: []string{"gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"},
		days:        []string{"domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"},
		shortDays:   []string{"dom", "lun", "mar", "mer", "gio", "ven", "sab"},
	},
}

func namesFor(lang string) nameSet {
	if n, ok := names[strings.ToLower(lang)]; ok {
		return n
	}
	return names["en"]
}

func pad(n, width int) string { return fmt.Sprintf("%0*d", width, n) }

func ordinal(n int) string {
	suffix := "th"
	if n%100 < 11 || n%100 > 13 {
		switch n % 10 {
		case 1:
			suffix = "st"
		case 2:
			suffix = "nd"
		case 3:
			suffix = "rd"
		}
	}
	return strconv.Itoa(n) + suffix
}

func ampm(t time.Time, upper bool) string {
	s := "am"
	if t.Hour() >= 12 {
		s = "pm"
	}
	if upper {
		return strings.ToUpper(s)
	}
	return s
}

// FormatDate renders t with a Moment-style layout. An empty layout yields "".
func FormatDate(t time.Time, layout, lang string) string {
	nm := namesFor(lang)
	var b strings.Builder
	for _, p := range tokenize(layout) {
		if p.token == "" {
			b.WriteString(p.literal)
			continue
		}
		h12 := t.Hour() % 12
		if h12 == 0 {
			h12 = 12
		}
		switch p.token {
		case "YYYY":
			b.WriteString(pad(t.Year(), 4))
		case "YY":
			b.WriteString(pad(t.Year()%100, 2))
		case "Q":
			b.WriteString(strconv.Itoa((int(t.Month())-1)/3 + 1))
		case "MMMM":
			b.WriteString(nm.months[t.Month()-1])
		case "MMM":
			b.WriteString(nm.shortMonths[t.Month()-1])
		case "MM":
			b.WriteString(pad(int(t.Month()), 2))
		case "M":
			b.WriteString(strconv.Itoa(int(t.Month())))
		case "DD":
			b.WriteString(pad(t.Day(), 2))
		case "D":
			b.WriteString(strconv.Itoa(t.Day()))
		case "Do":
			b.WriteString(ordinal(t.Day()))
		case "dddd":
			b.WriteString(nm.days[t.Weekday()])
		case "ddd":
			b.WriteString(nm.shortDays[t.Weekday()])
		case "d":
			b.WriteString(strconv.Itoa(int(t.Weekday())))
		case "HH":
			b.WriteString(pad(t.Hour(), 2))
		case "H":
			b.WriteString(strconv.Itoa(t.Hour()))
		case "hh":
			b.WriteString(pad(h12, 2))
		case "h":
			b.WriteString(strconv.Itoa(h12))
		case "mm":
			b.WriteString(pad(t.Minute(), 2))
		case "m":
			b.WriteString(strconv.Itoa(t.Minute()))
		case "ss":
			b.WriteString(pad(t.Second(), 2))
		case "s":
			b.WriteString(strconv.Itoa(t.Second()))
		case "A":
			b.WriteString(ampm(t, true))
		case "a":
			b.WriteString(ampm(t, false))
		case "X":
			b.WriteString(strconv.FormatInt(t.Unix(), 10))
		case "x":
			b.WriteString(strconv.FormatInt(t.UnixMilli(), 10))
		case "Z":
			b.WriteString(t.Format("-07:00"))
		case "ZZ":
			b.WriteString(t.Format("-0700"))
		}
	}
	return b.String()
}

// ParseDate reads a date written with layout (the inverse of FormatDate for the
// date tokens YYYY, YY, MMMM, MMM, MM, M, DD, D, Do; weekday tokens are skipped,
// time tokens make the layout unparseable). It reports false when s does not
// match the layout. The result is midnight of that day in loc.
func ParseDate(s, layout, lang string, loc *time.Location) (time.Time, bool) {
	nm := namesFor(lang)
	year, month, day := -1, -1, -1
	rest := s
	digits := func(min, max int) (int, bool) {
		n := 0
		for n < len(rest) && n < max && rest[n] >= '0' && rest[n] <= '9' {
			n++
		}
		if n < min {
			return 0, false
		}
		v, _ := strconv.Atoi(rest[:n])
		rest = rest[n:]
		return v, true
	}
	name := func(list []string) (int, bool) {
		best, bestLen := -1, 0
		for i, nme := range list {
			if len(nme) > bestLen && len(rest) >= len(nme) && strings.EqualFold(rest[:len(nme)], nme) {
				best, bestLen = i, len(nme)
			}
		}
		if best < 0 {
			return 0, false
		}
		rest = rest[bestLen:]
		return best, true
	}
	var ok bool
	for _, p := range tokenize(layout) {
		if p.token == "" {
			if !strings.HasPrefix(rest, p.literal) {
				return time.Time{}, false
			}
			rest = rest[len(p.literal):]
			continue
		}
		switch p.token {
		case "YYYY":
			year, ok = digits(4, 4)
		case "YY":
			year, ok = digits(2, 2)
			year += 2000
		case "MM":
			month, ok = digits(2, 2)
		case "M":
			month, ok = digits(1, 2)
		case "DD":
			day, ok = digits(2, 2)
		case "D":
			day, ok = digits(1, 2)
		case "Do":
			day, ok = digits(1, 2)
			if ok && len(rest) >= 2 {
				rest = rest[2:]
			}
		case "MMMM":
			month, ok = name(nm.months)
			month++
		case "MMM":
			month, ok = name(nm.shortMonths)
			month++
		case "dddd":
			_, ok = name(nm.days)
		case "ddd":
			_, ok = name(nm.shortDays)
		case "d":
			_, ok = digits(1, 1)
		default:
			return time.Time{}, false // time-of-day and other tokens cannot name a day
		}
		if !ok {
			return time.Time{}, false
		}
	}
	if rest != "" || year < 0 || month < 1 || month > 12 || day < 1 || day > 31 {
		return time.Time{}, false
	}
	t := time.Date(year, time.Month(month), day, 0, 0, 0, 0, loc)
	if t.Day() != day { // 31 February and the like
		return time.Time{}, false
	}
	return t, true
}
