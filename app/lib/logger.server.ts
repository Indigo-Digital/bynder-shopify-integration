/**
 * Custom logger configuration to reduce log verbosity
 * Filters out verbose HTTP request logs and authentication logs
 */

/**
 * Initialize quiet logging by overriding console methods
 * This should be called early in the application startup
 */
export function initializeQuietLogging() {
	const logLevel = process.env.LOG_LEVEL?.toUpperCase() || "WARN";
	const shouldLogInfo = logLevel === "DEBUG";
	const shouldLogHttp = logLevel === "DEBUG";

	// Store original console methods
	const originalLog = console.log.bind(console);
	const originalInfo = console.info.bind(console);
	const originalDebug = console.debug.bind(console);

	// Override console.log to filter HTTP requests
	console.log = (...args: unknown[]) => {
		const message = String(args[0] || "");
		// Filter out HTTP request logs (GET, POST, etc.)
		if (
			message.includes("GET /") ||
			message.includes("POST /") ||
			message.includes("PUT /") ||
			message.includes("DELETE /") ||
			message.includes("PATCH /")
		) {
			if (shouldLogHttp) {
				originalDebug(...args);
			}
			return;
		}
		// Filter out authentication logs
		if (message.includes("Authenticating admin request")) {
			if (shouldLogInfo) {
				originalDebug(...args);
			}
			return;
		}
		// Only log if LOG_LEVEL is DEBUG or INFO
		if (shouldLogInfo) {
			originalLog(...args);
		}
	};

	// Override console.info to filter HTTP requests
	console.info = (...args: unknown[]) => {
		const message = String(args[0] || "");
		// Filter out HTTP request logs
		if (
			message.includes("GET /") ||
			message.includes("POST /") ||
			message.includes("PUT /") ||
			message.includes("DELETE /") ||
			message.includes("PATCH /")
		) {
			if (shouldLogHttp) {
				originalDebug(...args);
			}
			return;
		}
		// Filter out authentication logs
		if (message.includes("Authenticating admin request")) {
			if (shouldLogInfo) {
				originalDebug(...args);
			}
			return;
		}
		// Only log if LOG_LEVEL is DEBUG or INFO
		if (shouldLogInfo) {
			originalInfo(...args);
		}
	};

	// Override console.debug - only show if LOG_LEVEL is DEBUG
	console.debug = (...args: unknown[]) => {
		if (logLevel === "DEBUG") {
			originalDebug(...args);
		}
	};
}
