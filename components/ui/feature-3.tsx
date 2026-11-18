import { LandingCreationStory } from "@/components/studio/landing/interactive-sections";

interface WorkflowStep {
  title: string;
  description: string;
}

export default function Features3({ steps }: { steps: readonly WorkflowStep[] }) {
  return (
    <section id="how" aria-labelledby="how-title" className="w-full scroll-mt-24 bg-muted/35">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-10 px-5 py-16 md:gap-14 md:px-8 md:py-24">
        <h2 id="how-title" className="font-heading text-4xl font-semibold tracking-tighter md:text-5xl">
          Как это работает
        </h2>
        <LandingCreationStory steps={steps} />
      </div>
    </section>
  );
}
