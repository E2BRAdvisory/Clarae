//go:build js && wasm

package sqlitejs

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"sync/atomic"
	"syscall/js"
	"time"
)

const (
	bridgeName = "__memobrainSQLite"
	fetchBatch = 256
	maxSafeInt = 1 << 53 // integers beyond this cannot cross the boundary as a JS number
)

var memoryDBs atomic.Int64

func init() { sql.Register("sqlite", &drv{}) }

// call invokes a bridge method. A JavaScript exception (an SQL error, say) becomes a Go error.
func call(method string, args ...any) (res js.Value, err error) {
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(error); ok {
				err = e
			} else {
				err = fmt.Errorf("sqlitejs: %v", r)
			}
		}
	}()
	b := js.Global().Get(bridgeName)
	if b.IsUndefined() || b.IsNull() {
		return js.Value{}, errors.New("sqlitejs: bridge " + bridgeName + " is not installed")
	}
	return b.Call(method, args...), nil
}

// DeleteDatabase removes a database owned by the bridge. Files of the browser's SQLite VFS are not
// visible through the os package, so "rebuild index" needs this instead of os.Remove.
func DeleteDatabase(path string) error {
	_, err := call("deleteDatabase", path)
	return err
}

// Exists reports whether a database is stored under path.
func Exists(path string) (bool, error) {
	v, err := call("exists", path)
	if err != nil {
		return false, err
	}
	return v.Bool(), nil
}

type drv struct{}

func (*drv) Open(dsn string) (driver.Conn, error) {
	path, pragmas, err := parseDSN(dsn)
	if err != nil {
		return nil, err
	}
	if path == ":memory:" {
		// Every connection gets its own private database, as with modernc.org/sqlite.
		path = fmt.Sprintf(":memory:%d", memoryDBs.Add(1))
	}
	id, err := call("open", path)
	if err != nil {
		return nil, err
	}
	c := &conn{id: id.Int()}
	for _, p := range pragmas {
		if _, err := c.exec("PRAGMA "+p, nil); err != nil {
			_ = c.Close()
			return nil, fmt.Errorf("sqlitejs: PRAGMA %s: %w", p, err)
		}
	}
	return c, nil
}

type conn struct{ id int }

func (c *conn) Close() error {
	_, err := call("close", c.id)
	return err
}

func (c *conn) Prepare(query string) (driver.Stmt, error) { return &stmt{c: c, query: query}, nil }

func (c *conn) Begin() (driver.Tx, error) { return c.BeginTx(context.Background(), driver.TxOptions{}) }

func (c *conn) BeginTx(_ context.Context, opts driver.TxOptions) (driver.Tx, error) {
	if opts.ReadOnly {
		return nil, errors.New("sqlitejs: read-only transactions are not supported")
	}
	if _, err := c.exec("BEGIN", nil); err != nil {
		return nil, err
	}
	return &tx{c: c}, nil
}

func (c *conn) Ping(context.Context) error {
	_, err := c.exec("SELECT 1", nil)
	return err
}

func (c *conn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	return c.exec(query, args)
}

func (c *conn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	return c.query(query, args)
}

func (c *conn) exec(query string, args []driver.NamedValue) (driver.Result, error) {
	res, err := call("exec", c.id, query, params(args))
	if err != nil {
		return nil, err
	}
	return result{changes: int64(res.Get("changes").Int()), lastID: fromJSInt(res.Get("lastInsertId"))}, nil
}

func (c *conn) query(query string, args []driver.NamedValue) (driver.Rows, error) {
	res, err := call("query", c.id, query, params(args))
	if err != nil {
		return nil, err
	}
	cols, types := res.Get("columns"), res.Get("types")
	r := &rows{cursor: res.Get("cursor").Int(), cols: make([]string, cols.Length()), types: make([]string, cols.Length())}
	for i := range r.cols {
		r.cols[i] = cols.Index(i).String()
		if types.Type() == js.TypeObject && i < types.Length() {
			r.types[i] = types.Index(i).String()
		}
	}
	return r, nil
}

type tx struct{ c *conn }

func (t *tx) Commit() error   { _, err := t.c.exec("COMMIT", nil); return err }
func (t *tx) Rollback() error { _, err := t.c.exec("ROLLBACK", nil); return err }

type stmt struct {
	c     *conn
	query string
}

func (*stmt) Close() error  { return nil }
func (*stmt) NumInput() int { return -1 }

func (s *stmt) Exec(args []driver.Value) (driver.Result, error) {
	return s.c.exec(s.query, named(args))
}

func (s *stmt) Query(args []driver.Value) (driver.Rows, error) {
	return s.c.query(s.query, named(args))
}

func named(args []driver.Value) []driver.NamedValue {
	out := make([]driver.NamedValue, len(args))
	for i, a := range args {
		out[i] = driver.NamedValue{Ordinal: i + 1, Value: a}
	}
	return out
}

type result struct{ changes, lastID int64 }

func (r result) LastInsertId() (int64, error) { return r.lastID, nil }
func (r result) RowsAffected() (int64, error) { return r.changes, nil }

type rows struct {
	cursor int
	cols   []string
	types  []string // declared column types, used to read dates as time.Time
	batch  js.Value // array of rows fetched from the bridge
	pos    int
	done   bool
}

func (r *rows) Columns() []string { return r.cols }

// ColumnTypeDatabaseTypeName is the declared type of a column.
func (r *rows) ColumnTypeDatabaseTypeName(i int) string { return r.types[i] }

func (r *rows) Close() error {
	if r.done {
		return nil
	}
	r.done = true
	_, err := call("closeCursor", r.cursor)
	return err
}

func (r *rows) Next(dest []driver.Value) error {
	for r.batch.IsUndefined() || r.pos >= r.batch.Length() {
		if r.done {
			return io.EOF
		}
		res, err := call("fetch", r.cursor, fetchBatch)
		if err != nil {
			r.done = true
			return err
		}
		r.batch, r.pos = res.Get("rows"), 0
		if res.Get("done").Bool() {
			r.done = true // the bridge already released the statement
		}
		if r.batch.Length() == 0 {
			return io.EOF
		}
	}
	row := r.batch.Index(r.pos)
	r.pos++
	for i := range dest {
		dest[i] = fromJS(row.Index(i))
		if str, ok := dest[i].(string); ok && isTimeType(r.types[i]) {
			if t, ok := parseTime(str); ok {
				dest[i] = t
			}
		}
	}
	return nil
}

// params converts bound arguments to a JavaScript array.
func params(args []driver.NamedValue) js.Value {
	arr := js.Global().Get("Array").New(len(args))
	for i, a := range args {
		arr.SetIndex(i, toJS(a.Value))
	}
	return arr
}

func toJS(v driver.Value) js.Value {
	switch x := v.(type) {
	case nil:
		return js.Null()
	case int64:
		if x > maxSafeInt || x < -maxSafeInt {
			return js.Global().Call("BigInt", strconv.FormatInt(x, 10)) // a float64 would round it
		}
		return js.ValueOf(float64(x))
	case float64:
		return js.ValueOf(x)
	case bool:
		if x {
			return js.ValueOf(1)
		}
		return js.ValueOf(0)
	case string:
		return js.ValueOf(x)
	case []byte:
		b := js.Global().Get("Uint8Array").New(len(x))
		js.CopyBytesToJS(b, x)
		return b
	case time.Time:
		return js.ValueOf(x.Format(time.RFC3339Nano))
	default:
		return js.ValueOf(fmt.Sprint(x))
	}
}

func fromJS(v js.Value) driver.Value {
	switch v.Type() {
	case js.TypeNull, js.TypeUndefined:
		return nil
	case js.TypeNumber:
		f := v.Float()
		if f == math.Trunc(f) && math.Abs(f) <= maxSafeInt {
			return int64(f)
		}
		return f
	case js.TypeString:
		return v.String()
	case js.TypeBoolean:
		if v.Bool() {
			return int64(1)
		}
		return int64(0)
	case js.TypeObject:
		if i64 := v.Get("i64"); i64.Type() == js.TypeString {
			n, err := strconv.ParseInt(i64.String(), 10, 64)
			if err == nil {
				return n
			}
		}
		if v.InstanceOf(js.Global().Get("Uint8Array")) {
			b := make([]byte, v.Length())
			js.CopyBytesToGo(b, v)
			return b
		}
	}
	return v.String()
}

func fromJSInt(v js.Value) int64 {
	if d, ok := fromJS(v).(int64); ok {
		return d
	}
	return 0
}
