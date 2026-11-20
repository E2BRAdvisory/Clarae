//go:build !js && !windows

package terminal

import (
	"errors"
	"os"
	"os/exec"
	"sync/atomic"
	"syscall"

	"github.com/creack/pty"
)

// defaultShell is the login shell of the user: $SHELL when it is an executable file, else the first
// of zsh, bash and sh that exists. It runs with -l, as the terminal of the system does.
func defaultShell() (Spec, error) {
	candidates := []string{os.Getenv("SHELL"), "/bin/zsh", "/bin/bash", "/bin/sh"}
	for _, c := range candidates {
		if c == "" || c[0] != '/' {
			continue
		}
		if fi, err := os.Stat(c); err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0o111 != 0 {
			return Spec{Path: c, Args: []string{"-l"}}, nil
		}
	}
	return Spec{}, errors.New("no shell found ($SHELL, zsh, bash, sh)")
}

func envNameEqual(a, b string) bool { return a == b }

// unixProc is a shell that leads its own session and process group, on a pseudo-terminal.
type unixProc struct {
	cmd  *exec.Cmd
	f    *os.File
	pid  int // also the id of the process group: the shell is its leader
	gone atomic.Bool
}

// startProc starts spec in cwd on a new pseudo-terminal. pty.Start gives the child a new session
// with the terminal as its controlling one (Setsid, Setctty), so its pid is also the id of a group
// of its own, and the group is what Hangup and Kill signal.
func startProc(spec Spec, cwd string, env []string, cols, rows int) (proc, error) {
	cmd := exec.Command(spec.Path, spec.Args...) //nolint:gosec // G204: the shell is the one the user or the system chose ($SHELL), the arguments are fixed
	cmd.Dir = cwd
	cmd.Env = env
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)}) //nolint:gosec // G115: clampSize bounds both to 1000
	if err != nil {
		return nil, err
	}
	return &unixProc{cmd: cmd, f: f, pid: cmd.Process.Pid}, nil
}

func (p *unixProc) Read(b []byte) (int, error)  { return p.f.Read(b) }
func (p *unixProc) Write(b []byte) (int, error) { return p.f.Write(b) }
func (p *unixProc) Close() error                { return p.f.Close() }

func (p *unixProc) Resize(cols, rows int) error {
	return pty.Setsize(p.f, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)}) //nolint:gosec // G115: clampSize bounds both to 1000
}

func (p *unixProc) Wait() int {
	_ = p.cmd.Wait()
	ps := p.cmd.ProcessState
	if ps == nil {
		return -1
	}
	if ws, ok := ps.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return 128 + int(ws.Signal())
	}
	return ps.ExitCode()
}

// Hangup sends SIGHUP to the process group of the shell, as the kernel does when a terminal is closed.
// An interactive shell passes it on to its jobs, which have groups of their own.
func (p *unixProc) Hangup() {
	if p.gone.Load() {
		return
	}
	_ = syscall.Kill(-p.pid, syscall.SIGHUP)
	_ = syscall.Kill(-p.pid, syscall.SIGCONT) // a stopped job would not hear the hang-up
}

// Kill ends the group of the shell and every other process of its session (jobs of an interactive
// shell are in groups of their own, and `nohup` ones ignore the hang-up): nothing a tab started
// outlives it.
func (p *unixProc) Kill() {
	if p.gone.Load() {
		return
	}
	_ = syscall.Kill(-p.pid, syscall.SIGKILL)
	for _, pid := range sessionMembers(p.pid) {
		if pid != p.pid && inSession(pid, p.pid) { // the number may have been reused since the list
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
}

// Alive reports whether the group or the session of the shell still has a process. Both ids stay
// reserved while a process holds them, so they cannot name an unrelated one; once nothing is left
// the answer stays no, because the numbers may be used again.
func (p *unixProc) Alive() bool {
	if p.gone.Load() {
		return false
	}
	err := syscall.Kill(-p.pid, 0)
	if err == nil || errors.Is(err, syscall.EPERM) || len(sessionMembers(p.pid)) > 0 {
		return true
	}
	p.gone.Store(true)
	return false
}
