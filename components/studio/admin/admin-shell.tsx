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
import { Badge } from "@/components/ui/badge";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
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
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-6 p-4 md:gap-8 md:p-8">
      <Item className="rounded-none border-0 border-b border-border px-0 pb-5 pt-0">
        <ItemContent>
          <ItemDescription className="text-xs font-medium tracking-widest">42 AI STUDIO</ItemDescription>
          <ItemTitle role="heading" aria-level={1} className="text-lg font-semibold tracking-tight">Админка</ItemTitle>
        </ItemContent>
        <Badge variant="outline">Оператор</Badge>
      </Item>

      <div className="hidden md:block">
        <Tabs value={current?.href}>
          <TabsList className="gap-1 rounded-xl bg-muted/70 p-1 group-data-horizontal/tabs:h-12">
            {sections.map((section) => (
              <TabsTrigger
                key={section.href}
                nativeButton={false}
                render={<a href={section.href} />}
                value={section.href}
                className="h-10 rounded-lg px-5 data-active:bg-primary! data-active:text-primary-foreground!"
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
