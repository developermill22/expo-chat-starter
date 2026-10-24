import { Image } from 'expo-image';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { initials } from '@/lib/format';
import { tintFor, useTheme } from '@/theme';

/** Shared UI primitives. Deliberately small — restyle freely. */

export function Screen({
  children,
  edges = ['top', 'bottom'],
  style,
}: {
  children: ReactNode;
  edges?: Edge[];
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  return (
    <SafeAreaView edges={edges} style={[styles.flex, { backgroundColor: colors.background }, style]}>
      {children}
    </SafeAreaView>
  );
}

export function Header({
  title,
  subtitle,
  back = false,
  right,
}: {
  title: string;
  subtitle?: string;
  back?: boolean;
  right?: ReactNode;
}) {
  const { colors, font, spacing } = useTheme();
  return (
    <View style={[styles.header, { borderBottomColor: colors.border, paddingHorizontal: spacing.lg }]}>
      {back ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          style={styles.headerSide}
        >
          <Text style={[font.heading, { color: colors.accent }]}>‹ Back</Text>
        </Pressable>
      ) : null}
      <View style={styles.headerTitle}>
        <Text accessibilityRole="header" numberOfLines={1} style={[back ? font.heading : font.title, { color: colors.text }]}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={[font.small, { color: colors.muted }]}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View style={styles.headerRight}>{right}</View> : null}
    </View>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  compact = false,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  compact?: boolean;
  accessibilityLabel?: string;
}) {
  const { colors, radius, font } = useTheme();
  const palette: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
    primary: { bg: colors.accent, fg: colors.onAccent, border: colors.accent },
    secondary: { bg: colors.surface, fg: colors.text, border: colors.border },
    ghost: { bg: 'transparent', fg: colors.accent, border: 'transparent' },
    danger: { bg: 'transparent', fg: colors.danger, border: colors.border },
  };
  const tone = palette[variant];
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        {
          backgroundColor: tone.bg,
          borderColor: tone.border,
          borderRadius: radius.md,
          opacity: inactive ? 0.55 : pressed ? 0.8 : 1,
        },
      ]}
    >
      {loading ? <ActivityIndicator color={tone.fg} /> : <Text style={[font.label, { color: tone.fg, fontSize: 15 }]}>{label}</Text>}
    </Pressable>
  );
}

export function TextField({ label, error, ...props }: TextInputProps & { label: string; error?: string | null }) {
  const { colors, radius, font, spacing } = useTheme();
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={[font.label, { color: colors.muted }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        {...props}
        style={[
          font.body,
          styles.input,
          {
            color: colors.text,
            backgroundColor: colors.surface,
            borderColor: error ? colors.danger : colors.border,
            borderRadius: radius.md,
          },
          props.style,
        ]}
      />
      {error ? <Text style={[font.small, { color: colors.danger }]}>{error}</Text> : null}
    </View>
  );
}

export function Avatar({ id, name, url, size = 44 }: { id: string; name: string; url?: string | null; size?: number }) {
  const shape = { width: size, height: size, borderRadius: size / 2 };
  if (url) return <Image source={{ uri: url }} style={shape} accessibilityIgnoresInvertColors />;
  return (
    <View style={[styles.avatar, shape, { backgroundColor: tintFor(id) }]} accessibilityElementsHidden importantForAccessibility="no">
      <Text style={{ color: '#FFFFFF', fontWeight: '700', fontSize: size * 0.38 }}>{initials(name)}</Text>
    </View>
  );
}

export function CenteredState({
  title,
  body,
  loading = false,
  action,
}: {
  title?: string;
  body?: string;
  loading?: boolean;
  action?: { label: string; onPress: () => void };
}) {
  const { colors, font, spacing } = useTheme();
  return (
    <View style={[styles.centered, { gap: spacing.md, padding: spacing.xxl }]}>
      {loading ? <ActivityIndicator color={colors.accent} /> : null}
      {title ? <Text style={[font.heading, { color: colors.text, textAlign: 'center' }]}>{title}</Text> : null}
      {body ? <Text style={[font.body, { color: colors.muted, textAlign: 'center' }]}>{body}</Text> : null}
      {action ? <Button label={action.label} onPress={action.onPress} variant="secondary" compact /> : null}
    </View>
  );
}

export function Banner({ message, tone = 'danger' }: { message: string; tone?: 'danger' | 'info' }) {
  const { colors, font, spacing, radius } = useTheme();
  return (
    <View
      accessibilityRole="alert"
      style={{
        margin: spacing.lg,
        padding: spacing.md,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: tone === 'danger' ? colors.danger : colors.border,
        backgroundColor: colors.surface,
      }}
    >
      <Text style={[font.small, { color: tone === 'danger' ? colors.danger : colors.text }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerSide: { minHeight: 44, justifyContent: 'center' },
  headerTitle: { flex: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  button: {
    minHeight: 48,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  buttonCompact: { minHeight: 44, paddingHorizontal: 14 },
  input: { minHeight: 48, paddingHorizontal: 14, borderWidth: 1 },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
