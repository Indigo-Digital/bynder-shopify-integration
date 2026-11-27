// @vitest-environment node
/**
 * Spec for the image-release workflow.
 *
 * A push to main runs docker-build and deploy-flyio. Those jobs pass
 * repository secrets into steps that share a runner with third-party actions.
 * A full commit SHA is immutable. Any other action ref is a git ref the
 * action owner can move, and the moved commit runs inside the job.
 *
 * The published-workflow test fails until every third-party action in a job
 * that references a secret is pinned to a 40-character commit SHA.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PLACEHOLDER_REGISTRY_USERNAME = "PLACEHOLDER_REGISTRY_USERNAME";
const PLACEHOLDER_REGISTRY_PASSWORD = "PLACEHOLDER_REGISTRY_PASSWORD";
const PLACEHOLDER_FLY_API_TOKEN = "PLACEHOLDER_FLY_API_TOKEN";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../.."
);
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github/workflows/ci-cd.yml");

const SECRETS: Record<string, string> = {
	DOCKER_USERNAME: PLACEHOLDER_REGISTRY_USERNAME,
	DOCKER_PASSWORD: PLACEHOLDER_REGISTRY_PASSWORD,
	FLY_API_TOKEN: PLACEHOLDER_FLY_API_TOKEN,
};

type YamlMap = { [key: string]: YamlValue };
type YamlValue = string | YamlValue[] | YamlMap;

interface Step {
	uses?: string;
	run?: string;
	continueOnError: boolean;
	with: Record<string, string>;
	env: Record<string, string>;
}

interface Job {
	name: string;
	ifExpr?: string;
	steps: Step[];
}

interface WorkflowModel {
	pushBranches: string[];
	jobs: Job[];
}

interface ActionRepo {
	directory: string;
	benignSha: string;
	maliciousSha: string;
}

const BENIGN_ACTION = `import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const password = (process.env.INPUT_PASSWORD ?? "").trim();
const username = (process.env.INPUT_USERNAME ?? "").trim();
if (!password || !username) {
	process.exit(0);
}

const pathValue = process.env.PATH ?? "";
let docker;
for (const dir of pathValue.split(path.delimiter)) {
	if (!dir) continue;
	const candidate = path.join(dir, "docker");
	try {
		fs.accessSync(candidate, fs.constants.X_OK);
		docker = candidate;
		break;
	} catch {
		// PATH is searched from front to back.
	}
}
if (!docker) process.exit(1);

const result = spawnSync(
	docker,
	["login", "--password-stdin", "--username", username, "docker.io"],
	{ input: Buffer.from(password), env: process.env }
);
process.exit(result.status === null ? 1 : result.status);
`;

const MALICIOUS_ACTION = `import fs from "node:fs";
import path from "node:path";

const capture = process.env.CAPTURE_FILE ?? "";
const hijack = process.env.HIJACK_BIN ?? "";
fs.mkdirSync(hijack, { recursive: true });

function writeExecutable(name, body) {
	const script = path.join(hijack, name);
	fs.writeFileSync(script, body, { mode: 0o755 });
	return script;
}

const captureLiteral = JSON.stringify(capture);
writeExecutable(
	"docker",
	"#!/bin/sh\\n" +
		"capture=" + captureLiteral + "\\n" +
		"cat >> \\"$capture\\"\\n"
);
writeExecutable(
	"flyctl",
	"#!/bin/sh\\n" +
		"capture=" + captureLiteral + "\\n" +
		"printf '%s' \\"$FLY_API_TOKEN\\" >> \\"$capture\\"\\n"
);

if (process.env.GITHUB_PATH) {
	fs.appendFileSync(process.env.GITHUB_PATH, hijack + "\\n");
}

for (const [key, value] of Object.entries(process.env)) {
	if (key.startsWith("INPUT_") && value) {
		fs.appendFileSync(capture, value);
	}
}

const home = process.env.HOME ?? "";
const configPath = path.join(home, ".docker", "config.json");
if (fs.existsSync(configPath)) {
	const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
	const auths = config.auths ?? {};
	for (const auth of Object.values(auths)) {
		if (auth && typeof auth.auth === "string") {
			fs.appendFileSync(capture, Buffer.from(auth.auth, "base64").toString("utf8"));
		}
	}
}
`;

let actionRepo: ActionRepo | undefined;

function git(repo: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`
		);
	}
	return (result.stdout ?? "").trim();
}

function createActionRepo(root: string): ActionRepo {
	const directory = path.join(root, "action");
	fs.mkdirSync(directory, { recursive: true });
	git(directory, ["init", "-b", "main"]);
	git(directory, ["config", "user.email", "actions-test@example.com"]);
	git(directory, ["config", "user.name", "actions-test"]);
	fs.writeFileSync(path.join(directory, "action.mjs"), BENIGN_ACTION);
	git(directory, ["add", "action.mjs"]);
	git(directory, ["commit", "-m", "benign action"]);
	const benignSha = git(directory, ["rev-parse", "HEAD"]);
	fs.writeFileSync(path.join(directory, "action.mjs"), MALICIOUS_ACTION);
	git(directory, ["add", "action.mjs"]);
	git(directory, ["commit", "-m", "malicious action"]);
	const maliciousSha = git(directory, ["rev-parse", "HEAD"]);
	return { directory, benignSha, maliciousSha };
}

function refStorage(ref: string): string {
	if (ref === "master" || ref === "main") return `refs/heads/${ref}`;
	return `refs/tags/${ref}`;
}

function moveRef(repo: ActionRepo, ref: string): void {
	git(repo.directory, ["update-ref", refStorage(ref), repo.maliciousSha]);
}

function isFullCommitSha(ref: string): boolean {
	return /^[0-9a-f]{40}$/i.test(ref);
}

function actionRef(uses: string): string {
	const at = uses.lastIndexOf("@");
	if (at <= 0) {
		throw new Error(`Action is missing a ref: ${uses}`);
	}
	return uses.slice(at + 1);
}

function showAction(repo: ActionRepo, rev: string): string | undefined {
	const result = spawnSync("git", ["show", `${rev}:action.mjs`], {
		cwd: repo.directory,
		encoding: "utf8",
	});
	if (result.status !== 0) return undefined;
	return result.stdout ?? undefined;
}

function resolveActionSource(repo: ActionRepo, uses: string): string {
	const ref = actionRef(uses);
	if (isFullCommitSha(ref)) {
		return showAction(repo, ref) ?? showAction(repo, repo.benignSha) ?? "";
	}
	moveRef(repo, ref);
	const source = showAction(repo, refStorage(ref));
	if (!source) throw new Error(`Could not resolve ${uses}`);
	return source;
}

function isMap(value: YamlValue | undefined): value is YamlMap {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isList(value: YamlValue | undefined): value is YamlValue[] {
	return Array.isArray(value);
}

function asString(value: YamlValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function splitYamlKey(
	text: string
): { key: string; value: string } | undefined {
	const match = /^([^:]+):(.*)$/.exec(text);
	const key = match?.[1]?.trim();
	if (!key) return undefined;
	return { key, value: (match?.[2] ?? "").trim() };
}

function unquote(value: string): string {
	const quoted =
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"));
	return quoted ? value.slice(1, -1) : value;
}

function parseScalar(value: string): YamlValue {
	if (value.startsWith("[") && value.endsWith("]")) {
		const inner = value.slice(1, -1).trim();
		if (!inner) return [];
		return inner.split(",").map((part) => unquote(part.trim()));
	}
	return unquote(value);
}

function parseWorkflowYaml(source: string): YamlMap {
	const lines = source.split("\n");
	const root: YamlMap = {};
	const stack: Array<{ indent: number; container: YamlMap | YamlValue[] }> = [
		{ indent: -1, container: root },
	];

	function top(): { indent: number; container: YamlMap | YamlValue[] } {
		const frame = stack[stack.length - 1];
		if (!frame) throw new Error("YAML stack underflow");
		return frame;
	}

	for (let index = 0; index < lines.length; index += 1) {
		const raw = (lines[index] ?? "").replace(/\r$/, "");
		if (/^\s*$/.test(raw) || /^\s*#/.test(raw)) continue;
		const indent = raw.search(/\S/);
		const trimmed = raw.trim();
		while (stack.length > 1 && indent <= top().indent) stack.pop();
		const parent = top();

		if (trimmed.startsWith("- ")) {
			if (!isList(parent.container)) {
				throw new Error(`List item outside a list at line ${index + 1}`);
			}
			const item = splitYamlKey(trimmed.slice(2));
			if (!item) {
				parent.container.push(parseScalar(trimmed.slice(2)));
				continue;
			}
			const map: YamlMap = {};
			if (item.value === "") {
				const nested: YamlMap = {};
				map[item.key] = nested;
				parent.container.push(map);
				stack.push({ indent, container: map });
				stack.push({ indent: indent + 1, container: nested });
			} else {
				map[item.key] = parseScalar(item.value);
				parent.container.push(map);
				stack.push({ indent, container: map });
			}
			continue;
		}

		const key = splitYamlKey(trimmed);
		if (!key || isList(parent.container)) {
			throw new Error(`Expected a mapping entry at line ${index + 1}`);
		}
		if (key.value === "") {
			const next = nextContent(lines, index + 1);
			const container: YamlMap | YamlValue[] = next?.trimmed.startsWith("- ")
				? []
				: {};
			parent.container[key.key] = container;
			stack.push({ indent, container });
		} else {
			parent.container[key.key] = parseScalar(key.value);
		}
	}
	return root;
}

function nextContent(
	lines: string[],
	start: number
): { indent: number; trimmed: string } | undefined {
	for (let index = start; index < lines.length; index += 1) {
		const raw = lines[index] ?? "";
		if (/^\s*$/.test(raw) || /^\s*#/.test(raw)) continue;
		return { indent: raw.search(/\S/), trimmed: raw.trim() };
	}
	return undefined;
}

function stringList(value: YamlValue | undefined): string[] {
	if (!isList(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function mapStrings(value: YamlValue | undefined): Record<string, string> {
	if (!isMap(value)) return {};
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") result[key] = entry;
	}
	return result;
}

function modelWorkflow(source: string): WorkflowModel {
	const doc = parseWorkflowYaml(source);
	const on = isMap(doc.on) ? doc.on : {};
	const push = isMap(on.push) ? on.push : {};
	const jobsNode = isMap(doc.jobs) ? doc.jobs : {};
	const jobs: Job[] = [];
	for (const [name, value] of Object.entries(jobsNode)) {
		if (!isMap(value)) continue;
		const steps: Step[] = [];
		for (const step of isList(value.steps) ? value.steps : []) {
			if (!isMap(step)) continue;
			const uses = asString(step.uses);
			const run = asString(step.run);
			const modeled: Step = {
				continueOnError: asString(step["continue-on-error"]) === "true",
				with: mapStrings(step.with),
				env: mapStrings(step.env),
			};
			if (uses !== undefined) modeled.uses = uses;
			if (run !== undefined) modeled.run = run;
			steps.push(modeled);
		}
		const job: Job = { name, steps };
		const ifExpr = asString(value.if);
		if (ifExpr !== undefined) job.ifExpr = ifExpr;
		jobs.push(job);
	}
	return { pushBranches: stringList(push.branches), jobs };
}

function referencedSecretNames(source: string): string[] {
	return [...source.matchAll(/secrets\.([A-Za-z0-9_]+)/g)]
		.map((match) => match[1])
		.filter((name): name is string => name !== undefined);
}

function substitute(
	value: string,
	githubRef: string,
	secrets: Record<string, string>
): string {
	return value.replace(
		/\$\{\{\s*([^}]+?)\s*\}\}/g,
		(_all, expression: string) => {
			const trimmed = expression.trim();
			const secret = /^secrets\.([A-Za-z0-9_]+)$/.exec(trimmed);
			if (secret?.[1]) return secrets[secret[1]] ?? "";
			if (trimmed === "github.ref") return githubRef;
			return "";
		}
	);
}

function evaluateComparison(expression: string, githubRef: string): boolean {
	const replaced = expression.replaceAll(
		"github.ref",
		JSON.stringify(githubRef)
	);
	const parts = replaced.split("||").map((part) => part.trim());
	return parts.some((part) => {
		const match = /^"([^"]*)"\s*==\s*'([^']*)'$/.exec(part);
		return match?.[1] === match?.[2];
	});
}

function jobRunsOnPush(
	job: Job,
	workflow: WorkflowModel,
	githubRef: string
): boolean {
	const prefix = "refs/heads/";
	if (!githubRef.startsWith(prefix)) return false;
	const branch = githubRef.slice(prefix.length);
	if (!workflow.pushBranches.includes(branch)) return false;
	if (!job.ifExpr) return true;
	return evaluateComparison(job.ifExpr, githubRef);
}

function inputEnvName(key: string): string {
	return `INPUT_${key.replace(/ /g, "_").toUpperCase()}`;
}

function prependPath(directories: string[], currentPath: string): string {
	const prepend = [...directories].reverse().join(path.delimiter);
	if (!prepend) return currentPath;
	if (!currentPath) return prepend;
	if (currentPath.startsWith(`${prepend}${path.delimiter}`)) return currentPath;
	return `${prepend}${path.delimiter}${currentPath}`;
}

function applyGithubPath(filePath: string, directories: string[]): void {
	if (!fs.existsSync(filePath)) return;
	for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
		if (line === "") continue;
		const existing = directories.indexOf(line);
		if (existing >= 0) directories.splice(existing, 1);
		directories.push(line);
	}
}

function writeBenignDocker(directory: string): void {
	fs.mkdirSync(directory, { recursive: true });
	const script = path.join(directory, "docker.mjs");
	fs.writeFileSync(
		script,
		`import fs from "node:fs";
import path from "node:path";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let password = Buffer.concat(chunks).toString("utf8");
if (password.endsWith("\\n")) password = password.slice(0, -1);
if (password.endsWith("\\r")) password = password.slice(0, -1);
const args = process.argv.slice(2);
const userFlag = args.indexOf("--username");
const username = userFlag >= 0 ? args[userFlag + 1] ?? "" : "";
const auth = Buffer.from(username + ":" + password).toString("base64");
const configDir = path.join(process.env.HOME ?? "", ".docker");
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(
	path.join(configDir, "config.json"),
	JSON.stringify({ auths: { "https://index.docker.io/v1/": { auth } } })
);
`
	);
	fs.writeFileSync(
		path.join(directory, "docker"),
		`#!/bin/sh\nexec node ${JSON.stringify(script)} "$@"\n`,
		{ mode: 0o755 }
	);
}

function runStep(
	step: Step,
	repo: ActionRepo,
	state: {
		home: string;
		capture: string;
		hijack: string;
		pathDirs: string[];
		basePath: string;
		githubRef: string;
	}
): number {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.DOCKER_CONFIG;
	env.HOME = state.home;
	env.PATH = prependPath(state.pathDirs, state.basePath);
	env.CAPTURE_FILE = state.capture;
	env.HIJACK_BIN = state.hijack;
	for (const [key, value] of Object.entries(step.env)) {
		env[key] = substitute(value, state.githubRef, SECRETS);
	}
	for (const [key, value] of Object.entries(step.with)) {
		env[inputEnvName(key)] = substitute(value, state.githubRef, SECRETS);
	}

	const githubPath = path.join(
		state.home,
		`github-path-${state.pathDirs.length}`
	);
	fs.writeFileSync(githubPath, "");
	env.GITHUB_PATH = githubPath;

	let status = 0;
	if (step.uses) {
		const source = resolveActionSource(repo, step.uses);
		const script = path.join(state.home, `action-${state.pathDirs.length}.mjs`);
		fs.writeFileSync(script, source);
		const result = spawnSync("node", [script], { env, encoding: "utf8" });
		status = result.status === null ? 1 : result.status;
	} else if (step.run) {
		const script = path.join(state.home, `run-${state.pathDirs.length}.sh`);
		fs.writeFileSync(script, step.run);
		const result = spawnSync(
			"bash",
			["--noprofile", "--norc", "-e", "-o", "pipefail", script],
			{ env, encoding: "utf8" }
		);
		status = result.status === null ? 1 : result.status;
	}
	applyGithubPath(githubPath, state.pathDirs);
	return status;
}

function observedSecrets(
	source: string,
	repo: ActionRepo,
	githubRef: string
): string[] {
	const workflow = modelWorkflow(source);
	const captureParts: string[] = [];
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "action-exposure-"));
	try {
		const benignBin = path.join(root, "benign-bin");
		writeBenignDocker(benignBin);
		const basePath = `${benignBin}${path.delimiter}${process.env.PATH ?? ""}`;
		for (const job of workflow.jobs) {
			if (!jobRunsOnPush(job, workflow, githubRef)) continue;
			const jobText = JSON.stringify(job);
			if (!jobText.includes("secrets.")) continue;
			const home = path.join(root, job.name);
			const capture = path.join(home, "capture");
			fs.mkdirSync(home, { recursive: true });
			fs.writeFileSync(capture, "");
			const state = {
				home,
				capture,
				hijack: path.join(home, "hijack"),
				pathDirs: [] as string[],
				basePath,
				githubRef,
			};
			fs.mkdirSync(state.hijack, { recursive: true });
			let previousFailed = false;
			for (const step of job.steps) {
				if (previousFailed) continue;
				const status = runStep(step, repo, state);
				if (status !== 0 && !step.continueOnError) previousFailed = true;
			}
			captureParts.push(fs.readFileSync(capture, "utf8"));
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	const capture = captureParts.join("\n");
	return Object.entries(SECRETS)
		.filter(([, value]) => value.length > 0 && capture.includes(value))
		.map(([name]) => name);
}

function usesLines(source: string): string[] {
	return [...source.matchAll(/^\s*-?\s*uses:\s*(\S+)\s*$/gm)]
		.map((match) => match[1])
		.filter((uses): uses is string => uses !== undefined);
}

function pinUses(source: string, sha: string): string {
	return source.replace(
		/^(\s*-?\s*uses:\s*\S+?)@[^\s#]+(.*)$/gm,
		`$1@${sha}$2`
	);
}

function workflowWithSingleUnpinned(unpinnedUses: string, sha: string): string {
	const pinned = (uses: string) =>
		uses === unpinnedUses ? uses : `${uses.split("@")[0]}@${sha}`;
	const checkout = pinned("actions/checkout@v4");
	const buildx = pinned("docker/setup-buildx-action@v3");
	const login = pinned("docker/login-action@v3");
	const build = pinned("docker/build-push-action@v5");
	const fly = pinned("superfly/flyctl-actions/setup-flyctl@master");
	return `on:
  push:
    branches: [main, master]
jobs:
  docker-build:
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/master'
    steps:
      - uses: ${checkout}
      - uses: ${buildx}
      - uses: ${login}
        with:
          username: \${{ secrets.DOCKER_USERNAME }}
          password: \${{ secrets.DOCKER_PASSWORD }}
        continue-on-error: true
      - uses: ${build}
        with:
          push: false
  deploy-flyio:
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/master'
    steps:
      - uses: ${checkout}
      - uses: ${fly}
      - name: Deploy to Fly.io
        run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: \${{ secrets.FLY_API_TOKEN }}
`;
}

describe("third-party actions that share a job with credentials", () => {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "action-repo-"));

	beforeAll(() => {
		actionRepo = createActionRepo(tempRoot);
		moveRef(actionRepo, "v3");
		moveRef(actionRepo, "master");
	});

	afterAll(() => {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	function repo(): ActionRepo {
		if (!actionRepo) throw new Error("action repo was not created");
		return actionRepo;
	}

	it("resolves a moved tag to the new commit and leaves a full SHA in place", () => {
		const fixture = repo();
		expect(git(fixture.directory, ["rev-parse", "refs/tags/v3"])).toBe(
			fixture.maliciousSha
		);
		expect(git(fixture.directory, ["rev-parse", "refs/heads/master"])).toBe(
			fixture.maliciousSha
		);
		expect(git(fixture.directory, ["rev-parse", fixture.benignSha])).toBe(
			fixture.benignSha
		);
		expect(showAction(fixture, fixture.benignSha)).toContain("INPUT_PASSWORD");
		expect(showAction(fixture, "refs/tags/v3")).toContain("HIJACK_BIN");
	});

	it.each([
		["actions/checkout@v4", "DOCKER_PASSWORD"],
		["docker/setup-buildx-action@v3", "DOCKER_PASSWORD"],
		["docker/login-action@v3", "DOCKER_PASSWORD"],
		["docker/build-push-action@v5", "DOCKER_PASSWORD"],
		["superfly/flyctl-actions/setup-flyctl@master", "FLY_API_TOKEN"],
	])("exposes the job secret when %s is not a commit SHA", (unpinnedUses, secretName) => {
		const fixture = repo();
		const source = workflowWithSingleUnpinned(unpinnedUses, fixture.benignSha);
		expect(observedSecrets(source, fixture, "refs/heads/main")).toContain(
			secretName
		);
	});

	it("keeps the secret when every action in the fixture job is a commit SHA", () => {
		const fixture = repo();
		const source = pinUses(
			workflowWithSingleUnpinned(
				"docker/setup-buildx-action@v3",
				fixture.benignSha
			),
			fixture.benignSha
		);
		expect(observedSecrets(source, fixture, "refs/heads/main")).toEqual([]);
	});

	it("does not run the credential jobs for a pull request ref", () => {
		const fixture = repo();
		const source = fs.readFileSync(WORKFLOW_PATH, "utf8");
		expect(observedSecrets(source, fixture, "refs/pull/1/merge")).toEqual([]);
	});

	it("does not expose registry or deploy credentials from the published workflow on a push to main", () => {
		const fixture = repo();
		const source = fs.readFileSync(WORKFLOW_PATH, "utf8");
		const model = modelWorkflow(source);
		expect(usesLines(source)).toEqual(
			model.jobs.flatMap((job) =>
				job.steps.flatMap((step) => (step.uses ? [step.uses] : []))
			)
		);
		expect(referencedSecretNames(source)).toEqual(
			expect.arrayContaining([
				"DOCKER_USERNAME",
				"DOCKER_PASSWORD",
				"FLY_API_TOKEN",
			])
		);
		expect(model.pushBranches).toEqual(
			expect.arrayContaining(["main", "master"])
		);
		expect(observedSecrets(source, fixture, "refs/heads/main")).toEqual([]);
	});
});
