import { useTranslation } from 'react-i18next';
import { Feature } from '@memobrain/api-client/features';
import { featureOn, useManaged } from '../state/managed';
import { Icon } from './icons';

/**
 * Slot for the chat with models through ACP (ADR-0026). Nothing behind it yet: the field is
 * disabled, and the slot only shows when the configuration profile switches the `chat` feature on
 * (it is off by default). The protocol will come with its own ADR.
 */
export function ChatBar() {
  const { t } = useTranslation();
  // Off unless a profile switches it on (the schema's default).
  const on = useManaged((m) => featureOn(m.features, Feature.Chat));
  if (!on) return null;
  return (
    <form
      className="chat-bar"
      aria-label={t('chat.label')}
      title={t('chat.comingSoon')}
      onSubmit={(e) => e.preventDefault()}
    >
      <input
        type="text"
        disabled
        placeholder={t('chat.placeholder')}
        aria-label={t('chat.placeholder')}
      />
      <button type="submit" disabled aria-label={t('chat.send')}>
        <Icon name="enter" />
      </button>
    </form>
  );
}
