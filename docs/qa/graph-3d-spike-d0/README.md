# Misure grezze dello spike M18-D0 (grafo 3D)

Uscita delle misure fatte il 2026-11-15 con il prototipo usa-e-getta dello spike D0, prima di costruire la vista 3D ([ADR-0055](../../adr/0055-grafo-3d.md)). Il prototipo non è nel prodotto: questi file sono ciò che resta delle sue misure, conservati perché l'ADR e [`graph-3d-benchmark.md`](../graph-3d-benchmark.md) ne citano i numeri.

Ogni riga `BENCH` è un oggetto JSON: una dimensione del grafo sintetico, su Apple M4, in Chromium headless.

| File               | Backend WebGL           | Cosa confronta                                                                                               |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `bench-metal.txt`  | Metal (GPU)             | nodi come sprite o sfere; link di serie della libreria (`default`) o in un solo `LineSegments` (`merged`)    |
| `bench-metal2.txt` | Metal (GPU)             | nodi come punti, link in un solo `LineSegments`; le ultime quattro righe con le forze alleggerite del layout |
| `bench-sw.txt`     | SwiftShader (senza GPU) | le stesse configurazioni con il rasterizzatore software                                                      |

In tutte queste misure il layout girava sul thread principale, dentro la libreria: è la differenza principale rispetto alla vista costruita poi, che lo fa nel worker.
