"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";

import { SettingsAccountContext, type SettingsAccount } from "./account-context";
import type { SettingsSectionProps } from "./section";
import { settingsSections } from "./sections";

export type SettingsPageProps = SettingsSectionProps & SettingsAccount;

/** Представление без сети и роутера; новые разделы подключаются в settingsSections. */
export function SettingsPage({ settings, save, user, onLogout }: SettingsPageProps) {
  return (
    <SettingsAccountContext.Provider value={{ user, onLogout }}>
      <FieldSet className="mx-auto w-full max-w-2xl min-w-0 p-4 md:p-6">
        <FieldLegend role="heading" aria-level={1}>Настройки</FieldLegend>
        <FieldGroup>
          {settingsSections.map(({ id, title, description, Component }) => (
            <Card key={id} role="region" aria-labelledby={`settings-${id}`}>
              <CardHeader>
                <CardTitle id={`settings-${id}`} role="heading" aria-level={2}>
                  {title}
                </CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
              <CardContent className="min-w-0">
                <Component settings={settings} save={save} />
              </CardContent>
            </Card>
          ))}
        </FieldGroup>
      </FieldSet>
    </SettingsAccountContext.Provider>
  );
}
