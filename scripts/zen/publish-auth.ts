import * as path from "node:path";

/** Every npm child gets an explicit token-free config and retains OIDC credentials. */
export function npmPublishEnvironment(source: NodeJS.ProcessEnv, configDir: string): NodeJS.ProcessEnv {
	const env = { ...source };
	for (const key of Object.keys(env)) {
		if (
			/^(?:NODE_AUTH_TOKEN|(?:.*_)?NPM_TOKEN)$/i.test(key) ||
			/^npm_config_.*(?:token|auth|userconfig|globalconfig)/i.test(key)
		)
			delete env[key];
	}
	env.NPM_CONFIG_GLOBALCONFIG = path.join(configDir, "global.npmrc");
	env.NPM_CONFIG_USERCONFIG = path.join(configDir, "oidc.npmrc");
	return env;
}
