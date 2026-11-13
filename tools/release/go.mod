// Module clarae/tools/release is the release helper (manifest generation, signing,
// verification). It is a nested module so it stays out of go.work and out of
// the pinned-tools module; run it with GOWORK=off (see `task release-tool`).
module clarae/tools/release

go 1.27.4

require clarae/shared v0.0.0

replace clarae/shared => ../../shared/go
