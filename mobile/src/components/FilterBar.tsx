import Slider from "@react-native-community/slider";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { DealCategory } from "../api/types";
import { theme } from "../theme";
import { TIME_CHOICES, type TimeChoice } from "../timeChoices";

interface Props {
  radiusKm: number;
  onRadiusChange: (kilometres: number) => void;
  timeChoice: TimeChoice;
  onTimeChange: (choice: TimeChoice) => void;
  category: DealCategory | null;
  onCategoryChange: (category: DealCategory | null) => void;
  resolvedAt: Date;
}

const CATEGORIES: Array<{ value: DealCategory | null; label: string }> = [
  { value: null, label: "Everything" },
  { value: "drink", label: "Drinks" },
  { value: "food", label: "Food" },
];

export function FilterBar({
  radiusKm,
  onRadiusChange,
  timeChoice,
  onTimeChange,
  category,
  onCategoryChange,
  resolvedAt,
}: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.section}>
        <View style={styles.labelRow}>
          <Text style={styles.label}>Within</Text>
          <Text style={styles.value}>{formatRadius(radiusKm)}</Text>
        </View>
        <Slider
          minimumValue={0.5}
          maximumValue={15}
          step={0.5}
          value={radiusKm}
          // Committing on release rather than on every frame keeps the list
          // from re-querying continuously while the thumb is moving.
          onSlidingComplete={onRadiusChange}
          minimumTrackTintColor={theme.color.accent}
          maximumTrackTintColor={theme.color.border}
          thumbTintColor={theme.color.accent}
          accessibilityLabel={`Search radius, ${formatRadius(radiusKm)}`}
          style={styles.slider}
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>When</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          {TIME_CHOICES.map((choice) => (
            <Chip
              key={choice.id}
              label={choice.label}
              selected={choice.id === timeChoice.id}
              onPress={() => onTimeChange(choice)}
            />
          ))}
        </ScrollView>
        <Text style={styles.hint}>{timeChoice.describe(resolvedAt)}</Text>
      </View>

      <View style={styles.section}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          {CATEGORIES.map((option) => (
            <Chip
              key={option.label}
              label={option.label}
              selected={option.value === category}
              onPress={() => onCategoryChange(option.value)}
            />
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && !selected && styles.chipPressed,
      ]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function formatRadius(kilometres: number): string {
  if (kilometres < 1) return `${Math.round(kilometres * 1000)} m`;
  return kilometres === 15 ? "15+ km" : `${String(kilometres).replace(/\.0$/, "")} km`;
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: theme.space(4),
    paddingBottom: theme.space(3),
    gap: theme.space(3),
  },
  section: {
    gap: theme.space(1.5),
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
  },
  label: {
    color: theme.color.textMuted,
    fontSize: theme.font.small,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  value: {
    color: theme.color.accent,
    fontSize: theme.font.body,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  slider: {
    width: "100%",
    height: 36,
  },
  chipRow: {
    gap: theme.space(2),
    paddingRight: theme.space(4),
  },
  chip: {
    paddingHorizontal: theme.space(3.5),
    paddingVertical: theme.space(2),
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
  },
  chipPressed: {
    backgroundColor: theme.color.surfaceRaised,
  },
  chipSelected: {
    backgroundColor: theme.color.accent,
    borderColor: theme.color.accent,
  },
  chipText: {
    color: theme.color.textMuted,
    fontSize: theme.font.small,
    fontWeight: "600",
  },
  chipTextSelected: {
    color: theme.color.accentText,
  },
  hint: {
    color: theme.color.textFaint,
    fontSize: theme.font.tiny,
  },
});
