import type { EventStatus } from '@lsp/shared';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { theme } from './config';

export function Button({
  title,
  onPress,
  variant = 'primary',
  loading,
  disabled,
  style,
  accessibilityLabel,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'live' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  accessibilityLabel?: string;
}) {
  const bg = { primary: theme.brand, secondary: theme.surface2, live: theme.live, danger: theme.danger }[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.85 : 1 }, style]}
    >
      {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{title}</Text>}
    </Pressable>
  );
}

export function RoundButton({
  label,
  icon,
  onPress,
  active = true,
  disabled,
}: {
  label: string;
  icon: string;
  onPress: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.round,
        { backgroundColor: active ? 'rgba(255,255,255,0.12)' : theme.danger, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 },
      ]}
    >
      <Text style={{ fontSize: 20 }}>{icon}</Text>
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const { label, ...rest } = props;
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput placeholderTextColor={theme.muted} style={styles.input} accessibilityLabel={label} {...rest} />
    </View>
  );
}

export function StatusBadge({ status }: { status: EventStatus }) {
  const live = status === 'LIVE';
  const label = status === 'READY' ? 'STARTING SOON' : status;
  return (
    <View style={[styles.badge, { backgroundColor: live ? theme.live : theme.surface2 }]} accessibilityRole="text">
      {live && <View style={styles.dot} />}
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <Text accessibilityRole="alert" style={styles.error}>
      {children}
    </Text>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  h1: { color: theme.text, fontSize: 26, fontWeight: '700' },
  h2: { color: theme.text, fontSize: 18, fontWeight: '600' },
  body: { color: theme.muted, fontSize: 15, lineHeight: 21 },
  button: { height: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  round: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  label: { color: theme.muted, fontSize: 13, fontWeight: '600' },
  input: {
    height: 50,
    borderRadius: 12,
    paddingHorizontal: 14,
    backgroundColor: theme.surface2,
    color: theme.text,
    fontSize: 16,
    borderWidth: 1,
    borderColor: theme.border,
  },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, alignSelf: 'flex-start' },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.8 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
  card: { backgroundColor: theme.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: theme.border },
  error: { color: '#fca5a5', fontSize: 14 },
});
