import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [tsconfigPaths()],
	test: {
		globals: true,
		environment: "jsdom",
		setupFiles: ["./vitest.setup.ts"],
		include: ["**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
		exclude: [
			"node_modules",
			"dist",
			".react-router",
			"build",
			"extensions/**/node_modules",
			"**/node_modules/**",
			// Exclude route handler files (but not test files in __tests__)
			"app/routes/**/!(*.test|*.spec).{ts,tsx}",
		],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			exclude: [
				"node_modules/",
				"dist/",
				".react-router/",
				"build/",
				"**/*.d.ts",
				"**/*.config.*",
				"**/vitest.setup.ts",
				"**/routes/**",
				"**/components/**",
			],
		},
	},
});
