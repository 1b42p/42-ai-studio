import { ArrowDown } from "lucide-react";

import { PublicShell, type PublicNavLink } from "@/components/studio/public-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Cta1 } from "@/components/ui/cta-1";
import { Footer3 } from "@/components/ui/footer-3";
import { Separator } from "@/components/ui/separator";
import type { ExampleVideo } from "@/lib/examples";

import { AuthStateProvider, StudioLoginButton } from "./auth-state";
import { landingSteps } from "./content";
import { ExamplesSection } from "./examples-section";
import { HeroBackground, HeroTitle, LandingFeatures, Reveal } from "./motion";

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
        <section className="relative isolate w-full overflow-hidden">
          <HeroBackground />
          <div className="relative mx-auto flex w-full max-w-7xl flex-col items-start gap-7 px-4 py-16 md:gap-8 md:px-8 md:py-24">
            <Badge variant="outline">Видео из одной просьбы</Badge>
            <HeroTitle />
            <p className="text-muted-foreground max-w-2xl text-base leading-relaxed md:text-lg">
              Агент-видеограф сам напишет анимацию, озвучит текст, добавит субтитры, проверит кадры и пришлёт файл прямо в чат.
            </p>
            <div className="flex w-full flex-col items-start gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <StudioLoginButton />
                {examples.length > 0 && (
                  <Button variant="outline" size="lg" nativeButton={false} render={<a href="#examples" role="link" />}>
                    Смотреть примеры
                    <ArrowDown data-icon="inline-end" aria-hidden="true" />
                  </Button>
                )}
              </div>
              <p className="text-muted-foreground text-sm">Отдельный аккаунт не нужен: вход через Telegram</p>
            </div>
          </div>
        </section>
        <ExamplesSection examples={examples} />
        <Separator />
        <section id="how" aria-labelledby="how-title" className="mx-auto flex w-full max-w-7xl scroll-mt-14 flex-col gap-10 px-4 py-16 md:px-8 md:py-20">
          <h2 id="how-title" className="font-heading text-3xl font-semibold tracking-tight md:text-4xl">Как это работает</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            {landingSteps.map((step, index) => (
              <Reveal key={step.title} index={index}>
                <Card className="h-full">
                  <CardHeader className="gap-4">
                    <Badge variant="secondary" className="size-8 justify-center">{index + 1}</Badge>
                    <CardTitle><h3>{step.title}</h3></CardTitle>
                    <CardDescription className="leading-relaxed">{step.description}</CardDescription>
                  </CardHeader>
                </Card>
              </Reveal>
            ))}
          </div>
        </section>
        <section id="features" aria-labelledby="features-title" className="mx-auto flex w-full max-w-7xl scroll-mt-14 flex-col gap-10 px-4 pb-16 md:px-8 md:pb-20">
          <h2 id="features-title" className="font-heading text-3xl font-semibold tracking-tight md:text-4xl">Возможности</h2>
          <LandingFeatures />
        </section>
        <Separator />
        <Cta1
          title="Попробуйте на своей задаче"
          description="Опишите ролик одним сообщением — первый результат уже в чате."
          action={<StudioLoginButton />}
        />
        <Footer3 brandName="42 AI Studio" copyright="© 42 AI Studio" />
      </PublicShell>
    </AuthStateProvider>
  );
}
