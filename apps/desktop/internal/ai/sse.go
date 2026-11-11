package ai

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strings"
)

// The limits that keep a hostile or broken server from exhausting the memory of the app: the length
// of one line of the stream, and the bytes read from one response in all.
const (
	maxSSELine    = 1 << 20
	maxStreamSize = 16 << 20
)

var errSSELineTooLong = errors.New("the provider sent a line of the stream that is too long")

// readSSE calls fn with the payload of every `data:` line of a server-sent events stream (the format
// OpenAI and Anthropic stream in), in order, and stops when fn returns stop or an error, or when
// the stream ends. It ignores `event:`, `id:`, `retry:` and comment lines. Whitespace inside a
// payload is kept: it is part of the text being streamed.
func readSSE(r io.Reader, fn func(payload string) (stop bool, err error)) error {
	br := bufio.NewReaderSize(&limitReader{r: r, left: maxStreamSize}, 32<<10)
	for {
		line, err := readLine(br, maxSSELine)
		if payload, ok := dataOf(line); ok {
			if stop, ferr := fn(payload); ferr != nil || stop {
				return ferr
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// dataOf returns the payload of a `data:` line (without the one space that may follow the colon).
func dataOf(line string) (string, bool) {
	if rest, ok := strings.CutPrefix(line, "data:"); ok {
		return strings.TrimPrefix(rest, " "), true
	}
	return "", false
}

// readLine reads one line without its end of line (LF or CRLF). The last line of a stream that ends
// without a newline comes back with io.EOF. A line longer than limit is an error: the reader never
// holds more than limit bytes of it.
func readLine(br *bufio.Reader, limit int) (string, error) {
	var line []byte
	for {
		chunk, err := br.ReadSlice('\n')
		line = append(line, chunk...)
		if len(line) > limit {
			return "", errSSELineTooLong
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		s := strings.TrimSuffix(string(line), "\n")
		s = strings.TrimSuffix(s, "\r")
		return s, err
	}
}

// limitReader fails with ErrTooLarge once more than left bytes were read (io.LimitReader would end
// the stream quietly, and a truncated answer would pass for a complete one).
type limitReader struct {
	r    io.Reader
	left int64
}

func (l *limitReader) Read(p []byte) (int, error) {
	if l.left <= 0 {
		return 0, fmt.Errorf("%w: the provider's response exceeds %d bytes", ErrTooLarge, int64(maxStreamSize))
	}
	if int64(len(p)) > l.left {
		p = p[:l.left]
	}
	n, err := l.r.Read(p)
	l.left -= int64(n)
	return n, err
}
