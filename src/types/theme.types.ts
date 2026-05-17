import { z } from 'zod'

const cssColor = z.string().min(1).max(64)
const radius = z.number().min(0).max(48)
const font = z.string().min(1).max(64)

export const themeSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  author: z.string().max(64).optional(),
  version: z.string().default('1.0.0'),
  mode: z.enum(['dark', 'light']),
  colors: z.object({
    bgPrimary: cssColor,
    bgSecondary: cssColor,
    bgTertiary: cssColor,
    bgCard: cssColor,
    bgHover: cssColor,
    textPrimary: cssColor,
    textSecondary: cssColor,
    textMuted: cssColor,
    accentPrimary: cssColor,
    accentSecondary: cssColor,
    success: cssColor,
    warning: cssColor,
    error: cssColor,
    border: cssColor,
    glass: cssColor,
    glassBorder: cssColor,
    surfaceSoft: cssColor,
    surfaceSoftHover: cssColor,
    surfaceMedium: cssColor,
    surfaceStrong: cssColor,
    surfaceSoftBorder: cssColor,
    scrollbarThumb: cssColor,
    scrollbarThumbHover: cssColor,
    selectionBg: cssColor,
  }),
  radii: z.object({
    sm: radius,
    md: radius,
    lg: radius,
    xl: radius,
  }),
  fonts: z.object({
    display: font,
    body: font,
    mono: font,
  }),
  isBuiltin: z.boolean().default(false),
})

export type Theme = z.infer<typeof themeSchema>
export type ThemeColors = Theme['colors']
export type ThemeRadii = Theme['radii']
export type ThemeFonts = Theme['fonts']
