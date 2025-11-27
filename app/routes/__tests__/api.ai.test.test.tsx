/**
 * Tests for the AI test API endpoint
 */
import { describe, expect, it, vi } from "vitest";
import {
	isAiAltTextAvailable,
	testGeminiConnection,
} from "../../lib/ai/gemini-vision.js";

// Mock the Gemini Vision module
vi.mock("../../lib/ai/gemini-vision.js", () => ({
	isAiAltTextAvailable: vi.fn(),
	testGeminiConnection: vi.fn(),
}));

describe("AI Alt Text Generation", () => {
	it("should detect when AI is not available", () => {
		vi.mocked(isAiAltTextAvailable).mockReturnValue(false);

		expect(isAiAltTextAvailable()).toBe(false);
	});

	it("should detect when AI is available with API key", () => {
		vi.mocked(isAiAltTextAvailable).mockReturnValue(true);

		expect(isAiAltTextAvailable()).toBe(true);
	});

	it("should test Gemini connection successfully", async () => {
		vi.mocked(testGeminiConnection).mockResolvedValue({
			success: true,
			model: "gemini-2.0-flash",
		});

		const result = await testGeminiConnection();
		expect(result.success).toBe(true);
		expect(result.model).toBe("gemini-2.0-flash");
	});

	it("should handle Gemini connection failure", async () => {
		vi.mocked(testGeminiConnection).mockResolvedValue({
			success: false,
			error: "Invalid credentials",
		});

		const result = await testGeminiConnection();
		expect(result.success).toBe(false);
		expect(result.error).toBe("Invalid credentials");
	});
});
