import { Download, Upload, RotateCcw, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";
import { FONT_OPTIONS } from "@/lib/themes/presets";
import type { SpacingDensity, ThemeMode } from "@/lib/themes/schema";
import {
  clampUiZoom,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  UI_ZOOM_STEP,
} from "@/lib/themes/ui-scale";
import { formatZoomShortcutHint } from "@/lib/shortcuts";

export function AppearanceSettings() {
  const {
    config,
    presets,
    resolvedMode,
    setPreset,
    setMode,
    setFontSize,
    setUiZoom,
    setSpacingDensity,
    setFontSans,
    setFontMono,
    clearOverrides,
    exportTheme,
    importTheme,
    saveAppearance,
  } = useTheme();

  const handleExport = () => {
    const blob = new Blob([exportTheme()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mqlens-theme.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      importTheme(text);
      await saveAppearance();
    };
    input.click();
  };

  const activePreset = presets.find((p) => p.id === config.presetId);

  return (
    <div className="grid w-full gap-8 xl:grid-cols-[minmax(0,1fr)_min(340px,28vw)]">
      <div className="flex min-w-0 flex-col gap-8">
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Theme preset</h3>
            <p className="text-xs text-muted-foreground">
              Pick a color system — mode follows each preset unless overridden below.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-4">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => setPreset(preset.id)}
                className={cn(
                  "group relative rounded-xl border p-3 text-left transition-all cursor-pointer hover:border-primary/50 hover:shadow-sm",
                  config.presetId === preset.id
                    ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                    : "border-border bg-card"
                )}
              >
                {config.presetId === preset.id && (
                  <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Check className="h-3 w-3" />
                  </span>
                )}
                <div
                  className="mb-2.5 h-10 rounded-md border shadow-inner"
                  style={{
                    background: `hsl(${preset.tokens.background})`,
                    borderColor: `hsl(${preset.tokens.primary})`,
                  }}
                />
                <div className="text-sm font-medium leading-tight">{preset.name}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground line-clamp-2">
                  {preset.description}
                </div>
              </button>
            ))}
          </div>
        </section>

        <Separator />

        <section className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          <div className="space-y-2">
            <Label>Color mode</Label>
            <Select value={config.mode} onValueChange={(v) => setMode(v as ThemeMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Spacing density</Label>
            <Select
              value={config.spacingDensity}
              onValueChange={(v) => setSpacingDensity(v as SpacingDensity)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="compact">Compact</SelectItem>
                <SelectItem value="cozy">Cozy</SelectItem>
                <SelectItem value="roomy">Roomy</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2 md:col-span-2 xl:col-span-1">
            <div className="flex items-center justify-between">
              <Label>Interface zoom</Label>
              <span className="font-mono text-xs text-muted-foreground">
                {Math.round(config.uiZoom * 100)}%
              </span>
            </div>
            <Slider
              min={UI_ZOOM_MIN}
              max={UI_ZOOM_MAX}
              step={UI_ZOOM_STEP}
              value={[config.uiZoom]}
              onValueChange={([v]) => setUiZoom(clampUiZoom(v))}
            />
            <p className="text-[11px] text-muted-foreground">
              Shortcut: {formatZoomShortcutHint()}
            </p>
          </div>

          <div className="space-y-2 md:col-span-2 xl:col-span-1">
            <div className="flex items-center justify-between">
              <Label>Font size</Label>
              <span className="font-mono text-xs text-muted-foreground">{config.fontSize}px</span>
            </div>
            <Slider
              min={11}
              max={16}
              step={1}
              value={[config.fontSize]}
              onValueChange={([v]) => setFontSize(v)}
            />
          </div>
        </section>

        <section className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <Label>UI font</Label>
            <Select value={config.fonts.sans} onValueChange={setFontSans}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FONT_OPTIONS.sans.map((font) => (
                  <SelectItem key={font} value={font}>
                    {font}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Monospace font</Label>
            <Select value={config.fonts.mono} onValueChange={setFontMono}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FONT_OPTIONS.mono.map((font) => (
                  <SelectItem key={font} value={font}>
                    {font}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </section>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Theme files</CardTitle>
            <CardDescription>Export, import, or reset custom token overrides.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={handleExport}>
              <Download className="h-4 w-4" />
              Export theme
            </Button>
            <Button variant="outline" size="sm" onClick={handleImport}>
              <Upload className="h-4 w-4" />
              Import theme
            </Button>
            <Button variant="outline" size="sm" onClick={clearOverrides}>
              <RotateCcw className="h-4 w-4" />
              Reset overrides
            </Button>
            <Button size="sm" onClick={() => saveAppearance()}>
              Save appearance
            </Button>
          </CardContent>
        </Card>
      </div>

      <aside className="hidden xl:block">
        <div className="sticky top-0 space-y-3">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">Live preview</Label>
          <Card className="overflow-hidden shadow-md">
            <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-3 py-2">
              <span className="h-2.5 w-2.5 rounded-full bg-destructive/80" />
              <span className="h-2.5 w-2.5 rounded-full bg-warning/80" />
              <span className="h-2.5 w-2.5 rounded-full bg-success/80" />
              <span className="ml-2 truncate text-[10px] text-muted-foreground">
                {activePreset?.name ?? "Theme"} · {resolvedMode}
              </span>
            </div>
            <CardContent className="space-y-3 p-4">
              <div className="flex gap-2">
                <div className="h-16 w-14 shrink-0 rounded-md border border-border bg-sidebar" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="h-2 w-3/4 rounded bg-foreground/15" />
                  <div className="h-2 w-1/2 rounded bg-foreground/10" />
                  <div className="mt-auto flex gap-1.5">
                    <div className="h-6 flex-1 rounded-md bg-primary/90" />
                    <div className="h-6 w-12 rounded-md border border-border bg-background" />
                  </div>
                </div>
              </div>
              <div className="rounded-md border border-border bg-input p-2 font-mono text-[10px] text-foreground">
                {'{ "status": "active" }'}
              </div>
              <div className="flex gap-2 text-[10px]">
                <span className="rounded bg-success/15 px-1.5 py-0.5 text-success">success</span>
                <span className="rounded bg-warning/15 px-1.5 py-0.5 text-warning">warning</span>
                <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-destructive">error</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </aside>
    </div>
  );
}
