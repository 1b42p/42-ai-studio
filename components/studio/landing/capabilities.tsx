"use client";

import { Activity } from "react";

import Bento2, { Bento2Card } from "@/components/watermelon/bento-02";
import type { ExampleVideo } from "@/lib/examples";

import { landingFeatures } from "./content";
import {
  CaptionScene, DataScene, DocumentScene, EditScene,
  FilmScene, KineticScene, MusicScene, VoiceScene,
} from "./capability-scenes";

export function LandingCapabilities(_props: { examples: readonly ExampleVideo[] }) {
  return (
    <Bento2 className="w-full">
      <Activity>
        <Bento2Card {...landingFeatures[2]} className="md:col-span-8" contentClassName="px-0">
          <KineticScene />
        </Bento2Card>
      </Activity>
      <Activity>
        <Bento2Card {...landingFeatures[1]} className="md:col-span-4" reverse>
          <CaptionScene />
        </Bento2Card>
      </Activity>
      <Activity>
        <Bento2Card {...landingFeatures[0]} className="md:col-span-5" reverse>
          <VoiceScene />
        </Bento2Card>
      </Activity>
      <Activity>
        <Bento2Card {...landingFeatures[3]} className="md:col-span-7">
          <DataScene />
        </Bento2Card>
      </Activity>
      <Activity>
        <Bento2Card {...landingFeatures[4]} className="md:col-span-6 xl:col-span-4">
          <DocumentScene />
        </Bento2Card>
      </Activity>
      <Activity>
        <Bento2Card {...landingFeatures[5]} className="md:col-span-6 xl:col-span-4" contentClassName="px-0" reverse>
          <FilmScene />
        </Bento2Card>
      </Activity>
      <Activity>
        <Bento2Card {...landingFeatures[6]} className="md:col-span-12 xl:col-span-4">
          <MusicScene />
        </Bento2Card>
      </Activity>
      <Activity>
        <Bento2Card {...landingFeatures[7]} className="md:col-span-12">
          <EditScene />
        </Bento2Card>
      </Activity>
    </Bento2>
  );
}
