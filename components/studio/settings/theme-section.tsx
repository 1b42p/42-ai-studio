"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const themes = [
  { value: "light", title: "Светлая", Icon: SunIcon },
  { value: "dark", title: "Тёмная", Icon: MoonIcon },
  { value: "system", title: "Системная", Icon: MonitorIcon },
];

export function ThemeSection() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <ToggleGroup
      aria-label="Тема оформления"
      variant="outline"
      className="w-full flex-wrap sm:w-fit"
      value={mounted && theme ? [theme] : []}
      disabled={!mounted}
      onValueChange={(values) => {
        const value = values[0];
        if (value !== undefined) setTheme(value);
      }}
    >
      {themes.map(({ value, title, Icon }) => (
        <ToggleGroupItem key={value} value={value} className="flex-1 sm:flex-none">
          <Icon data-icon="inline-start" />
          {title}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
