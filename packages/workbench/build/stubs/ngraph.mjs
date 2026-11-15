// Stands in for ngraph.forcelayout and ngraph.graph in every build. The packages build their layout
// code with `new Function`, which the CSP (script-src 'self' 'wasm-unsafe-eval') forbids. 3d-force-graph
// reaches them only through forceEngine('ngraph'), which the 3D graph never selects: its layout runs
// on d3-force-3d in the layout worker.
export default function ngraphStub() {
  throw new Error('ngraph is not in this build: use the d3 force engine');
}
