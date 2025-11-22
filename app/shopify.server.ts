import "@shopify/shopify-app-react-router/adapters/node";
import {
	ApiVersion,
	AppDistribution,
	shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { env } from "./lib/env.server";

/**
 * Custom logger that filters out verbose INFO logs
 * Specifically filters out "Authenticating admin request" logs that spam the console
 */
const createQuietLogger = () => {
	const originalConsole = console;
	const logLevel = process.env.LOG_LEVEL?.toUpperCase() || "WARN";

	// Only show INFO logs if LOG_LEVEL is explicitly set to DEBUG
	const shouldLogInfo = logLevel === "DEBUG";

	return {
		log: (...args: unknown[]) => {
			const message = args[0];
			// Filter out verbose authentication logs
			if (
				typeof message === "string" &&
				message.includes("Authenticating admin request")
			) {
				// Only log if LOG_LEVEL is DEBUG
				if (logLevel === "DEBUG") {
					originalConsole.debug(...args);
				}
				return;
			}
			if (shouldLogInfo) {
				originalConsole.log(...args);
			}
		},
		trace: (...args: unknown[]) => {
			if (logLevel === "DEBUG") {
				originalConsole.trace(...args);
			}
		},
		debug: (...args: unknown[]) => {
			if (logLevel === "DEBUG") {
				originalConsole.debug(...args);
			}
		},
		info: (...args: unknown[]) => {
			const message = args[0];
			// Filter out verbose authentication logs
			if (
				typeof message === "string" &&
				message.includes("Authenticating admin request")
			) {
				// Only log if LOG_LEVEL is DEBUG
				if (logLevel === "DEBUG") {
					originalConsole.debug(...args);
				}
				return;
			}
			if (shouldLogInfo) {
				originalConsole.info(...args);
			}
		},
		warn: (...args: unknown[]) => {
			originalConsole.warn(...args);
		},
		error: (...args: unknown[]) => {
			originalConsole.error(...args);
		},
	};
};

const shopifyConfig: {
	apiKey: string;
	apiSecretKey: string;
	apiVersion: ApiVersion;
	scopes?: string[];
	appUrl: string;
	authPathPrefix: string;
	sessionStorage: PrismaSessionStorage<typeof prisma>;
	distribution: AppDistribution;
	customShopDomains?: string[];
	logger?: {
		log: (...args: unknown[]) => void;
		trace: (...args: unknown[]) => void;
		debug: (...args: unknown[]) => void;
		info: (...args: unknown[]) => void;
		warn: (...args: unknown[]) => void;
		error: (...args: unknown[]) => void;
	};
} = {
	apiKey: env.SHOPIFY_API_KEY,
	apiSecretKey: env.SHOPIFY_API_SECRET,
	apiVersion: ApiVersion.October25,
	appUrl: env.SHOPIFY_APP_URL,
	authPathPrefix: "/auth",
	sessionStorage: new PrismaSessionStorage(prisma),
	distribution: AppDistribution.AppStore,
	logger: createQuietLogger(),
};
if (env.SCOPES) {
	shopifyConfig.scopes = env.SCOPES.split(",");
}
if (env.SHOP_CUSTOM_DOMAIN) {
	shopifyConfig.customShopDomains = [env.SHOP_CUSTOM_DOMAIN];
}
const shopify = shopifyApp(shopifyConfig);

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
