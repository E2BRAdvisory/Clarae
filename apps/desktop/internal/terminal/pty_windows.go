//go:build windows

package terminal

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/windows"
)

// defaultShell is PowerShell 7 if it is installed, else Windows PowerShell, else %ComSpec% (cmd.exe).
func defaultShell() (Spec, error) {
	for _, name := range []string{"pwsh.exe", "powershell.exe"} {
		if p, err := exec.LookPath(name); err == nil {
			return Spec{Path: p, Args: []string{"-NoLogo"}}, nil
		}
	}
	if c := os.Getenv("ComSpec"); c != "" {
		return Spec{Path: c}, nil
	}
	if p, err := exec.LookPath("cmd.exe"); err == nil {
		return Spec{Path: p}, nil
	}
	return Spec{}, errors.New("no shell found (pwsh, powershell, %ComSpec%)")
}

func envNameEqual(a, b string) bool { return strings.EqualFold(a, b) }

// conPTY is a shell on a pseudo-console (ConPTY), inside a Job Object that kills what is in it when
// it is closed: nothing outlives the session, nor the application if it dies.
type conPTY struct {
	in      *os.File // the shell reads what is written here
	out     *os.File // the shell writes what is read here
	hpc     windows.Handle
	job     windows.Handle
	process windows.Handle

	closePC sync.Once
	gone    atomic.Bool
	closed  sync.Once
}

// jobAccounting is JOBOBJECT_BASIC_ACCOUNTING_INFORMATION (golang.org/x/sys/windows has no type for it).
type jobAccounting struct {
	TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime int64
	TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses     uint32
}

func startProc(spec Spec, cwd string, env []string, cols, rows int) (proc, error) {
	var inR, inW, outR, outW windows.Handle
	if err := windows.CreatePipe(&inR, &inW, nil, 0); err != nil {
		return nil, fmt.Errorf("input pipe: %w", err)
	}
	if err := windows.CreatePipe(&outR, &outW, nil, 0); err != nil {
		_ = windows.CloseHandle(inR)
		_ = windows.CloseHandle(inW)
		return nil, fmt.Errorf("output pipe: %w", err)
	}
	var hpc windows.Handle
	size := windows.Coord{X: int16(cols), Y: int16(rows)} //nolint:gosec // G115: clampSize bounds both to 1000
	err := windows.CreatePseudoConsole(size, inR, outW, 0, &hpc)
	// The pseudo-console has its own copies of the ends it uses.
	_ = windows.CloseHandle(inR)
	_ = windows.CloseHandle(outW)
	if err != nil {
		_ = windows.CloseHandle(inW)
		_ = windows.CloseHandle(outR)
		return nil, fmt.Errorf("pseudo-console: %w", err)
	}
	c := &conPTY{hpc: hpc}
	fail := func(err error) (proc, error) {
		c.closePseudoConsole()
		_ = windows.CloseHandle(inW)
		_ = windows.CloseHandle(outR)
		if c.job != 0 {
			_ = windows.CloseHandle(c.job)
		}
		return nil, err
	}

	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return fail(fmt.Errorf("job object: %w", err))
	}
	c.job = job
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil { //nolint:gosec // G103: SetInformationJobObject takes the address of the struct
		return fail(fmt.Errorf("job object limits: %w", err))
	}

	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return fail(fmt.Errorf("attribute list: %w", err))
	}
	defer attrs.Delete()
	// The attribute is the handle of the pseudo-console itself, not a pointer to it.
	if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, *(*unsafe.Pointer)(unsafe.Pointer(&hpc)), unsafe.Sizeof(hpc)); err != nil { //nolint:gosec // G103: the attribute is the handle itself, passed as the pointer-sized value the API wants
		return fail(fmt.Errorf("attribute list: %w", err))
	}

	appName, err := windows.UTF16PtrFromString(spec.Path)
	if err != nil {
		return fail(err)
	}
	cmdline, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(append([]string{spec.Path}, spec.Args...)))
	if err != nil {
		return fail(err)
	}
	dir, err := windows.UTF16PtrFromString(cwd)
	if err != nil {
		return fail(err)
	}
	block, err := envBlock(env)
	if err != nil {
		return fail(err)
	}
	var si windows.StartupInfoEx
	si.Cb = uint32(unsafe.Sizeof(si))
	si.ProcThreadAttributeList = attrs.List()
	var pi windows.ProcessInformation
	// Suspended, so that the shell is in the job before it can start anything of its own.
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_SUSPENDED)
	if err := windows.CreateProcess(appName, cmdline, nil, nil, false, flags, &block[0], dir, &si.StartupInfo, &pi); err != nil {
		return fail(fmt.Errorf("create process: %w", err))
	}
	defer func() { _ = windows.CloseHandle(pi.Thread) }()
	if err := windows.AssignProcessToJobObject(job, pi.Process); err != nil {
		_ = windows.TerminateProcess(pi.Process, 1)
		_ = windows.CloseHandle(pi.Process)
		return fail(fmt.Errorf("assign to job: %w", err))
	}
	if _, err := windows.ResumeThread(pi.Thread); err != nil {
		_ = windows.TerminateJobObject(job, 1)
		_ = windows.CloseHandle(pi.Process)
		return fail(fmt.Errorf("resume: %w", err))
	}
	c.process = pi.Process
	c.in = os.NewFile(uintptr(inW), "conpty-in")
	c.out = os.NewFile(uintptr(outR), "conpty-out")
	return c, nil
}

// envBlock is the environment as CreateProcess wants it: UTF-16 "k=v" entries, each ended by a NUL,
// and an empty one to end the block.
func envBlock(env []string) ([]uint16, error) {
	var b []uint16
	for _, kv := range env {
		u, err := windows.UTF16FromString(kv)
		if err != nil {
			return nil, err
		}
		b = append(b, u...)
	}
	return append(b, 0), nil
}

func (c *conPTY) Read(b []byte) (int, error)  { return c.out.Read(b) }
func (c *conPTY) Write(b []byte) (int, error) { return c.in.Write(b) }

func (c *conPTY) Resize(cols, rows int) error {
	return windows.ResizePseudoConsole(c.hpc, windows.Coord{X: int16(cols), Y: int16(rows)}) //nolint:gosec // G115: clampSize bounds both to 1000
}

// Wait waits for the shell, then closes the pseudo-console: what it still had to say is read before
// the output pipe ends.
func (c *conPTY) Wait() int {
	_, _ = windows.WaitForSingleObject(c.process, windows.INFINITE)
	var code uint32
	_ = windows.GetExitCodeProcess(c.process, &code)
	c.closePseudoConsole()
	return int(code) // an NTSTATUS exit status stays a large positive number on 64-bit
}

func (c *conPTY) closePseudoConsole() { c.closePC.Do(func() { windows.ClosePseudoConsole(c.hpc) }) }

// Hangup ends the job: Windows has no hang-up to ask politely with.
func (c *conPTY) Hangup() { c.Kill() }

func (c *conPTY) Kill() {
	if c.gone.Load() {
		return
	}
	_ = windows.TerminateJobObject(c.job, 1)
}

func (c *conPTY) Alive() bool {
	if c.gone.Load() {
		return false
	}
	var info jobAccounting
	err := windows.QueryInformationJobObject(c.job, windows.JobObjectBasicAccountingInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil) //nolint:gosec // G103: QueryInformationJobObject fills the struct whose address it is given
	if err == nil && info.ActiveProcesses > 0 {
		return true
	}
	c.gone.Store(true)
	return false
}

// Close closes the pseudo-console, the pipes and the job (which ends whatever is left in it).
func (c *conPTY) Close() error {
	c.closed.Do(func() {
		c.closePseudoConsole()
		_ = c.in.Close()
		_ = c.out.Close()
		_ = windows.CloseHandle(c.job)
		_ = windows.CloseHandle(c.process)
	})
	return nil
}
