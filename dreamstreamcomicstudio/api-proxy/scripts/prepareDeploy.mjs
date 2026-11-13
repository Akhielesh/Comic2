// CI-only config: keep relative paths beside wrangler.jsonc and supply Docker build args.
// TypeScript is an existing direct dev dependency and parses JSONC without stripping URL comments.
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const gitSha = process.env.GITHUB_SHA;
const buildTimestamp = new Date().toISOString();
if (!gitSha || !/^[a-f0-9]{40}$/i.test(gitSha)) throw new Error('GITHUB_SHA must be a full commit SHA');
const { config, error } = ts.parseConfigFileTextToJson('wrangler.jsonc', readFileSync('wrangler.jsonc', 'utf8'));
if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
const backends = config.containers?.filter((container) => container.class_name === 'Backend');
if (backends?.length !== 1) throw new Error('Expected exactly one Backend container in wrangler.jsonc');
backends[0].image_vars = { ...backends[0].image_vars, GIT_SHA: gitSha, BUILD_TIMESTAMP: buildTimestamp };
// Keep the Worker identity useful for diagnostics while the backend trusts its baked build file.
config.vars = { ...config.vars, GIT_SHA: gitSha, BUILD_TIMESTAMP: buildTimestamp };
writeFileSync('wrangler.deploy.json', `${JSON.stringify(config, null, 2)}\n`);
