/// <reference types="vite/client" />
/// <reference types="@react-router/node" />
/// <reference path="./app/lib/bynder/types.d.ts" />

declare namespace JSX {
	interface IntrinsicElements {
		"s-app-nav": React.DetailedHTMLProps<
			React.HTMLAttributes<HTMLElement>,
			HTMLElement
		>;
	}
}
