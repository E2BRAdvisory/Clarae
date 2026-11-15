// Stands in for `three/webgpu` in every build. three-render-objects imports WebGPURenderer for its
// `useWebGPU` option, which the 3D graph never sets: the real module would add the whole WebGPU/TSL
// build of three.js to the chunk.
export class WebGPURenderer {
  constructor() {
    throw new Error('WebGPU is not in this build');
  }
}
