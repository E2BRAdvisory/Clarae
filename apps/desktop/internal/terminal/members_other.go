//go:build !js && !windows && !linux && !darwin

package terminal

// No way to list the processes of a session on this system: only the process group of the shell is
// signalled.
func sessionMembers(int) []int { return nil }

func inSession(int, int) bool { return false }
