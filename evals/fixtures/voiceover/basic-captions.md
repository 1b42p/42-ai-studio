# Basic Captions

Simple synchronized captions with white text on a translucent gray background.

Element page: [https://www.remotion.dev/elements/captions/basic-captions/](https://www.remotion.dev/elements/captions/basic-captions/)

## Installation

Install this Element into a composition of your Remotion project:

```sh
npx remotion elements use https://www.remotion.dev/elements/captions/basic-captions/ --composition <composition-id> --yes
```

Replace `<composition-id>` with the ID of the composition to add the Element to. The command installs the dependencies, downloads the assets, writes the source file and adds the Element to the composition. See [`npx remotion elements use`](https://www.remotion.dev/docs/cli/elements/use.md).

## Manual installation

To install the Element manually instead, save the source below as `basic-captions.element.tsx` in your Remotion project and import its exported component.

## Source

```tsx
import type {Caption} from '@remotion/captions';
import {createTikTokStyleCaptions} from '@remotion/captions';
import React, {useMemo} from 'react';
import {
	Interactive,
	useCurrentFrame,
	useVideoConfig,
	type InteractiveTransformProps,
	type InteractivitySchema,
	type SequenceProps,
} from 'remotion';

type BasicCaptionsProps = InteractiveTransformProps &
	Pick<SequenceProps, 'width'> & {
		readonly captions: Caption[];
		readonly combineTokensWithinMilliseconds?: number;
	};

const defaultCombineTokensWithinMilliseconds = 3000;
const defaultWidth = 900;

const basicCaptionsSchema = {
	...Interactive.captionsSchema,
	width: {
		type: 'number',
		min: 1,
		step: 1,
		default: undefined,
		description: 'Caption area width',
		hiddenFromList: false,
	},
	combineTokensWithinMilliseconds: {
		type: 'number',
		min: 0,
		step: 50,
		default: defaultCombineTokensWithinMilliseconds,
		description: 'Time between caption pages',
		hiddenFromList: false,
	},
} as const satisfies InteractivitySchema;

const BasicCaptionsContent: React.FC<BasicCaptionsProps> = ({
	captions,
	combineTokensWithinMilliseconds = defaultCombineTokensWithinMilliseconds,
	style,
	width = defaultWidth,
}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const pages = useMemo(
		() =>
			createTikTokStyleCaptions({
				captions,
				combineTokensWithinMilliseconds,
			}).pages,
		[captions, combineTokensWithinMilliseconds],
	);
	const currentTimeMs = (frame / fps) * 1000;
	const page = pages.find(
		(candidate) =>
			currentTimeMs >= candidate.startMs &&
			currentTimeMs < candidate.startMs + candidate.durationMs,
	);

	return (
		<div
			style={{
				alignItems: 'center',
				display: 'flex',
				justifyContent: 'center',
				width,
				...style,
			}}
		>
			{page ? (
				<div
					style={{
						backgroundColor: 'rgba(64, 64, 64, 0.75)',
						color: '#ffffff',
						fontFamily: 'Arial, Helvetica, sans-serif',
						fontSize: 64,
						fontWeight: 400,
						lineHeight: 1.2,
						padding: '14px 22px',
						textAlign: 'center',
						textWrap: 'balance',
						whiteSpace: 'pre-wrap',
					}}
				>
					{page.text.trim()}
				</div>
			) : null}
		</div>
	);
};

export const BasicCaptions = Interactive.create({
	Component: BasicCaptionsContent,
	componentName: '<BasicCaptions>',
	schema: basicCaptionsSchema,
});
```

