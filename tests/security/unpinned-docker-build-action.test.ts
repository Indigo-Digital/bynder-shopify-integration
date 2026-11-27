import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Registry credential left by `docker login` for a later step to read.
 * Placeholder only — never a real secret.
 */
const PLACEHOLDER_USERNAME = "placeholder-registry-user";
const PLACEHOLDER_PASSWORD = "placeholder-registry-password";
const PLACEHOLDER_REFRESH_TOKEN = "placeholder-refresh-token";

/** docker CLI v28.0.4 registry.IndexServer. Login to docker.io stores under this key. */
const DOCKER_HUB_INDEX = "https://index.docker.io/v1/";

type YamlValue =
	| string
	| number
	| boolean
	| null
	| YamlValue[]
	| { [key: string]: YamlValue };

interface WorkflowStep {
	name?: string;
	uses?: string;
	run?: string;
	with?: Record<string, string>;
	env?: Record<string, string>;
}

interface Exposure {
	workflow: string;
	job: string;
	step: string;
	phase: "main" | "post";
	uses: string;
	via: "action-input" | "docker-config";
}

interface StoredCredential {
	server: string;
	/** Password recovered from auths[server].auth, when docker stored one. */
	password: string;
	/** Refresh token recovered from auths[server].identitytoken, when docker stored one. */
	refreshToken: string;
}

/**
 * Same JSON shape docker CLI v28.0.4 file store writes.
 * When the registry returns a refresh token, login clears the password and
 * stores that token. When it does not, the password is base64-encoded in auth.
 */
function writeDockerConfigFile(
	configDir: string,
	server: string,
	username: string,
	password: string,
	refreshToken: string
): void {
	const storedPassword = refreshToken ? "" : password;
	const auth =
		username || storedPassword
			? Buffer.from(`${username}:${storedPassword}`, "utf8").toString("base64")
			: "";
	const entry: Record<string, string> = {};
	if (auth) {
		entry.auth = auth;
	}
	if (refreshToken) {
		entry.identitytoken = refreshToken;
	}
	fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
	const body = { auths: { [server]: entry } };
	fs.writeFileSync(
		path.join(configDir, "config.json"),
		`${JSON.stringify(body, null, "\t")}\n`,
		{ mode: 0o600 }
	);
}

function eraseDockerConfigEntry(configDir: string, server: string): void {
	const configPath = path.join(configDir, "config.json");
	if (!fs.existsSync(configPath)) {
		return;
	}
	const document = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
		auths?: Record<string, unknown>;
	};
	if (document.auths) {
		delete document.auths[server];
	}
	fs.writeFileSync(configPath, `${JSON.stringify(document, null, "\t")}\n`);
}

/**
 * A separate process, standing in for the next action's node process,
 * reads the docker config file and returns whatever credential it finds.
 */
function readCredentialFromOtherProcess(
	configDir: string,
	server: string
): StoredCredential {
	const configPath = path.join(configDir, "config.json");
	const result = spawnSync(
		process.execPath,
		[
			"-e",
			[
				"const fs = require('fs');",
				"const file = process.argv[1];",
				"const server = process.argv[2];",
				"if (!fs.existsSync(file)) { process.stdout.write('{}'); process.exit(0); }",
				"const doc = JSON.parse(fs.readFileSync(file, 'utf8'));",
				"const entry = (doc.auths || {})[server] || {};",
				"const decoded = Buffer.from(entry.auth || '', 'base64').toString('utf8');",
				"const splitAt = decoded.indexOf(':');",
				"const password = splitAt === -1 ? '' : decoded.slice(splitAt + 1);",
				"process.stdout.write(JSON.stringify({ password, refreshToken: entry.identitytoken || '' }));",
			].join(""),
			configPath,
			server,
		],
		{ encoding: "utf8" }
	);
	if (result.status !== 0) {
		throw new Error(result.stderr || "credential reader failed");
	}
	const parsed = JSON.parse(result.stdout) as {
		password?: string;
		refreshToken?: string;
	};
	return {
		server,
		password: parsed.password ?? "",
		refreshToken: parsed.refreshToken ?? "",
	};
}

function credentialIsReadable(credential: StoredCredential): boolean {
	return credential.password.length > 0 || credential.refreshToken.length > 0;
}

function isFullCommitSha(ref: string): boolean {
	return /^[0-9a-f]{40}$/i.test(ref);
}

/** Tag, branch, and short SHA refs move. A 40-character commit SHA does not. */
function actionRefIsUnpinned(uses: string): boolean {
	if (uses.startsWith("./") || uses.startsWith("$/")) {
		return false;
	}
	const at = uses.lastIndexOf("@");
	if (at === -1) {
		return true;
	}
	const ref = uses.slice(at + 1);
	if (ref.startsWith("sha256:")) {
		return false;
	}
	return !isFullCommitSha(ref);
}

function dockerHubServer(registry: string | undefined): string {
	if (!registry || registry === "docker.io" || registry === "index.docker.io") {
		return DOCKER_HUB_INDEX;
	}
	return registry;
}

/**
 * `docker logout` with no argument erases the Docker Hub index key.
 * `docker logout docker.io` does not: logout.go only special-cases an empty
 * server address as the index, and login-action passes "docker.io".
 */
function serversErasedByDockerLogout(argument: string | undefined): string[] {
	if (!argument) {
		return [DOCKER_HUB_INDEX];
	}
	if (argument === DOCKER_HUB_INDEX) {
		return [DOCKER_HUB_INDEX, "index.docker.io", "https://index.docker.io"];
	}
	const withoutScheme = argument.replace(/^https?:\/\//, "");
	const host = withoutScheme.split("/")[0] ?? withoutScheme;
	return [argument, host, `http://${host}`, `https://${host}`];
}

function logoutArgumentFromRunScript(
	script: string
): string | undefined | null {
	const match = script.match(/(?:^|[;&|\n])\s*docker\s+logout(?:\s+(\S+))?/);
	if (!match) {
		return null;
	}
	return match[1];
}

function inputValue(step: WorkflowStep, key: string): string | undefined {
	const raw = step.with?.[key];
	return raw === undefined ? undefined : String(raw);
}

function referencesSecret(value: string | undefined): boolean {
	return Boolean(value?.includes("secrets."));
}

function stepReceivesRegistryPassword(step: WorkflowStep): boolean {
	const password = inputValue(step, "password");
	if (referencesSecret(password) || (password && password.length > 0)) {
		return true;
	}
	const envPassword = step.env?.DOCKER_PASSWORD ?? step.env?.password;
	return referencesSecret(envPassword) || Boolean(envPassword);
}

function isLoginAction(step: WorkflowStep): boolean {
	return Boolean(step.uses?.startsWith("docker/login-action@"));
}

function isDockerLoginRun(step: WorkflowStep): boolean {
	return Boolean(step.run && /\bdocker\s+login\b/.test(step.run));
}

interface SimStep {
	step: WorkflowStep;
	phase: "main" | "post";
}

/**
 * Actions in this workflow have no `pre:` entry. The runner therefore runs
 * every main step, registering each post hook as that main step runs, and
 * then runs the post hooks in reverse.
 */
function executionOrder(steps: WorkflowStep[]): SimStep[] {
	const mains = steps.map((step) => ({ step, phase: "main" as const }));
	const posts: SimStep[] = [];
	for (const step of steps) {
		if (step.uses) {
			posts.push({ step, phase: "post" });
		}
	}
	posts.reverse();
	return [...mains, ...posts];
}

function stepLabel(step: WorkflowStep): string {
	return step.name || step.uses || step.run || "(unnamed step)";
}

function simulateJob(
	workflow: string,
	job: string,
	steps: WorkflowStep[],
	configDir: string
): Exposure[] {
	const exposures: Exposure[] = [];
	let server = DOCKER_HUB_INDEX;

	const recordIfUnpinned = (
		step: WorkflowStep,
		phase: "main" | "post",
		via: Exposure["via"]
	) => {
		if (!step.uses || !actionRefIsUnpinned(step.uses)) {
			return;
		}
		exposures.push({
			workflow,
			job,
			step: stepLabel(step),
			phase,
			uses: step.uses,
			via,
		});
	};

	for (const { step, phase } of executionOrder(steps)) {
		if (phase === "main" && (isLoginAction(step) || isDockerLoginRun(step))) {
			if (!stepReceivesRegistryPassword(step)) {
				continue;
			}
			server = dockerHubServer(inputValue(step, "registry"));
			recordIfUnpinned(step, phase, "action-input");
			const refreshToken = inputValue(step, "refresh-token-for-test") ?? "";
			writeDockerConfigFile(
				configDir,
				server,
				PLACEHOLDER_USERNAME,
				PLACEHOLDER_PASSWORD,
				refreshToken
			);
			continue;
		}

		if (phase === "post" && isLoginAction(step)) {
			const logout = inputValue(step, "logout");
			if (logout === "false") {
				continue;
			}
			const registry = inputValue(step, "registry") || "docker.io";
			for (const erased of serversErasedByDockerLogout(registry)) {
				eraseDockerConfigEntry(configDir, erased);
			}
			continue;
		}

		if (phase === "main" && step.run) {
			if (
				/rm\s+-[rfR]+\s+\S*\.docker\b/.test(step.run) ||
				step.run.includes("config.json")
			) {
				fs.rmSync(configDir, { recursive: true, force: true });
				fs.mkdirSync(configDir, { recursive: true });
			}
			const logoutArgument = logoutArgumentFromRunScript(step.run);
			if (logoutArgument !== null) {
				for (const erased of serversErasedByDockerLogout(logoutArgument)) {
					eraseDockerConfigEntry(configDir, erased);
				}
			}
		}

		if (!step.uses) {
			continue;
		}
		const credential = readCredentialFromOtherProcess(configDir, server);
		if (credentialIsReadable(credential)) {
			recordIfUnpinned(step, phase, "docker-config");
		}
	}

	return exposures;
}

function asRecord(
	value: YamlValue | undefined
): Record<string, YamlValue> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return value;
}

function asString(value: YamlValue | undefined): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "boolean" || typeof value === "number") {
		return String(value);
	}
	return undefined;
}

function stringMap(
	value: YamlValue | undefined
): Record<string, string> | undefined {
	const record = asRecord(value);
	if (!record) {
		return undefined;
	}
	const mapped: Record<string, string> = {};
	for (const [key, entry] of Object.entries(record)) {
		const text = asString(entry);
		if (text !== undefined) {
			mapped[key] = text;
		}
	}
	return mapped;
}

function readSteps(value: YamlValue | undefined): WorkflowStep[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const steps: WorkflowStep[] = [];
	for (const entry of value) {
		const record = asRecord(entry);
		if (!record) {
			continue;
		}
		const step: WorkflowStep = {};
		const name = asString(record.name);
		const uses = asString(record.uses);
		const run = asString(record.run);
		const withInputs = stringMap(record.with);
		const env = stringMap(record.env);
		if (name !== undefined) {
			step.name = name;
		}
		if (uses !== undefined) {
			step.uses = uses;
		}
		if (run !== undefined) {
			step.run = run;
		}
		if (withInputs !== undefined) {
			step.with = withInputs;
		}
		if (env !== undefined) {
			step.env = env;
		}
		steps.push(step);
	}
	return steps;
}

function workflowRunsOnPushToMain(root: Record<string, YamlValue>): boolean {
	const on = root.on;
	if (on === "push") {
		return true;
	}
	if (Array.isArray(on) && on.map(String).includes("push")) {
		return true;
	}
	const onRecord = asRecord(on);
	if (!onRecord || !("push" in onRecord)) {
		return false;
	}
	const push = onRecord.push;
	if (push === null || push === true) {
		return true;
	}
	const branches = asRecord(push)?.branches;
	if (!branches) {
		return true;
	}
	const list = Array.isArray(branches)
		? branches.map(String)
		: [String(branches)];
	return list.some(
		(branch) =>
			branch === "main" ||
			branch === "master" ||
			branch === "*" ||
			branch === "**"
	);
}

function splitTopLevel(expression: string, operator: "||" | "&&"): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let index = 0; index < expression.length; index++) {
		const char = expression[index];
		if (quote) {
			current += char;
			if (char === quote) {
				quote = null;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		if (expression.startsWith(operator, index)) {
			parts.push(current);
			current = "";
			index += operator.length - 1;
			continue;
		}
		current += char;
	}
	parts.push(current);
	return parts;
}

function comparisonHolds(atom: string, ref: string): boolean {
	const equals = atom.match(/^github\.ref\s*==\s*['"]([^'"]+)['"]$/);
	if (equals) {
		return ref === equals[1];
	}
	const differs = atom.match(/^github\.ref\s*!=\s*['"]([^'"]+)['"]$/);
	if (differs) {
		return ref !== differs[1];
	}
	if (atom === "true" || atom === "always()") {
		return true;
	}
	if (atom === "false") {
		return false;
	}
	return true;
}

function jobRunsForRef(ifExpression: string | undefined, ref: string): boolean {
	if (!ifExpression) {
		return true;
	}
	const expression = ifExpression
		.replace(/^\$\{\{\s*/, "")
		.replace(/\s*\}\}$/, "")
		.trim();
	return splitTopLevel(expression, "||").some((orPart) =>
		splitTopLevel(orPart, "&&").every((atom) =>
			comparisonHolds(atom.trim(), ref)
		)
	);
}

function exposuresInWorkflow(
	workflowName: string,
	source: string,
	ref: string
): Exposure[] {
	const root = parseWorkflowYaml(source);
	if (!workflowRunsOnPushToMain(root)) {
		return [];
	}
	const jobs = asRecord(root.jobs);
	if (!jobs) {
		return [];
	}
	const exposures: Exposure[] = [];
	for (const [jobName, jobValue] of Object.entries(jobs)) {
		const job = asRecord(jobValue);
		if (!job) {
			continue;
		}
		if (!jobRunsForRef(asString(job.if), ref)) {
			continue;
		}
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-config-"));
		try {
			exposures.push(
				...simulateJob(workflowName, jobName, readSteps(job.steps), configDir)
			);
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	}
	return exposures;
}

function exposuresInRepository(ref: string): Exposure[] {
	const workflowsDir = path.resolve(".github/workflows");
	const exposures: Exposure[] = [];
	for (const fileName of fs.readdirSync(workflowsDir)) {
		if (!fileName.endsWith(".yml") && !fileName.endsWith(".yaml")) {
			continue;
		}
		const source = fs.readFileSync(path.join(workflowsDir, fileName), "utf8");
		exposures.push(...exposuresInWorkflow(fileName, source, ref));
	}
	return exposures;
}

interface YamlLine {
	indent: number;
	text: string;
}

function stripInlineComment(text: string): string {
	let quote: string | null = null;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quote) {
			if (char === quote) {
				quote = null;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "#" && (index === 0 || text[index - 1] === " ")) {
			return text.slice(0, index).trimEnd();
		}
	}
	return text.trimEnd();
}

function tokenizeWorkflow(source: string): YamlLine[] {
	const lines: YamlLine[] = [];
	const rawLines = source.split(/\r?\n/);
	for (let index = 0; index < rawLines.length; index++) {
		const raw = rawLines[index] ?? "";
		if (raw.trim() === "" || raw.trimStart().startsWith("#")) {
			continue;
		}
		const indent = raw.match(/^ */)?.[0].length ?? 0;
		const text = stripInlineComment(raw.slice(indent));
		if (text.endsWith("|") || text.endsWith("|-") || text.endsWith("|+")) {
			const block: string[] = [];
			while (index + 1 < rawLines.length) {
				const next = rawLines[index + 1] ?? "";
				if (next.trim() === "") {
					block.push("");
					index++;
					continue;
				}
				const nextIndent = next.match(/^ */)?.[0].length ?? 0;
				if (nextIndent <= indent) {
					break;
				}
				block.push(next.slice(indent + 2));
				index++;
			}
			lines.push({
				indent,
				text: `${text} ${JSON.stringify(block.join("\n"))}`,
			});
			continue;
		}
		lines.push({ indent, text });
	}
	return lines;
}

function parseScalar(raw: string): YamlValue {
	const text = raw.trim();
	if (text === "true") {
		return true;
	}
	if (text === "false") {
		return false;
	}
	if (text === "null" || text === "~" || text === "") {
		return null;
	}
	if (text.startsWith("[") && text.endsWith("]")) {
		const inner = text.slice(1, -1).trim();
		if (!inner) {
			return [];
		}
		return inner.split(",").map((part) => parseScalar(part.trim()));
	}
	if (
		(text.startsWith('"') && text.endsWith('"')) ||
		(text.startsWith("'") && text.endsWith("'"))
	) {
		return text.slice(1, -1);
	}
	return text;
}

function splitKey(text: string): { key: string; value?: string } {
	let quote: string | null = null;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quote) {
			if (char === quote) {
				quote = null;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (
			char === ":" &&
			(index === text.length - 1 || text[index + 1] === " ")
		) {
			const key = unquote(text.slice(0, index).trim());
			const rest = text.slice(index + 1).trim();
			return rest ? { key, value: rest } : { key };
		}
	}
	throw new Error(`expected a YAML key in: ${text}`);
}

function unquote(text: string): string {
	if (
		(text.startsWith('"') && text.endsWith('"')) ||
		(text.startsWith("'") && text.endsWith("'"))
	) {
		return text.slice(1, -1);
	}
	return text;
}

function lineAt(lines: YamlLine[], index: number): YamlLine {
	const line = lines[index];
	if (!line) {
		throw new Error(`workflow parse went past the end at index ${index}`);
	}
	return line;
}

function parseNode(
	lines: YamlLine[],
	index: number,
	minIndent: number
): { value: YamlValue; index: number } {
	const current = lines[index];
	if (index >= lines.length || !current || current.indent < minIndent) {
		return { value: null, index };
	}
	if (current.text.startsWith("- ")) {
		return parseSequence(lines, index);
	}
	return parseMapping(lines, index);
}

function parseSequence(
	lines: YamlLine[],
	index: number
): { value: YamlValue; index: number } {
	const indent = lineAt(lines, index).indent;
	const items: YamlValue[] = [];
	while (index < lines.length) {
		const current = lineAt(lines, index);
		if (current.indent !== indent || !current.text.startsWith("- ")) {
			break;
		}
		const content = current.text.slice(2);
		index++;
		if (content === "") {
			const nested = parseNode(lines, index, indent + 1);
			items.push(nested.value);
			index = nested.index;
			continue;
		}
		if (isKeyLine(content)) {
			const map: Record<string, YamlValue> = {};
			const first = splitKey(content);
			index = assignMappingEntry(lines, index, indent, map, first);
			items.push(map);
			continue;
		}
		items.push(parseScalar(content));
	}
	return { value: items, index };
}

function isKeyLine(text: string): boolean {
	let quote: string | null = null;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quote) {
			if (char === quote) {
				quote = null;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (
			char === ":" &&
			(index === text.length - 1 || text[index + 1] === " ")
		) {
			return true;
		}
	}
	return false;
}

function assignMappingEntry(
	lines: YamlLine[],
	index: number,
	parentIndent: number,
	map: Record<string, YamlValue>,
	entry: { key: string; value?: string }
): number {
	if (entry.value === undefined) {
		const nested = parseNode(lines, index, parentIndent + 1);
		map[entry.key] = nested.value ?? {};
		return nested.index;
	}
	if (entry.value === "|" || entry.value === "|-" || entry.value === "|+") {
		const nested = parseNode(lines, index, parentIndent + 1);
		map[entry.key] = nested.value ?? "";
		return nested.index;
	}
	map[entry.key] = parseScalar(entry.value);
	while (index < lines.length) {
		const siblingLine = lineAt(lines, index);
		if (
			siblingLine.indent <= parentIndent ||
			siblingLine.text.startsWith("- ")
		) {
			break;
		}
		const siblingIndent = siblingLine.indent;
		const sibling = splitKey(siblingLine.text);
		index++;
		index = assignMappingEntry(lines, index, siblingIndent, map, sibling);
	}
	return index;
}

function parseMapping(
	lines: YamlLine[],
	index: number
): { value: YamlValue; index: number } {
	const indent = lineAt(lines, index).indent;
	const map: Record<string, YamlValue> = {};
	while (index < lines.length) {
		const current = lineAt(lines, index);
		if (current.indent !== indent || current.text.startsWith("- ")) {
			break;
		}
		const entry = splitKey(current.text);
		index++;
		index = assignMappingEntry(lines, index, indent, map, entry);
	}
	return { value: map, index };
}

function parseWorkflowYaml(source: string): Record<string, YamlValue> {
	const lines = tokenizeWorkflow(source);
	const parsed = parseNode(lines, 0, 0);
	const root = asRecord(parsed.value);
	if (!root) {
		throw new Error("workflow root must be a mapping");
	}
	return root;
}

const PINNED_SHA = "ca052bb54ab0790a636c9b5f226502c73d547a25";

const FIXED_BY_REMOVING_LOGIN = `
name: CI
on:
  push:
    branches: [main]
jobs:
  docker-build:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/build-push-action@v5
        with:
          push: false
`;

const FIXED_BY_PINNING_ACTIONS_THAT_CAN_READ = `
name: CI
on:
  push:
    branches: [main]
jobs:
  docker-build:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${PINNED_SHA}
      - uses: docker/setup-buildx-action@${PINNED_SHA}
      - uses: docker/login-action@${PINNED_SHA}
        with:
          username: \${{ secrets.DOCKER_USERNAME }}
          password: \${{ secrets.DOCKER_PASSWORD }}
      - uses: docker/build-push-action@${PINNED_SHA}
        with:
          push: false
`;

describe("docker login credential file", () => {
	it("lets a later process read the password when the registry returns no refresh token", () => {
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-config-"));
		try {
			writeDockerConfigFile(
				configDir,
				DOCKER_HUB_INDEX,
				PLACEHOLDER_USERNAME,
				PLACEHOLDER_PASSWORD,
				""
			);
			const recovered = readCredentialFromOtherProcess(
				configDir,
				DOCKER_HUB_INDEX
			);
			expect(recovered.password).toBe(PLACEHOLDER_PASSWORD);
			expect(recovered.refreshToken).toBe("");
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});

	it("lets a later process read the refresh token when the registry returns one", () => {
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-config-"));
		try {
			writeDockerConfigFile(
				configDir,
				"127.0.0.1:5601",
				PLACEHOLDER_USERNAME,
				PLACEHOLDER_PASSWORD,
				PLACEHOLDER_REFRESH_TOKEN
			);
			const recovered = readCredentialFromOtherProcess(
				configDir,
				"127.0.0.1:5601"
			);
			expect(recovered.refreshToken).toBe(PLACEHOLDER_REFRESH_TOKEN);
			expect(recovered.password).toBe("");
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});

	it("treats docker logout docker.io as leaving the Docker Hub index credential in place", () => {
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-config-"));
		try {
			writeDockerConfigFile(
				configDir,
				DOCKER_HUB_INDEX,
				PLACEHOLDER_USERNAME,
				PLACEHOLDER_PASSWORD,
				""
			);
			for (const server of serversErasedByDockerLogout("docker.io")) {
				eraseDockerConfigEntry(configDir, server);
			}
			const recovered = readCredentialFromOtherProcess(
				configDir,
				DOCKER_HUB_INDEX
			);
			expect(recovered.password).toBe(PLACEHOLDER_PASSWORD);
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});

	it("treats docker logout with no argument as erasing the Docker Hub index credential", () => {
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-config-"));
		try {
			writeDockerConfigFile(
				configDir,
				DOCKER_HUB_INDEX,
				PLACEHOLDER_USERNAME,
				PLACEHOLDER_PASSWORD,
				""
			);
			for (const server of serversErasedByDockerLogout(undefined)) {
				eraseDockerConfigEntry(configDir, server);
			}
			const recovered = readCredentialFromOtherProcess(
				configDir,
				DOCKER_HUB_INDEX
			);
			expect(credentialIsReadable(recovered)).toBe(false);
		} finally {
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});
});

describe("registry credentials in workflows that run on push to main", () => {
	it("does not leave a registry credential where an unpinned action can read it", () => {
		const exposures = exposuresInRepository("refs/heads/main");
		expect(exposures).toEqual([]);
	});

	it("does not treat a pull request ref as running the docker-build job", () => {
		const exposures = exposuresInRepository("refs/pull/1/merge");
		expect(exposures).toEqual([]);
	});

	it("passes when the job does not log in to a registry", () => {
		const exposures = exposuresInWorkflow(
			"fixed.yml",
			FIXED_BY_REMOVING_LOGIN,
			"refs/heads/main"
		);
		expect(exposures).toEqual([]);
	});

	it("passes when every action that runs while the credential is stored is pinned to a commit SHA", () => {
		const exposures = exposuresInWorkflow(
			"fixed.yml",
			FIXED_BY_PINNING_ACTIONS_THAT_CAN_READ,
			"refs/heads/main"
		);
		expect(exposures).toEqual([]);
	});

	it("still fails when logout is left at its default and the next action is only pinned to a tag", () => {
		const source = `
name: CI
on: push
jobs:
  docker-build:
    steps:
      - uses: docker/login-action@${PINNED_SHA}
        with:
          password: \${{ secrets.DOCKER_PASSWORD }}
          username: \${{ secrets.DOCKER_USERNAME }}
      - uses: docker/build-push-action@v5
`;
		const exposures = exposuresInWorkflow(
			"still-vulnerable.yml",
			source,
			"refs/heads/main"
		);
		expect(exposures.map((exposure) => exposure.uses)).toContain(
			"docker/build-push-action@v5"
		);
	});

	it("still fails when an earlier unpinned action's post step runs after a docker.io logout", () => {
		const source = `
name: CI
on:
  push:
    branches: [main]
jobs:
  docker-build:
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@${PINNED_SHA}
        with:
          logout: true
          password: \${{ secrets.DOCKER_PASSWORD }}
          username: \${{ secrets.DOCKER_USERNAME }}
      - uses: docker/build-push-action@${PINNED_SHA}
`;
		const exposures = exposuresInWorkflow(
			"post-still-reads.yml",
			source,
			"refs/heads/main"
		);
		expect(
			exposures.some(
				(exposure) =>
					exposure.uses === "actions/checkout@v4" && exposure.phase === "post"
			)
		).toBe(true);
	});

	it("passes when a run step logs out of the index before any later unpinned action", () => {
		const source = `
name: CI
on: push
jobs:
  docker-build:
    steps:
      - uses: docker/login-action@${PINNED_SHA}
        with:
          password: \${{ secrets.DOCKER_PASSWORD }}
          username: \${{ secrets.DOCKER_USERNAME }}
      - run: docker logout
      - uses: docker/build-push-action@v5
`;
		const exposures = exposuresInWorkflow(
			"logged-out.yml",
			source,
			"refs/heads/main"
		);
		expect(exposures).toEqual([]);
	});
});
