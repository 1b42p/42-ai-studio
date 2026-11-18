import type { ReactElement } from "react";
import { expect, onTestFinished, test, vi } from "vitest";
import { page } from "vitest/browser";

import { AdminShell } from "@/components/studio/admin/admin-shell";
import { adminSections } from "@/components/studio/admin/sections";
import { AdminUsersPanel } from "@/components/studio/admin/users/admin-users-panel";
import { AppShell } from "@/components/studio/app-shell";
import { LoginCard } from "@/components/studio/login-card";
import { navItemsFor } from "@/components/studio/nav";
import { PublicShell } from "@/components/studio/public-shell";
import { SessionList, type SessionListPage } from "@/components/studio/sessions/session-list";
import { SettingsPage } from "@/components/studio/settings/settings-page";
import { Button } from "@/components/ui/button";
import type { AdminUsersPage } from "@/lib/admin/types";
import { expectNoHorizontalScroll, renderAtSize } from "./support/render";

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Анна Иванова",
  username: "anna",
  photoUrl: null,
  isOperator: true,
};
const now = new Date("2026-11-01T12:00:00Z");
const sessions: SessionListPage = {
  items: ["Утренний кофе", "Путешествие по Байкалу", "Презентация проекта"].map((title, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    title,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    preview: null,
  })),
  nextCursor: null,
};
const users: AdminUsersPage = {
  items: [{
    ...user,
    telegramId: "123456789",
    isBlocked: false,
    deletionRequestedAt: null,
    sessionCount: 3,
    stuckDeletions: 0,
    createdAt: now.toISOString(),
    lastLoginAt: now.toISOString(),
  }],
  nextCursor: null,
  totals: { users: 1, operators: 1, blocked: 0 },
};

function luminance(color: string, background?: string, opacity = 1) {
  const context = document.createElement("canvas").getContext("2d")!;
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, 1, 1);
  }
  context.globalAlpha = opacity;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map((byte) => {
    const value = byte / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

for (const theme of ["light", "dark"]) {
  for (const [viewport, size] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    test(`фирменный цвет и основные экраны: ${theme}/${viewport}`, async () => {
      localStorage.setItem("theme", theme);
      onTestFinished(() => { localStorage.removeItem("theme"); });
      const screens: [string, ReactElement][] = [
        ["login", <PublicShell><LoginCard next="/s" telegramEnabled devLoginEnabled={false} error={null} /></PublicShell>],
        ["sessions", <AppShell navItems={navItemsFor(true)} pathname="/s">
          <SessionList initialPage={sessions} initialQuery="" now={now} timeZone="Europe/Moscow" request={async () => sessions} />
        </AppShell>],
        ["settings", <AppShell navItems={navItemsFor(true)} pathname="/settings">
          <SettingsPage user={user} onLogout={vi.fn()} settings={{ customInstructions: "Создавай ролики на русском языке.", memoryEnabled: true }} save={vi.fn()} />
        </AppShell>],
        ["admin", <AppShell navItems={navItemsFor(true)} pathname="/admin/users">
          <AdminShell sections={adminSections} pathname="/admin/users" onNavigate={vi.fn()}>
            <AdminUsersPanel initialPage={users} now={now} timeZone="Europe/Moscow" request={async () => users} />
          </AdminShell>
        </AppShell>],
      ];
      for (const [name, screen] of screens) {
        const rendered = await renderAtSize(screen, size);
        try {
          await expect.poll(() => document.documentElement.classList.contains(theme)).toBe(true);
          expectNoHorizontalScroll();
          await page.screenshot({ path: `../../.vitest/attachments/studio-${name}-${theme}-${viewport}.png` });
        } finally {
          await rendered.unmount();
        }
      }
      const rendered = await renderAtSize(
        <><Button>Фирменный цвет</Button><Button variant="link">Ссылка</Button></>,
        size,
      );
      try {
        const button = getComputedStyle(page.getByRole("button", { name: "Фирменный цвет" }).element());
        const link = getComputedStyle(page.getByRole("button", { name: "Ссылка" }).element());
        const body = getComputedStyle(document.body);
        expect(luminance(button.backgroundColor)).toBeGreaterThan(0.3);
        expect(contrast(button.backgroundColor, button.color)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(body.backgroundColor, link.color)).toBeGreaterThanOrEqual(4.5);
        expect(button.boxShadow).toBe("none");
        for (const token of ["--ring", "--sidebar-ring"]) {
          const color = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
          const focus = luminance(color, body.backgroundColor, 0.5);
          const background = luminance(body.backgroundColor);
          const ratio = (Math.max(focus, background) + 0.05) / (Math.min(focus, background) + 0.05);
          expect(ratio, token).toBeGreaterThanOrEqual(3);
        }
      } finally {
        await rendered.unmount();
      }
    });
  }
}
