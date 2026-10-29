import { afterEach, describe, expect, it } from 'vitest';
import { drawingFeatureOn, useManaged } from '../state/managed';
import { featureOfCommand } from './sceneCommands';

const setFeatures = (features: Record<string, boolean>) => useManaged.setState({ features });

describe('drawing sub-flags', () => {
  afterEach(() => setFeatures({}));

  it('are on unless the configuration switches them off', () => {
    expect(drawingFeatureOn('drawing_latex')).toBe(true);
    setFeatures({ drawing_latex: false });
    expect(drawingFeatureOn('drawing_latex')).toBe(false);
    expect(drawingFeatureOn('drawing_mermaid')).toBe(true);
    expect(drawingFeatureOn()).toBe(true);
  });

  it('do nothing while drawings itself is off', () => {
    setFeatures({ drawings: false });
    expect(drawingFeatureOn()).toBe(false);
    expect(drawingFeatureOn('drawing_actions')).toBe(false);
  });

  it('map each command to the flag that hides it', () => {
    expect(featureOfCommand('drawing:insert-latex')).toBe('drawing_latex');
    expect(featureOfCommand('drawing:edit-latex')).toBe('drawing_latex');
    expect(featureOfCommand('drawing:insert-mermaid')).toBe('drawing_mermaid');
    expect(featureOfCommand('drawing:set-auto-export')).toBe('drawing_auto_export');
    expect(featureOfCommand('drawing:auto-layout')).toBe('drawing_actions');
    expect(featureOfCommand('drawing:create-note-and-embed')).toBe('drawing_actions');
    expect(featureOfCommand('drawing:insert-image')).toBeUndefined();
  });
});
