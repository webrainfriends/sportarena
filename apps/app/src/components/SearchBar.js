import React from 'react';
import { View, TextInput, StyleSheet } from 'react-native';
import { useTheme } from '../theme';

export function SearchBar({ value, onChangeText, placeholder, accessibilityLabel }) {
  const { C } = useTheme();
  return (
    <View style={[s.wrap, { backgroundColor: C.paper, borderColor: C.border }]}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder ?? ''}
        placeholderTextColor={C.mute}
        style={[s.input, { color: C.ink }]}
        accessibilityLabel={accessibilityLabel ?? placeholder}
      />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 8 },
  input: { fontSize: 15 },
});
