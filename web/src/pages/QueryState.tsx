import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, InlineError } from '@memobrain/ui';
import { describeError } from '../api/errors';

/** Renders loading and error states of a query; children only see loaded data. */
export function QueryState<T>({
  query,
  children,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
}) {
  const { t } = useTranslation();
  if (query.isPending) return <p role="status">{t('app.loading')}</p>;
  if (query.isError) {
    return (
      <div>
        <InlineError>
          {t('errors.loadFailed')} {describeError(query.error, t)}
        </InlineError>
        <Button onClick={() => void query.refetch()}>{t('common.retry')}</Button>
      </div>
    );
  }
  return <>{children(query.data)}</>;
}
