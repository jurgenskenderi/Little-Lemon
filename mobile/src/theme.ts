/**
 * A single dark palette. The app is used in bars in the evening, so the design
 * commits to dark rather than following the system theme.
 */
export const theme = {
  color: {
    background: "#12100E",
    surface: "#1D1A17",
    surfaceRaised: "#272320",
    border: "#38322C",
    text: "#F5F0E8",
    textMuted: "#A79E92",
    textFaint: "#7A7167",
    accent: "#E8B84B",
    accentText: "#241E12",
    live: "#5BC97F",
    soon: "#E8B84B",
  },
  radius: {
    sm: 8,
    md: 14,
    lg: 20,
    pill: 999,
  },
  space: (n: number) => n * 4,
  font: {
    title: 28,
    heading: 19,
    body: 15,
    small: 13,
    tiny: 11,
  },
} as const;
