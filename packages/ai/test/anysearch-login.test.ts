import { describe, expect, it } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";

const provider = getProviderDefinition("anysearch");
const loginAnySearch = provider?.login;
if (!loginAnySearch) throw new Error("AnySearch login is not registered");

describe("anysearch login", () => {
	it("uses the standard API key login flow without making a validation request", async () => {
		let authUrl: string | undefined;
		let instructions: string | undefined;
		let message: string | undefined;
		const key = await loginAnySearch({
			onAuth: info => {
				authUrl = info.url;
				instructions = info.instructions;
			},
			onPrompt: async prompt => {
				message = prompt.message;
				return "  test-anysearch-key  ";
			},
			fetch: () => {
				throw new Error("AnySearch login must not make a network request");
			},
		});
		expect(authUrl).toBe("https://anysearch.com/console/api-keys");
		expect(instructions).toContain("optional for anonymous search");
		expect(message).toBe("Paste your AnySearch API key");
		expect(key).toBe("test-anysearch-key");
		expect(provider?.envKeys).toBe("ANYSEARCH_API_KEY");
	});
});
