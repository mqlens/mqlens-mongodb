import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";
import { THEME_PRESETS } from "@/lib/themes/presets";

interface ThemePickerProps {
  className?: string;
}

export function ThemePicker({ className }: ThemePickerProps) {
  const { config, setPreset } = useTheme();

  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {THEME_PRESETS.slice(0, 4).map((preset) => (
        <button
          key={preset.id}
          type="button"
          title={preset.name}
          onClick={() => setPreset(preset.id)}
          className={cn(
            "h-5 w-5 rounded-full border-2 cursor-pointer transition-transform hover:scale-110",
            config.presetId === preset.id
              ? "border-primary ring-2 ring-primary/30"
              : "border-border"
          )}
          style={{ background: `hsl(${preset.tokens.primary})` }}
        />
      ))}
    </div>
  );
}
