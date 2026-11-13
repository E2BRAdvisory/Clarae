//go:build !js

package platform

import (
	"bufio"
	"database/sql"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// openWAL opens path the way store.Open does (WAL, one connection), keeping the connection idle
// like the pool of the application does.
func openWAL(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT OR REPLACE INTO t VALUES ('k', 'v')`); err != nil {
		t.Fatal(err)
	}
	return db
}

func assertNoSidecars(t *testing.T, path string) {
	t.Helper()
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if _, err := os.Stat(path + suffix); err == nil {
			t.Errorf("%s%s is still there", path, suffix)
		}
	}
}

func assertRow(t *testing.T, path string) {
	t.Helper()
	db := openWAL(t, path)
	defer func() { _ = db.Close() }()
	var v string
	if err := db.QueryRow(`SELECT v FROM t WHERE k = 'k'`).Scan(&v); err != nil || v != "v" {
		t.Fatalf("the row is gone: %q, %v", v, err)
	}
}

// The deduction the migration rests on: with another connection open (idle or not) the probe
// answers "in use"; with none, it folds the log into the file and removes it.
func TestQuiesceDatabaseWithAnotherConnectionInTheProcess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.db")
	other := openWAL(t, path) // the "old instance"
	if err := quiesceDatabase(path); !errors.Is(err, errInUse) {
		t.Fatalf("with a connection open: %v, want errInUse", err)
	}
	// The probe did not break the database of the other connection.
	if _, err := other.Exec(`INSERT OR REPLACE INTO t VALUES ('k', 'v')`); err != nil {
		t.Fatalf("the other connection can no longer write: %v", err)
	}
	if err := other.Close(); err != nil {
		t.Fatal(err)
	}
	if err := quiesceDatabase(path); err != nil {
		t.Fatalf("with no connection open: %v", err)
	}
	assertNoSidecars(t, path)
	assertRow(t, path)
}

// An application that stopped without closing the database (a crash) leaves its log behind: the
// probe recovers it into the file before the folder is moved.
func TestQuiesceDatabaseFoldsALeftoverLog(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.db")
	db := openWAL(t, path)
	if _, err := os.Stat(path + "-wal"); err != nil {
		t.Skipf("no log to leave behind on this platform: %v", err)
	}
	// Copy the files while the database is open: this is what a crash leaves on disk.
	crashed := filepath.Join(t.TempDir(), "app.db")
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if data, err := os.ReadFile(path + suffix); err == nil {
			if err := os.WriteFile(crashed+suffix, data, 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	_ = db.Close()
	if err := quiesceDatabase(crashed); err != nil {
		t.Fatalf("a leftover log: %v", err)
	}
	assertNoSidecars(t, crashed)
	assertRow(t, crashed)
}

func TestQuiesceDatabaseIsRepeatable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.db")
	if err := openWAL(t, path).Close(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := quiesceDatabase(path); err != nil {
			t.Fatalf("probe %d: %v", i, err)
		}
	}
	assertRow(t, path)
}

func TestQuiesceDatabaseNeverCreatesTheFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "absent.db")
	if err := quiesceDatabase(path); err == nil || errors.Is(err, errInUse) {
		t.Fatalf("a missing database: %v", err)
	}
	if _, err := os.Stat(path); err == nil {
		t.Fatal("the probe created the database")
	}
}

func TestQuiesceDatabaseOfSomethingThatIsNotADatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.db")
	if err := os.WriteFile(path, []byte("this is not a database file, it is just long enough to be read\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := quiesceDatabase(path); err == nil || errors.Is(err, errInUse) {
		t.Fatalf("a file that is not a database: %v", err)
	}
}

// helperEnv makes the test binary hold a database open instead of running the tests: the way to
// have another process (the 1.x application) with a connection to the database of the test.
const helperEnv = "CLARAE_TEST_HOLD_DB"

func TestMain(m *testing.M) {
	if path := os.Getenv(helperEnv); path != "" {
		holdDatabase(path)
		return
	}
	os.Exit(m.Run())
}

// holdDatabase opens the database, says "ready" on stdout and keeps the connection until stdin
// closes.
func holdDatabase(path string) {
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		os.Exit(2)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY, v TEXT)`); err != nil {
		os.Exit(3)
	}
	if _, err := db.Exec(`INSERT OR REPLACE INTO t VALUES ('k', 'v')`); err != nil {
		os.Exit(4)
	}
	_, _ = os.Stdout.WriteString("ready\n")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n') // until the parent closes the pipe
	_ = db.Close()
}

// The same as above with a real second process, which is what the old application is: the locks
// of SQLite between processes are the ones of the OS, those inside a process are its own.
func TestQuiesceDatabaseWithAnotherProcess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.db")
	cmd := exec.Command(os.Args[0], "-test.run=^$") //nolint:gosec // this test binary, run again as the helper
	cmd.Env = append(os.Environ(), helperEnv+"="+path)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := false
	t.Cleanup(func() {
		if !exited {
			_ = stdin.Close()
			_ = cmd.Wait()
		}
	})
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || line != "ready\n" {
		t.Fatalf("the helper did not start: %q, %v", line, err)
	}

	if err := quiesceDatabase(path); !errors.Is(err, errInUse) {
		t.Fatalf("with another process holding the database: %v, want errInUse", err)
	}

	_ = stdin.Close()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		exited = true
		if err != nil {
			t.Fatalf("the helper: %v", err)
		}
	case <-time.After(20 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("the helper did not exit")
	}
	if err := quiesceDatabase(path); err != nil {
		t.Fatalf("after the other process exited: %v", err)
	}
	assertNoSidecars(t, path)
	assertRow(t, path)
}
