import { useTranslation } from 'react-i18next';
import { EmptyState } from '@nodus/ui';

/** Placeholder: the console arrives with M5; only users with the admin realm role reach it. */
export function AdminPage() {
  const { t } = useTranslation();
  return (
    <>
      <h1>{t('admin.title')}</h1>
      <EmptyState title={t('admin.title')}>{t('admin.soon')}</EmptyState>
    </>
  );
}
