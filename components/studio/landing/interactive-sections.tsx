import { Activity } from "react";

import type { ExampleVideo } from "@/lib/examples";

import { CreationStory } from "./creation-story";
import { LandingCapabilities } from "./capabilities";

// Visible Activity boundaries preserve the full SSR markup while allowing
// React to hydrate independent controls without a page-wide synchronous commit.
export function LandingCreationStory({
  steps,
}: {
  steps: readonly { title: string; description: string }[];
}) {
  return (
    <Activity>
      <CreationStory steps={steps} />
    </Activity>
  );
}

export function LandingInteractiveCapabilities({
  examples,
}: {
  examples: readonly ExampleVideo[];
}) {
  return (
    <Activity>
      <LandingCapabilities examples={examples} />
    </Activity>
  );
}
