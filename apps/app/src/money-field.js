import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Field, T } from './ui';
import { CurrencyDropdown } from './currency-dropdown';
import { parseAmount, toMajorText } from './money-core';
import { c } from './theme';

/**
 * Combined currency-amount field.
 * Props:
 *   value       – minor-unit integer (e.g. 1500 for £15.00)
 *   currency    – ISO 4217 code string
 *   onChangeValue(minor, currency) – fired when either changes
 *   label       – field label
 *   hint        – help text below
 */
export function CurrencyField({ value, currency, onChangeValue, label, hint }) {
  const [text, setText] = useState(() => (value != null && currency ? toMajorText(value, currency) : ''));

  useEffect(() => {
    if (value != null && currency) setText(toMajorText(value, currency));
  }, [value, currency]);

  function handleAmount(raw) {
    setText(raw);
    if (!currency) return;
    const minor = parseAmount(raw, currency);
    if (minor !== null) onChangeValue(minor, currency);
  }

  function handleCurrency(cur) {
    const minor = parseAmount(text, cur);
    onChangeValue(minor ?? 0, cur);
  }

  return (
    <View style={{ gap: 10 }}>
      {label ? <T weight="700" size={13}>{label}</T> : null}
      <CurrencyDropdown value={currency} onChange={handleCurrency} suggest />
      <Field
        value={text}
        onChangeText={handleAmount}
        keyboardType="decimal-pad"
        placeholder="0.00"
        accessibilityLabel={label ?? 'Amount'}
      />
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
    </View>
  );
}
