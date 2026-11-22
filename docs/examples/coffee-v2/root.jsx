import React from "react";
import { Composition, registerRoot } from "remotion";
import { CoffeeFilm } from "./film";

function Root() {
  return <Composition
    id="Coffee"
    component={CoffeeFilm}
    durationInFrames={600}
    fps={30}
    width={720}
    height={1280}
  />;
}

registerRoot(Root);
