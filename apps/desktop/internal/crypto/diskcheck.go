package crypto

import (
	"context"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// DiskEncryption is the best-effort answer to "is the system disk encrypted?"
// (§3.8.6): the vault copy and the local indexes are stored in clear and rely
// on full-disk encryption.
type DiskEncryption string

// Values.
const (
	DiskEncrypted   DiskEncryption = "encrypted"
	DiskUnencrypted DiskEncryption = "unencrypted"
	DiskUnknown     DiskEncryption = "unknown"
)

// CheckDiskEncryption asks the operating system (FileVault, BitLocker,
// dm-crypt) with a short timeout. Anything it cannot determine is "unknown".
func CheckDiskEncryption(ctx context.Context) DiskEncryption {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	switch runtime.GOOS {
	case "darwin":
		out, err := exec.CommandContext(ctx, "fdesetup", "status").CombinedOutput()
		if err != nil {
			return DiskUnknown
		}
		return parseFileVault(string(out))
	case "windows":
		// Shell property of the system drive: 1 = protection on, 0 = off.
		out, err := exec.CommandContext(ctx, "powershell", "-NoProfile", "-Command",
			`(New-Object -ComObject Shell.Application).NameSpace($env:SystemDrive).Self.ExtendedProperty('System.Volume.BitLockerProtection')`).CombinedOutput()
		if err != nil {
			return DiskUnknown
		}
		return parseBitLocker(string(out))
	case "linux":
		out, err := exec.CommandContext(ctx, "lsblk", "-o", "TYPE", "-n").CombinedOutput()
		if err != nil {
			return DiskUnknown
		}
		return parseLsblk(string(out))
	default:
		return DiskUnknown
	}
}

func parseFileVault(out string) DiskEncryption {
	switch {
	case strings.Contains(out, "FileVault is On"):
		return DiskEncrypted
	case strings.Contains(out, "FileVault is Off"):
		return DiskUnencrypted
	default:
		return DiskUnknown
	}
}

func parseBitLocker(out string) DiskEncryption {
	switch strings.TrimSpace(out) {
	case "1", "3", "5": // On, Encrypting, Suspended-but-encrypted
		return DiskEncrypted
	case "0":
		return DiskUnencrypted
	default:
		return DiskUnknown
	}
}

func parseLsblk(out string) DiskEncryption {
	if strings.TrimSpace(out) == "" {
		return DiskUnknown
	}
	for _, l := range strings.Fields(out) {
		if l == "crypt" {
			return DiskEncrypted
		}
	}
	return DiskUnencrypted
}
