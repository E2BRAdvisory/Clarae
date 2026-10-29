import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatBar } from './ChatBar';
import { initI18n } from '../i18n';
import { unmanaged, useManaged } from '../state/managed';

describe('chat slot', () => {
  initI18n('en');

  it('is hidden unless the configuration profile switches the chat feature on', () => {
    useManaged.setState({ ...unmanaged, features: {} });
    const { container, rerender } = render(<ChatBar />);
    expect(container).toBeEmptyDOMElement();
    useManaged.setState({ features: { chat: false } });
    rerender(<ChatBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is a disabled field with an explanation when the feature is on', () => {
    useManaged.setState({ ...unmanaged, features: { chat: true } });
    render(<ChatBar />);
    expect(screen.getByRole('textbox', { name: 'Ask a model…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('form', { name: 'Chat with a model' })).toHaveAttribute(
      'title',
      'Chat with models (ACP) is not available yet.',
    );
  });
});
