import { useColorScheme } from 'react-native';

/**
 * Small semantic palette. Screens reference roles ("surface", "muted"),
 * never raw hex values, so re-skinning the starter means editing this file.
 * Text/background pairs are chosen to meet WCAG AA (4.5:1) in both modes.
 */
const light = {
  background: '#F4F4F1',
  surface: '#FFFFFF',
  surfaceAlt: '#EAEAE5',
  border: '#DCDCD5',
  text: '#15171A',
  muted: '#5F636B',
  accent: '#2B50D8',
  onAccent: '#FFFFFF',
  bubbleMine: '#2B50D8',
  onBubbleMine: '#FFFFFF',
  bubbleTheirs: '#FFFFFF',
  onBubbleTheirs: '#15171A',
  danger: '#B3261E',
  success: '#1E7A4C',
};

const dark: typeof light = {
  background: '#0F1012',
  surface: '#191B1F',
  surfaceAlt: '#24262B',
  border: '#2E3137',
  text: '#ECEDEF',
  muted: '#A1A5AD',
  accent: '#7C93FF',
  onAccent: '#0F1012',
  bubbleMine: '#3557E0',
  onBubbleMine: '#FFFFFF',
  bubbleTheirs: '#24262B',
  onBubbleTheirs: '#ECEDEF',
  danger: '#FF8A80',
  success: '#6FD3A0',
};

export type Palette = typeof light;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 18, pill: 999 } as const;
export const font = {
  title: { fontSize: 28, fontWeight: '700' as const, letterSpacing: -0.4 },
  heading: { fontSize: 17, fontWeight: '600' as const },
  body: { fontSize: 16, fontWeight: '400' as const },
  small: { fontSize: 13, fontWeight: '400' as const },
  label: { fontSize: 13, fontWeight: '600' as const, letterSpacing: 0.2 },
};

export function useTheme() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  return { colors: isDark ? dark : light, isDark, spacing, radius, font };
}

/** Deterministic avatar tint per user id. */
const avatarTints = ['#2B50D8', '#B4462B', '#1E7A4C', '#7A3FB8', '#A35A00', '#0B7285', '#9C2F6E'];
export function tintFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return avatarTints[Math.abs(hash) % avatarTints.length] ?? '#2B50D8';
}
