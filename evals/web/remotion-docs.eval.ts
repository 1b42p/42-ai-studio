import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
import { SEQUENCE_URL, assertWebOnly, blockedRead, emptySearch, readStub, webSession } from "./fixtures";

// Выдержка из https://www.remotion.dev/docs/sequence.md, прочитана 2026-11-04.
const sequenceDocs = `---
id: sequence
title: <Sequence>
crumb: 'API'
---

\`<Sequence>\` is the base component for placing content on the timeline.
It provides timing props such as \`from\`, \`durationInFrames\` and \`trimBefore\`.

## Using \`<Sequence>\` directly

It is not recommended anymore to use \`<Sequence>\` directly, but it is possible.
You will see this often in legacy Remotion code.

\`\`\`tsx
import {Sequence} from 'remotion';

const SequenceExample = () => {
  return (
    <>
      <Sequence durationInFrames={30}>
        <div>Intro</div>
      </Sequence>
      <Sequence from={30} durationInFrames={30}>
        <div>Clip</div>
      </Sequence>
      <Sequence from={60}>
        <div>Outro</div>
      </Sequence>
    </>
  );
};
\`\`\`

- Intro shows from frame 0–29.
- Clip shows from frame 30 through frame 59.
- Outro shows from frame 60 until the end of the composition.

All children of a \`<Sequence>\` that call \`useCurrentFrame()\` will receive a value that is shifted by \`from\`.

\`\`\`tsx
import {Sequence, useCurrentFrame} from 'remotion';

const Intro = () => <div>{useCurrentFrame()}</div>;

const MyTrailer = () => {
  return (
    <>
      <Intro />
      <Sequence from={30}>
        <Intro />
      </Sequence>
    </>
  );
};
\`\`\`

- At frame \`0\`, this would render \`<div>0</div>\`.
- At frame \`30\`, this would render \`<div>30</div><div>0</div>\`.

Using the \`durationInFrames\` prop, you can define for how long the children of a \`<Sequence>\` should be mounted.

By default, the children of a \`<Sequence>\` are wrapped in an \`<AbsoluteFill>\` component.
If you don't want this behavior, add \`layout="none"\` as a prop.

## Cascading

You can nest sequences within each other and they will cascade.
For example, a sequence that starts at frame 60 which is inside a sequence that starts at frame 30 will have it's children start at frame 90.

## Props

### \`from?\`

(optional from v3.2.36, required in previous versions)

At which frame it's children should assume the video starts.
When the sequence is at \`frame\`, it's children are at frame \`0\`.
From v3.2.36 onwards, this prop will be optional; by default, it will be 0.

### \`durationInFrames?\`

For how many frames of the child timeline the sequence should be displayed, starting at \`trimBefore\`.
By default it will be \`Infinity\` to avoid limiting the duration of the sequence.

The sequence occupies \`durationInFrames / playbackRate\` frames in its parent.
When \`loop\` is enabled, \`durationInFrames\` is the loop length and the sequence repeats until its parent ends.

### \`trimBefore?\` (v4.0.482)

Trims the beginning of the child timeline by the specified number of frames.
Default: \`0\`.

The sequence still starts at \`from\`, but children using \`useCurrentFrame()\` receive a frame that is advanced by \`trimBefore\`.

\`\`\`tsx
import {Sequence, useCurrentFrame} from 'remotion';

const Child = () => <div>{useCurrentFrame()}</div>;

export const MyVideo = () => {
  return (
    <Sequence from={30} trimBefore={15}>
      <Child />
    </Sequence>
  );
};
\`\`\`

In the example above, \`Child\` mounts at composition frame \`30\` and receives frame \`15\`.

### \`loop?\`

Repeats the child range selected by \`trimBefore\` and \`durationInFrames\` until the parent ends.
Default: \`false\`.

Requires a finite \`durationInFrames\`, because a sequence has no intrinsic duration.
Each cycle lasts \`durationInFrames / playbackRate\` frames in the parent timeline.
Wrap it in an outer \`<Sequence>\` to set a finite total duration.

### \`playbackRate?\` (v4.0.528)

Changes the speed of the children, including their animations and media.
Default: \`1\`.
Use \`2\` for double speed or \`0.5\` for half speed.
The value must be positive and finite, and must remain constant across frames.

\`durationInFrames\` and \`trimBefore\` are measured in the child timeline, so changing \`playbackRate\` changes the mounted duration.

\`\`\`tsx
import {Sequence, useCurrentFrame} from 'remotion';

const Child = () => <div>{useCurrentFrame()}</div>;

export const MyVideo = () => (
  <Sequence from={30} durationInFrames={60} trimBefore={10} playbackRate={2}>
    <Child />
  </Sequence>
);
\`\`\`

At composition frame \`30\`, \`Child\` receives frame \`10\`.
At frame \`40\`, it receives frame \`30\`: \`(40 - 30) * 2 + 10\`.
The sequence remains visible through composition frame \`59\`.

Nested playback rates multiply.
A sequence with \`playbackRate={2}\` inside one with \`playbackRate={0.5}\` plays at the original speed.
A media component's own \`playbackRate\` also multiplies with its parent sequences' rates.

The rate applies to \`useCurrentFrame()\` called inside descendant components.
Animations calculated in the parent and passed as the sequence's \`style\` or as child props keep the parent's clock.

### \`layout?\`

Either \`"absolute-fill"\` (default) or \`"none"\`.
By default, your sequences will be absolutely positioned, so they will overlay each other.
If you would like to opt out of it and handle layouting yourself, pass \`layout="none"\`.
Available since v1.4.

### \`style?\`

CSS styles to be applied to the container.
If \`layout\` is set to \`none\`, there is no container and setting this style is not allowed.

## Note for \`@remotion/three\`

A \`<Sequence>\` by default will return a \`<div>\` component which is not allowed inside a \`<ThreeCanvas>\`.
Avoid an error by passing \`layout="none"\` to \`<Sequence>\`.
Example: \`<Sequence layout="none">\`.
`;

export default Array.from({ length: 3 }, () => defineEval({
  description: "Документация Sequence читается в Markdown на сервере, а не из песочницы.",
  tags: ["web", "remotion-docs"],
  async test(t) {
    const session = await webSession(t, [
      readStub("sequence", SEQUENCE_URL, "<Sequence>", sequenceDocs, "en"),
      blockedRead, emptySearch,
    ]);
    const turn = await session.send("Объясни по-русски по официальной документации Remotion, как работает <Sequence>, свойства from и durationInFrames и отсчёт кадров внутри. Сам ролик создавать не нужно.");
    assertWebOnly(t);
    t.calledTool("read_page", { input: { url: SEQUENCE_URL } });
    t.check(turn.message, includes("from"));
    t.check(turn.message, includes("durationInFrames"));
  },
}));
