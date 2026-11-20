//go:build darwin

package terminal

import "golang.org/x/sys/unix"

// szomb is p_stat of a zombie in <sys/proc.h>.
const szomb = 5

// sessionMembers returns the pids of the live processes that belong to session sid: what the
// shell started, in its own process groups or not (a job of an interactive shell has a group of its
// own). Zombies are left out: they are dead, and wait for whoever has to collect them.
func sessionMembers(sid int) []int {
	procs, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil
	}
	var out []int
	for _, p := range procs {
		pid := int(p.Proc.P_pid)
		if p.Proc.P_stat == szomb || pid <= 0 {
			continue
		}
		if s, err := unix.Getsid(pid); err == nil && s == sid {
			out = append(out, pid)
		}
	}
	return out
}

// inSession tells whether pid still belongs to session sid (it may have ended, and its number been reused).
func inSession(pid, sid int) bool {
	s, err := unix.Getsid(pid)
	return err == nil && s == sid
}
