//go:build production

package app

// ContentSecurityPolicy for release builds (§3.7): no remote resources, no
// eval. 'wasm-unsafe-eval' is needed by the Argon2id WASM used for private
// vaults and 'unsafe-inline' for styles by CodeMirror/KaTeX computed styles
// (no custom CSS is ever loaded: D-01).
const ContentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self' 'wasm-unsafe-eval'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob:; " +
	"font-src 'self' data:; " +
	"connect-src 'self'; " +
	"media-src 'self' blob:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
