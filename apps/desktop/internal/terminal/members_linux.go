//go:build linux

package terminal

import (
	"bytes"
	"os"
	"strconv"
)

// sessionMembers returns the pids of the live processes that belong to session sid: what the
// shell started, in its own process groups or not (a job of an interactive shell has a group of its
// own). Zombies are left out: they are dead, and wait for whoever has to collect them.
func sessionMembers(sid int) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var out []int
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		raw, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		// "pid (comm) state ppid pgrp session ...": comm may hold spaces and parentheses, so
		// the fields are counted from the last ')'.
		i := bytes.LastIndexByte(raw, ')')
		if i < 0 {
			continue
		}
		f := bytes.Fields(raw[i+1:])
		if len(f) < 4 || string(f[0]) == "Z" || string(f[0]) == "X" {
			continue
		}
		if s, err := strconv.Atoi(string(f[3])); err == nil && s == sid {
			out = append(out, pid)
		}
	}
	return out
}

// inSession tells whether pid still belongs to session sid (it may have ended, and its number been reused).
func inSession(pid, sid int) bool {
	for _, p := range sessionMembers(sid) {
		if p == pid {
			return true
		}
	}
	return false
}
