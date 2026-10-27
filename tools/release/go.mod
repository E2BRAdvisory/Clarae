// Module nodus/tools/release is the release helper (manifest generation, signing,
// verification). It is a nested module so it stays out of go.work and out of
// the pinned-tools module; run it with GOWORK=off (see `make release-tool`).
module nodus/tools/release

go 1.26.0

require nodus/shared v0.0.0

replace nodus/shared => ../../shared/go
