import { ArrowDown } from "lucide-react";

import { PublicShell, type PublicNavLink } from "@/components/studio/public-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Cta1 } from "@/components/ui/cta-1";
import Features3 from "@/components/ui/feature-3";
import { Footer3 } from "@/components/ui/footer-3";
import Hero25 from "@/components/ui/hero-25";
import { Separator } from "@/components/ui/separator";
import type { ExampleVideo } from "@/lib/examples";

import { AuthStateProvider, StudioLoginButton } from "./auth-state";
import { heroTitle, landingSteps } from "./content";
import { LandingCapabilities } from "./capabilities";
import { ExamplesSection } from "./examples-section";
import { HeroScene } from "./hero-scene";

export interface LandingPageProps {
  examples: readonly ExampleVideo[];
}

export function landingNavLinks(hasExamples: boolean): PublicNavLink[] {
  return [
    ...(hasExamples ? [{ title: "Примеры", href: "#examples" }] : []),
    { title: "Как это работает", href: "#how" },
    { title: "Возможности", href: "#features" },
  ];
}

/** Complete public page, independent of the Next.js router for render fixtures. */
export function LandingPage({ examples }: LandingPageProps) {
  return (
    <AuthStateProvider>
      <PublicShell fullWidth navLinks={landingNavLinks(examples.length > 0)} actions={<StudioLoginButton compact />}>
        <Hero25
          badge={<Badge className="rounded-lg px-3 py-1.5">Видео из одной просьбы</Badge>}
          title={heroTitle}
          description="Агент-видеограф сам напишет анимацию, озвучит текст, добавит субтитры, проверит кадры и пришлёт файл прямо в чат."
          note="Отдельный аккаунт не нужен: вход через Telegram"
          visual={<HeroScene />}
          actions={<>
            <StudioLoginButton />
            {examples.length > 0 && (
              <Button variant="outline" size="xl" nativeButton={false} render={<a href="#examples" role="link" />}>
                Смотреть примеры
                <ArrowDown data-icon="inline-end" aria-hidden="true" />
              </Button>
            )}
          </>}
        />
        <ExamplesSection examples={examples} />
        <Features3 steps={landingSteps} preview={examples.find(({ id }) => id === "explainer")} />
        <section id="features" aria-labelledby="features-title" className="mx-auto flex w-full max-w-7xl scroll-mt-24 flex-col gap-10 px-5 py-16 md:gap-14 md:px-8 md:py-24">
          <h2 id="features-title" className="font-heading text-4xl font-semibold tracking-tighter md:text-5xl">Возможности</h2>
          <LandingCapabilities examples={examples} />
        </section>
        <Separator />
        <Cta1
          title="Попробуйте на своей задаче"
          description="Опишите ролик одним сообщением — первый результат уже в чате."
          action={<StudioLoginButton tone="contrast" />}
        />
        <Footer3 brandName="42 AI Studio" copyright="© 42 AI Studio" />
      </PublicShell>
    </AuthStateProvider>
  );
}
