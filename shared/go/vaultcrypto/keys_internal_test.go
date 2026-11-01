package vaultcrypto

import (
	"testing"
	"time"
)

// TestCalibrateCeiling checks kdf-calibration-weakest-client: however fast
// the device, calibration stops at MaxCalibratedMKiB (what single-threaded
// WebAssembly can still derive), and a slow device stays at the minimum.
func TestCalibrateCeiling(t *testing.T) {
	var runs []uint32
	fast := calibrate(time.Hour, func(p KDFParams, _ []byte) { runs = append(runs, p.MKiB) })
	if fast.MKiB != MaxCalibratedMKiB || fast.T != MinT || fast.P != MinP {
		t.Fatalf("fast device: %+v, want m=%d", fast, MaxCalibratedMKiB)
	}
	for _, m := range runs {
		if m >= MaxCalibratedMKiB {
			t.Fatalf("calibration ran a derivation at %d KiB", m)
		}
	}
	if len(runs) != 2 { // 64 and 128 MiB, then 256 MiB is the ceiling
		t.Fatalf("calibration runs %v", runs)
	}
	slow := calibrate(0, func(KDFParams, []byte) {})
	if slow.MKiB != MinMKiB {
		t.Fatalf("slow device: m=%d, want the minimum", slow.MKiB)
	}
	if MaxCalibratedMKiB > maxMKiB || MaxCalibratedMKiB < MinMKiB {
		t.Fatal("ceiling outside the accepted range")
	}
}
