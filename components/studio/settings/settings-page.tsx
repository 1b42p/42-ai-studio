"use client";

import { BrainIcon, CableIcon, PaletteIcon, Settings2Icon, SlidersHorizontalIcon, UserRoundIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
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
      <div className="mx-auto w-full max-w-6xl min-w-0 px-1 py-6 md:px-4 md:py-10">
        <FieldSet className="min-w-0">
          <FieldLegend role="heading" aria-level={1}>Настройки</FieldLegend>
          <Badge variant="outline" className="w-fit"><Settings2Icon />Личная студия</Badge>
          <FieldDescription className="max-w-xl">Настройте рабочее пространство и расскажите агенту, как создавать видео для вас.</FieldDescription>
          <div className="grid min-w-0 gap-6 lg:grid-cols-[max-content_minmax(0,1fr)] lg:gap-10">
            <nav aria-label="Разделы настроек" className="flex flex-wrap gap-1 self-start lg:sticky lg:top-8 lg:flex-col">
              {settingsSections.map(({ id, title }) => {
                const Icon = sectionIcons[id] ?? Settings2Icon;
                return (
                  <a
                    key={id}
                    href={`#section-${id}`}
                    className={buttonVariants({
                      variant: "ghost",
                      size: "sm",
                      className: "justify-start",
                    })}
                  >
                    <Icon data-icon="inline-start" />
                    {title}
                  </a>
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
                    className="min-w-0 scroll-mt-24"
                    role="region"
                    aria-labelledby={`settings-${id}`}
                  >
                    <CardHeader>
                      <Badge variant="secondary" className="w-fit">
                        <Icon />
                      </Badge>
                      <CardTitle id={`settings-${id}`} role="heading" aria-level={2}>
                        {title}
                      </CardTitle>
                      <CardDescription className="max-w-2xl">
                        {description}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="min-w-0">
                      <Component settings={settings} save={save} />
                    </CardContent>
                  </Card>
                );
              })}
            </FieldGroup>
          </div>
        </FieldSet>
      </div>
    </SettingsAccountContext.Provider>
  );
}
