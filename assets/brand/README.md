# Asset di branding

Tutto deriva da `assets/logo.png` (logo raster 1024 px con la scritta) e da due SVG disegnati a mano in
questa cartella. Lo script `scripts/brand/gen-brand-assets.py` rigenera gli altri file, che sono
committati: la build non lo esegue.

```sh
python3 -m venv .venv && .venv/bin/pip install pillow numpy   # serve anche rsvg-convert (brew install librsvg)
.venv/bin/python scripts/brand/gen-brand-assets.py
```

| Sorgente / output                                                              | Uso                                                                                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `assets/brand/icon.svg`                                                        | marchio vettoriale (tile + cervello), sorgente; copiato in `web/public/icon.svg` e `apps/desktop/build/linux/clarae.svg` |
| `assets/brand/safari-pinned-tab.svg`                                           | silhouette monocroma, sorgente; copiata in `web/public/`                                                                 |
| `assets/brand/icon-1024.png`                                                   | tile a tutto campo con angoli trasparenti (master per Windows, Linux, web)                                               |
| `assets/brand/icon-macos-1024.png`                                             | tile nella griglia macOS (margine + ombra), uguale a `apps/desktop/build/appicon.png`                                    |
| `assets/brand/social-preview.png`                                              | 1280×640, Open Graph / social preview del repository GitHub                                                              |
| `assets/readme-banner.png`                                                     | 1280×320, header del README                                                                                              |
| `web/public/favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`             | favicon (16/32/48 px resi dall'SVG, più nitidi a piccole dimensioni)                                                     |
| `web/public/apple-touch-icon.png`                                              | 180 px, quadrata opaca (iOS applica la maschera)                                                                         |
| `web/public/android-chrome-{192x192,512x512}.png`, `maskable-icon-512x512.png` | icone del `site.webmanifest`                                                                                             |
| `apps/desktop/build/appicon.png`                                               | Wails ne ricava `iconfile.icns` per il bundle macOS                                                                      |
| `apps/desktop/build/darwin/icon.icns`                                          | lo stesso set (16–1024 px, @1x/@2x) come file, per strumenti esterni                                                     |
| `apps/desktop/build/windows/icon.ico`                                          | 16–256 px, usato da `wails build` e dall'installer NSIS                                                                  |
| `apps/desktop/build/linux/clarae.{png,svg}`                                    | 512 px e scalabile, installati in `hicolor` dal .deb e nell'AppImage                                                     |

La social preview va caricata a mano in GitHub (Settings → General → Social preview).
