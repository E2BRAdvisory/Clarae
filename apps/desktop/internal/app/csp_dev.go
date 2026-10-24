//go:build !production

package app

// ContentSecurityPolicy for `wails dev`: Vite injects inline styles and uses a
// WebSocket for HMR, so the policy is relaxed. The production policy lives
// in csp_prod.go (SPIKE-05).
const ContentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' http://localhost:* http://127.0.0.1:* http://wails.localhost:*; " +
	"style-src 'self' 'unsafe-inline' http://localhost:* http://127.0.0.1:* http://wails.localhost:*; " +
	"img-src 'self' data: blob: http://localhost:* http://127.0.0.1:* http://wails.localhost:*; " +
	"font-src 'self' data:; " +
	"connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:* http://wails.localhost:* ws://wails.localhost:*; " +
	"media-src 'self' blob:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'"
