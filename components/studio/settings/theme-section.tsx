"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useIsMobile } from "@/hooks/use-mobile";

const themes = [
  { value: "light", title: "Светлая", Icon: SunIcon },
  { value: "dark", title: "Тёмная", Icon: MoonIcon },
  { value: "system", title: "Системная", Icon: MonitorIcon },
];

export function ThemeSection() {
  const { theme, setTheme } = useTheme();
  const mobile = useIsMobile();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <ToggleGroup
      aria-label="Тема оформления"
      variant="outline"
      className="grid w-full grid-cols-1 gap-2 border-0 md:grid-cols-3"
      orientation={mobile ? "vertical" : "horizontal"}
      value={mounted && theme ? [theme] : []}
      disabled={!mounted}
      onValueChange={(values) => {
        const value = values[0];
        if (value !== undefined) setTheme(value);
      }}
    >
      {themes.map(({ value, title, Icon }) => (
        <ToggleGroupItem key={value} value={value} className="h-16 justify-start gap-3 rounded-xl border border-border px-4 data-pressed:border-primary/50 data-pressed:bg-primary/8 data-pressed:text-foreground">
          <Icon data-icon="inline-start" />
          {title}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
