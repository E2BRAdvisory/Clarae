import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { BYTE_UNITS, type ByteUnit } from './bytes';

export interface ByteFieldValue {
  value: string;
  unit: ByteUnit;
}

/** A size typed as number + unit (KB..TB); the label names the whole control. */
export function ByteField({
  label,
  hint,
  field,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  field: ByteFieldValue;
  onChange: (next: ByteFieldValue) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="nd-field">
      <label className="nd-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="nd-row">
        <input
          id={id}
          className="nd-input admin-bytes__value"
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
          value={field.value}
          onChange={(e) => onChange({ ...field, value: e.target.value })}
        />
        <select
          className="nd-select"
          aria-label={t('admin.unitOf', { label })}
          disabled={disabled}
          value={field.unit}
          onChange={(e) => onChange({ ...field, unit: e.target.value as ByteUnit })}
        >
          {BYTE_UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>
      {hint && (
        <span id={`${id}-hint`} className="nd-field__hint">
          {hint}
        </span>
      )}
    </div>
  );
}
