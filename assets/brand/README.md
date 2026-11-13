# Asset di branding

Il marchio di **Clarae notanda** è disegnato in vettoriale in questa cartella, a partire dalla tavola
`assets/clarae.png` (marchio, palette, wordmark). Lo script `scripts/brand/gen-brand-assets.py` rigenera
tutti gli altri file, che sono committati: la build non lo esegue.

```sh
python3 -m venv .venv && .venv/bin/pip install pillow   # serve anche rsvg-convert (brew install librsvg)
.venv/bin/python scripts/brand/gen-brand-assets.py      # --out <dir> scrive lo stesso albero altrove (anteprima)
```

Nome, payoff («Your knowledge, carefully preserved in its clarity.») e palette sono costanti in testa allo
script.

| Colore    | Valore    | Uso                     |
| --------- | --------- | ----------------------- |
| Deep Navy | `#102B3A` | identità, header, testi |
| Teal      | `#159992` | accenti e interazioni   |
| Mint      | `#72C9BD` | evidenziazioni          |
| Mist      | `#E9F0EF` | superfici e sfondi      |
| White     | `#FFFFFF` | spaziatura e contrasto  |

| Sorgente / output                                                              | Uso                                                                                                                                |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `assets/clarae.png`                                                            | tavola di brand da cui è ridisegnato il marchio (riferimento, non usata dallo script)                                              |
| `assets/brand/mark.svg`                                                        | marchio su fondo chiaro (Teal, Deep Navy, Mint), sorgente                                                                          |
| `assets/brand/mark-on-dark.svg`                                                | marchio su Deep Navy (White, Teal, Mint), sorgente; usato per i banner e le icone quadrate                                         |
| `assets/brand/icon.svg`                                                        | icona dell'app (marchio su riquadro Deep Navy), sorgente; copiata in `web/public/icon.svg` e `apps/desktop/build/linux/clarae.svg` |
| `assets/brand/safari-pinned-tab.svg`                                           | silhouette monocroma, sorgente; copiata in `web/public/`                                                                           |
| `assets/brand/icon-1024.png`                                                   | riquadro a tutto campo con angoli trasparenti (master per Windows, Linux, web)                                                     |
| `assets/brand/icon-macos-1024.png`                                             | riquadro nella griglia macOS (margine + ombra), uguale a `apps/desktop/build/appicon.png`                                          |
| `assets/brand/social-preview.png`                                              | 1280×640, Open Graph / social preview del repository GitHub                                                                        |
| `assets/readme-banner.png`                                                     | 1280×320, header del README                                                                                                        |
| `web/public/favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`             | favicon (16/32/48 px resi dall'SVG)                                                                                                |
| `web/public/apple-touch-icon.png`                                              | 180 px, quadrata opaca (iOS applica la maschera)                                                                                   |
| `web/public/android-chrome-{192x192,512x512}.png`, `maskable-icon-512x512.png` | icone del `site.webmanifest` (la maskable tiene il marchio nel cerchio centrale dell'80%)                                          |
| `web/public/site.webmanifest`                                                  | nome, payoff e colori del manifest                                                                                                 |
| `apps/desktop/build/appicon.png`                                               | icona macOS a 1024 px (riferimento: la build usa `darwin/icon.icns`)                                                               |
| `apps/desktop/build/darwin/icon.icns`                                          | 16–1024 px, @1x/@2x: `scripts/build-desktop-bin.sh` la copia in `Contents/Resources/iconfile.icns`                                 |
| `apps/desktop/build/windows/icon.ico`                                          | 16–256 px: risorse dell'exe (`wails3 generate syso`) e installer NSIS                                                              |
| `apps/desktop/build/linux/clarae.{png,svg}`                                    | 512 px e scalabile, installati in `hicolor` dal .deb e nell'AppImage                                                               |

Nell'interfaccia il marchio è il componente `BrandMark` di `@clarae/ui` (SVG inline, nessuna richiesta di rete).

La social preview va caricata a mano in GitHub (Settings → General → Social preview).
