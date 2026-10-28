import * as path from "node:path";
import { collabWebName } from "./release";

/** Every npm child gets an explicit clean config; only collab-web receives a token. */
export function npmPublishEnvironment(name: string, source: NodeJS.ProcessEnv, configDir: string): NodeJS.ProcessEnv {
	const env = { ...source };
	for (const key of Object.keys(env)) {
		if (
			/^(?:NODE_AUTH_TOKEN|NPM_TOKEN|COLLAB_WEB_NPM_TOKEN)$/i.test(key) ||
			/^npm_config_.*(?:token|auth|userconfig|globalconfig)/i.test(key)
		)
			delete env[key];
	}
	env.NPM_CONFIG_GLOBALCONFIG = path.join(configDir, "global.npmrc");
	env.NPM_CONFIG_USERCONFIG = path.join(configDir, "oidc.npmrc");
	if (name === collabWebName) {
		delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
		delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
		const token = source.COLLAB_WEB_NPM_TOKEN;
		if (!token) throw new Error("NPM_TOKEN repository secret is required for collab-web publishing");
		env.NODE_AUTH_TOKEN = token;
		env.NPM_CONFIG_USERCONFIG = path.join(configDir, "token.npmrc");
	}
	return env;
}
