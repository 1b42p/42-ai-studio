import { ArrowDown } from "lucide-react";

import { PublicShell, type PublicNavLink } from "@/components/studio/public-shell";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/studio/button-link";
import { Cta1 } from "@/components/ui/cta-1";
import Features3 from "@/components/ui/feature-3";
import { Footer3 } from "@/components/ui/footer-3";
import Hero31 from "@/components/ui/hero-31";
import { Separator } from "@/components/ui/separator";
import type { ExampleVideo } from "@/lib/examples";

import { AuthStateProvider, StudioLoginButton } from "./auth-state";
import { heroTitle, landingSteps } from "./content";
import { LandingInteractiveCapabilities } from "./interactive-sections";
import { ExamplesSection } from "./examples-section";
import { HeroScene } from "./hero-scene";
import { FinaleScene } from "./finale-scene";

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
        <Hero31
          badge={<Badge variant="outline" className="rounded-md border-primary/25 bg-background/65 px-3 py-1.5 backdrop-blur-sm">Видео из одной просьбы</Badge>}
          title={heroTitle}
          subtitle="Агент-видеограф сам напишет анимацию, озвучит текст, добавит субтитры, проверит кадры и пришлёт файл прямо в чат."
          note="Отдельный аккаунт не нужен: вход через Telegram"
          visual={<HeroScene />}
          actions={<>
            <StudioLoginButton />
            {examples.length > 0 && (
              <ButtonLink variant="secondary" size="xl" href="#examples">
                Смотреть примеры
                <ArrowDown data-icon="inline-end" aria-hidden="true" />
              </ButtonLink>
            )}
          </>}
        />
        <ExamplesSection examples={examples} />
        <Features3 steps={landingSteps} />
        <section id="features" aria-labelledby="features-title" className="mx-auto flex w-full max-w-7xl scroll-mt-24 flex-col gap-10 px-5 py-16 md:gap-14 md:px-8 md:py-24">
          <h2 id="features-title" className="font-heading text-4xl font-semibold tracking-tighter md:text-5xl">Возможности</h2>
          <LandingInteractiveCapabilities examples={examples} />
        </section>
        <Separator />
        <Cta1
          title="Попробуйте на своей задаче"
          description="Опишите ролик одним сообщением — первый результат уже в чате."
          action={<StudioLoginButton tone="contrast" />}
          visual={<FinaleScene />}
        />
        <Footer3 brandName="42 AI Studio" copyright="© 42 AI Studio" />
      </PublicShell>
    </AuthStateProvider>
  );
}
