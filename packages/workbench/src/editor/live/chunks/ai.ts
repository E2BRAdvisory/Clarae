// The AI chunk (A-D6, A-D11): Crepe's AI feature with the diff and streaming plugins. Present and
// tested in A-W6; nothing imports it until then, and the core refuses to run while the `ai` flag is off.
// The providers of `@milkdown/crepe/llm-providers/*` call the network from the frontend and are
// forbidden: the model is reached through the core (`AIAPI`).
export { ai } from '@milkdown/crepe/feature/ai';
export { diff } from '@milkdown/kit/plugin/diff';
export { streaming } from '@milkdown/kit/plugin/streaming';
