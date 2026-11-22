"use client";

import { useSyncExternalStore } from "react";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const subscribeHydration = () => () => {};

const themes = [
  { value: "light", title: "Светлая", icon: SunIcon },
  { value: "dark", title: "Тёмная", icon: MoonIcon },
  { value: "system", title: "Системная", icon: MonitorIcon },
];

export function PublicThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribeHydration, () => true, () => false);

  return (
    <ToggleGroup
      aria-label="Тема"
      variant="outline"
      size="sm"
      spacing={0}
      value={mounted && theme ? [theme] : []}
      onValueChange={(values) => {
        if (values[0]) setTheme(values[0]);
      }}
    >
      {themes.map(({ value, title, icon: Icon }) => (
        <ToggleGroupItem key={value} value={value} aria-label={title} title={title}>
          <Icon aria-hidden="true" />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
