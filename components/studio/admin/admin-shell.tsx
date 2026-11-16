"use client";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AdminSection } from "./sections";

export interface AdminShellProps {
  readonly sections: readonly AdminSection[];
  readonly pathname: string;
  /** Переход на телефоне: компонент не знает роутера, его передают снаружи. */
  readonly onNavigate?: (href: string) => void;
  readonly children: React.ReactNode;
}

function currentSection(
  sections: readonly AdminSection[],
  pathname: string,
): AdminSection | undefined {
  return sections.find(
    (section) => pathname === section.href || pathname.startsWith(`${section.href}/`),
  ) ?? sections[0];
}

/**
 * Каркас админки: заголовок и переключатель разделов. На компьютере — вкладки
 * со ссылками, на телефоне — выпадающий список: горизонтальной прокрутки нет.
 */
export function AdminShell({ sections, pathname, onNavigate, children }: AdminShellProps) {
  const current = currentSection(sections, pathname);
  const items = sections.map((section) => ({
    label: section.title,
    value: section.href,
  }));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:gap-6 md:p-6">
      <h1 className="text-xl font-semibold">Админка</h1>

      <div className="hidden md:block">
        <Tabs value={current?.href}>
          <TabsList variant="line">
            {sections.map((section) => (
              <TabsTrigger
                key={section.href}
                nativeButton={false}
                render={<a href={section.href} />}
                value={section.href}
              >
                {section.title}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="md:hidden">
        <Select
          items={items}
          onValueChange={(value) => {
            if (value !== null) onNavigate?.(value);
          }}
          value={current?.href ?? null}
        >
          <SelectTrigger aria-label="Раздел админки" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {sections.map((section) => (
                <SelectItem key={section.href} value={section.href}>
                  {section.title}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      {children}
    </div>
  );
}
