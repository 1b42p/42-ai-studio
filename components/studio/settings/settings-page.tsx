"use client";

import { BrainIcon, CableIcon, PaletteIcon, Settings2Icon, SlidersHorizontalIcon, UserRoundIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldDescription, FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";

import { SettingsAccountContext, type SettingsAccount } from "./account-context";
import type { SettingsSectionProps } from "./section";
import { settingsSections } from "./sections";

export type SettingsPageProps = SettingsSectionProps & SettingsAccount;

const sectionIcons: Record<string, typeof PaletteIcon> = {
  theme: PaletteIcon,
  instructions: SlidersHorizontalIcon,
  memory: BrainIcon,
  mcp: CableIcon,
  account: UserRoundIcon,
};

/** Представление без сети и роутера; новые разделы подключаются в settingsSections. */
export function SettingsPage({ settings, save, user, onLogout }: SettingsPageProps) {
  return (
    <SettingsAccountContext.Provider value={{ user, onLogout }}>
      <FieldSet className="mx-auto w-full max-w-6xl min-w-0 gap-8 px-1 py-6 md:px-4 md:py-10">
        <FieldLegend className="mb-0 font-semibold tracking-tight data-[variant=legend]:text-3xl md:data-[variant=legend]:text-4xl" role="heading" aria-level={1}>Настройки</FieldLegend>
        <Badge variant="outline" className="w-fit gap-2"><Settings2Icon />Личная студия</Badge>
        <FieldDescription className="-mt-5 max-w-xl text-base leading-relaxed">Настройте рабочее пространство и расскажите агенту, как создавать видео для вас.</FieldDescription>
        <div className="grid min-w-0 gap-6 lg:grid-cols-[190px_minmax(0,1fr)] lg:gap-10">
          <nav aria-label="Разделы настроек" className="flex flex-wrap gap-1 self-start lg:sticky lg:top-8 lg:flex-col">
            {settingsSections.map(({ id, title }) => {
              const Icon = sectionIcons[id] ?? Settings2Icon;
              return (
                <Button
                  key={id}
                  variant="ghost"
                  size="sm"
                  className="h-auto min-h-9 justify-start whitespace-normal text-left"
                  render={<a href={`#section-${id}`} />}
                >
                  <Icon data-icon="inline-start" />
                  {title}
                </Button>
              );
            })}
          </nav>
          <FieldGroup className="min-w-0 gap-6">
            {settingsSections.map(({ id, title, description, Component }) => {
              const Icon = sectionIcons[id] ?? Settings2Icon;
              return (
                <Card
                  id={`section-${id}`}
                  key={id}
                  className="min-w-0 scroll-mt-24 gap-6 rounded-2xl py-6 md:py-8"
                  role="region"
                  aria-labelledby={`settings-${id}`}
                >
                  <CardHeader className="gap-3 px-5 md:px-8">
                    <Badge variant="secondary" className="mb-1 size-10 justify-center rounded-xl bg-primary/10 text-foreground">
                      <Icon className="size-5" />
                    </Badge>
                    <CardTitle id={`settings-${id}`} role="heading" aria-level={2}>
                      {title}
                    </CardTitle>
                    <CardDescription className="max-w-2xl leading-relaxed">
                      {description}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="min-w-0 px-5 md:px-8">
                    <Component settings={settings} save={save} />
                  </CardContent>
                </Card>
              );
            })}
          </FieldGroup>
        </div>
      </FieldSet>
    </SettingsAccountContext.Provider>
  );
}
