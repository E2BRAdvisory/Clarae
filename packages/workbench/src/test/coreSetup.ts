// Setup of the tests on the Go core (vitest.core.config.ts): the core installs the bindings itself
// (test/wasmCore.ts), so the Wails mock of setup.ts is not installed.
import '@testing-library/jest-dom/vitest';
