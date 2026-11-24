// @vitest-environment node
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateEnv } from "../env.server";

/**
 * Models the actions runner v2.338.2 behavior for `uses: org/repo[/path]@ref`:
 * the ref is taken verbatim, a non-SHA ref is resolved again on the next run,
 * the action's node entrypoint executes in the job workspace, and only that
 * step's env/inputs are injected. A later `run` step keeps GITHUB_PATH
 * prepends and its own env, then `flyctl deploy` archives the workspace.
 *
 * Jobs lint-and-format, type-check, test, and build also reference moving
 * tags. They run on separate runners and do not receive the Fly token, the
 * Docker Hub credentials, or the app's runtime secrets, so they are not part
 * of this attack.
 */

const WORKFLOW_PATH = path.resolve(".github/workflows/ci-cd.yml");
const FULL_SHA = /^[0-9a-f]{40}$/i;
const PUSH_REF = "refs/heads/main";
const FLY_TOKEN = "placeholder-fly-api-token";
const DOCKER_PASSWORD = "placeholder-docker-password";
const DOCKER_USERNAME = "placeholder-docker-username";
const SHOPIFY_SECRET = "placeholder-shopify-api-secret";
const BYNDER_TOKEN = "placeholder-bynder-permanent-token";
const PAYLOAD_NAME = "supply-chain-payload.js";

type WorkflowStep = {
	uses?: string;
	run?: string;
	env: Record<string, string>;
	with: Record<string, string>;
};

type WorkflowJob = {
	name: string;
	ifExpression: string | null;
	steps: WorkflowStep[];
};

type AttackResult = {
	jobRunsOnPushToMain: boolean;
	publishedPayload: boolean;
	attackerObservedFlyToken: boolean;
	attackerObservedDockerPassword: boolean;
	runtimeExfiltratedAppSecrets: boolean;
};

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("unpinned production deploy action", () => {
	it("does not let a changed action publish a release with the Fly token", () => {
		const jobs = jobsReferencing(
			parseWorkflow(readWorkflow()),
			"FLY_API_TOKEN"
		);
		expect(jobs.length).toBeGreaterThan(0);
		expect(jobs.some((job) => hasDeployCommand(job))).toBe(true);
		expect(readAppSecrets().shopifySecret).toBe(process.env.SHOPIFY_API_SECRET);
		expect(readAppSecrets().bynderToken).toBe(
			process.env.BYNDER_PERMANENT_TOKEN
		);

		const result = simulateJobs(jobs, {
			FLY_API_TOKEN: FLY_TOKEN,
		});

		expect(result).toEqual({
			jobRunsOnPushToMain: true,
			publishedPayload: false,
			attackerObservedFlyToken: false,
			attackerObservedDockerPassword: false,
			runtimeExfiltratedAppSecrets: false,
		});
	}, 30_000);

	it("does not let a changed action read the Docker Hub password", () => {
		const jobs = jobsReferencing(
			parseWorkflow(readWorkflow()),
			"DOCKER_PASSWORD"
		);
		expect(jobs.length).toBeGreaterThan(0);
		expect(jobs.some((job) => hasDockerPasswordInput(job))).toBe(true);

		const result = simulateJobs(jobs, {
			DOCKER_PASSWORD,
			DOCKER_USERNAME,
		});

		expect(result.jobRunsOnPushToMain).toBe(true);
		expect(result.attackerObservedDockerPassword).toBe(false);
	}, 30_000);
});

function readWorkflow(): string {
	return readFileSync(WORKFLOW_PATH, "utf8");
}

function readAppSecrets(): { shopifySecret: string; bynderToken: string } {
	const config = validateEnv();
	return {
		shopifySecret: config.SHOPIFY_API_SECRET,
		bynderToken: config.BYNDER_PERMANENT_TOKEN,
	};
}

function hasDeployCommand(job: WorkflowJob): boolean {
	return job.steps.some((step) => step.run?.includes("flyctl deploy"));
}

function hasDockerPasswordInput(job: WorkflowJob): boolean {
	return job.steps.some((step) =>
		step.with.password?.includes("secrets.DOCKER_PASSWORD")
	);
}

function jobsReferencing(
	jobs: WorkflowJob[],
	secretName: string
): WorkflowJob[] {
	const needle = `secrets.${secretName}`;
	return jobs.filter((job) =>
		job.steps.some((step) =>
			Object.values({ ...step.env, ...step.with }).some((value) =>
				value.includes(needle)
			)
		)
	);
}

function parseWorkflow(source: string): WorkflowJob[] {
	const jobs: WorkflowJob[] = [];
	let inJobs = false;
	let job: WorkflowJob | null = null;
	let step: WorkflowStep | null = null;
	let block: "env" | "with" | null = null;

	for (const line of source.split(/\r?\n/)) {
		if (!inJobs) {
			inJobs = line === "jobs:";
			continue;
		}
		if (/^[^\s#]/.test(line)) {
			break;
		}

		const started = startJob(line);
		if (started) {
			job = started;
			jobs.push(job);
			step = null;
			block = null;
			continue;
		}
		if (!job) {
			continue;
		}

		const parsedIf = line.match(/^ {4}if:\s*(.*)$/);
		if (parsedIf?.[1] && !step) {
			job.ifExpression = parsedIf[1].trim();
			continue;
		}

		const dashed = line.match(/^ {6}- (?:uses:\s*(\S+)|name:\s*.*)$/);
		if (dashed) {
			step = { env: {}, with: {} };
			if (dashed[1]) {
				step.uses = dashed[1];
			}
			job.steps.push(step);
			block = null;
			continue;
		}
		if (!step) {
			continue;
		}

		block = applyStepLine(step, line, block);
	}

	return jobs;
}

function startJob(line: string): WorkflowJob | null {
	const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
	const name = jobMatch?.[1];
	if (!name) {
		return null;
	}
	return { name, ifExpression: null, steps: [] };
}

function applyStepLine(
	step: WorkflowStep,
	line: string,
	block: "env" | "with" | null
): "env" | "with" | null {
	const uses = line.match(/^ {8}uses:\s*(\S+)\s*$/);
	if (uses?.[1]) {
		step.uses = uses[1];
		return null;
	}
	const run = line.match(/^ {8}run:\s*(.*)$/);
	if (run) {
		step.run = run[1] ?? "";
		return null;
	}
	if (/^ {8}env:\s*$/.test(line)) {
		return "env";
	}
	if (/^ {8}with:\s*$/.test(line)) {
		return "with";
	}
	return applyBlockLine(step, line, block);
}

function applyBlockLine(
	step: WorkflowStep,
	line: string,
	block: "env" | "with" | null
): "env" | "with" | null {
	const entry = line.match(/^ {10}([A-Za-z0-9_-]+):\s*(.*)$/);
	const key = entry?.[1];
	const value = entry?.[2];
	if (!key || value === undefined || !block) {
		return null;
	}
	const target = block === "env" ? step.env : step.with;
	target[key] = value.trim();
	return block;
}

function simulateJobs(
	jobs: WorkflowJob[],
	secrets: Record<string, string>
): AttackResult {
	const combined = emptyAttack();
	for (const job of jobs) {
		const result = simulateJob(job, secrets);
		combined.jobRunsOnPushToMain &&= result.jobRunsOnPushToMain;
		combined.publishedPayload ||= result.publishedPayload;
		combined.attackerObservedFlyToken ||= result.attackerObservedFlyToken;
		combined.attackerObservedDockerPassword ||=
			result.attackerObservedDockerPassword;
		combined.runtimeExfiltratedAppSecrets ||=
			result.runtimeExfiltratedAppSecrets;
	}
	return combined;
}

function emptyAttack(): AttackResult {
	return {
		jobRunsOnPushToMain: true,
		publishedPayload: false,
		attackerObservedFlyToken: false,
		attackerObservedDockerPassword: false,
		runtimeExfiltratedAppSecrets: false,
	};
}

function simulateJob(
	job: WorkflowJob,
	secrets: Record<string, string>
): AttackResult {
	const result = emptyAttack();
	result.jobRunsOnPushToMain = jobRunsForRef(job.ifExpression, PUSH_REF);
	if (!result.jobRunsOnPushToMain) {
		return result;
	}

	const root = mkdtempSync(path.join(tmpdir(), "deploy-action-"));
	tempRoots.push(root);
	const workspace = path.join(root, "workspace");
	const actionsRoot = path.join(root, "actions");
	const resultDir = path.join(root, "result");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(actionsRoot, { recursive: true });
	mkdirSync(resultDir, { recursive: true });

	const materialized = materializeActions(job, root, actionsRoot);
	const pathEntries: string[] = [];
	for (const step of job.steps) {
		if (step.uses) {
			runActionStep(step, materialized, {
				workspace,
				actionsRoot,
				resultDir,
				secrets,
				pathEntries,
			});
			continue;
		}
		if (step.run) {
			runScriptStep(step, { workspace, resultDir, secrets, pathEntries });
		}
	}

	return readAttackResult(result, resultDir);
}

type MaterializedAction = {
	entry: string;
	role: string;
};

function materializeActions(
	job: WorkflowJob,
	root: string,
	actionsRoot: string
): Map<WorkflowStep, MaterializedAction> {
	const materialized = new Map<WorkflowStep, MaterializedAction>();
	let index = 0;
	for (const step of job.steps) {
		if (!step.uses) {
			continue;
		}
		const parsed = parseUses(step.uses);
		const repo = createActionRepository(
			path.join(root, `repo-${index}`),
			parsed.subpath
		);
		const sha = resolveActionSha(repo, parsed.ref);
		const dest = path.join(actionsRoot, String(index));
		mkdirSync(dest, { recursive: true });
		const archive = path.join(root, `action-${index}.tar`);
		git(repo.dir, ["archive", "--format=tar", "-o", archive, sha]);
		execFileSync("tar", ["-xf", archive, "-C", dest]);
		materialized.set(step, {
			entry: path.join(dest, parsed.subpath, "dist", "index.js"),
			role: actionRole(step.uses),
		});
		index += 1;
	}
	return materialized;
}

function runActionStep(
	step: WorkflowStep,
	materialized: Map<WorkflowStep, MaterializedAction>,
	dirs: {
		workspace: string;
		actionsRoot: string;
		resultDir: string;
		secrets: Record<string, string>;
		pathEntries: string[];
	}
): void {
	const action = materialized.get(step);
	if (!action) {
		throw new Error("Missing materialized action");
	}
	const toolDir = path.join(dirs.resultDir, `tool-${dirs.pathEntries.length}`);
	const githubPath = path.join(dirs.resultDir, "github-path.txt");
	mkdirSync(toolDir, { recursive: true });
	writeFileSync(githubPath, "");
	execFileSync("node", [action.entry], {
		cwd: dirs.workspace,
		env: actionEnv(step, dirs, action.role, toolDir, githubPath),
	});
	dirs.pathEntries.push(...readPathEntries(githubPath));
}

function runScriptStep(
	step: WorkflowStep,
	dirs: {
		workspace: string;
		resultDir: string;
		secrets: Record<string, string>;
		pathEntries: string[];
	}
): void {
	const scriptPath = path.join(dirs.resultDir, "step.sh");
	writeFile(scriptPath, step.run ?? "");
	execFileSync(
		"bash",
		["--noprofile", "--norc", "-e", "-o", "pipefail", scriptPath],
		{
			cwd: dirs.workspace,
			env: scriptEnv(step, dirs),
		}
	);
}

function actionEnv(
	step: WorkflowStep,
	dirs: {
		workspace: string;
		actionsRoot: string;
		resultDir: string;
		secrets: Record<string, string>;
	},
	role: string,
	toolDir: string,
	githubPath: string
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		GITHUB_WORKSPACE: dirs.workspace,
		GITHUB_PATH: githubPath,
		SIM_ACTIONS_ROOT: dirs.actionsRoot,
		SIM_RESULT_DIR: dirs.resultDir,
		SIM_TOOL_DIR: toolDir,
		SIM_ACTION_ROLE: role,
	};
	for (const [key, value] of Object.entries(step.with)) {
		env[`INPUT_${key.replace(/ /g, "_").toUpperCase()}`] = resolveSecrets(
			value,
			dirs.secrets
		);
	}
	for (const [key, value] of Object.entries(step.env)) {
		env[key] = resolveSecrets(value, dirs.secrets);
	}
	return env;
}

function scriptEnv(
	step: WorkflowStep,
	dirs: {
		workspace: string;
		resultDir: string;
		secrets: Record<string, string>;
		pathEntries: string[];
	}
): NodeJS.ProcessEnv {
	const prepend = [...dirs.pathEntries].reverse().join(path.delimiter);
	const pathValue = prepend
		? `${prepend}${path.delimiter}${process.env.PATH ?? ""}`
		: process.env.PATH;
	const env: NodeJS.ProcessEnv = {
		PATH: pathValue,
		HOME: process.env.HOME,
		SIM_RESULT_DIR: dirs.resultDir,
	};
	for (const [key, value] of Object.entries(step.env)) {
		env[key] = resolveSecrets(value, dirs.secrets);
	}
	return env;
}

function resolveSecrets(
	value: string,
	secrets: Record<string, string>
): string {
	return value.replace(
		/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g,
		(_match, name: string) => secrets[name] ?? ""
	);
}

function readAttackResult(
	result: AttackResult,
	resultDir: string
): AttackResult {
	const flyToken = readOptional(path.join(resultDir, "fly-token"));
	const actionFlyToken = readOptional(path.join(resultDir, "action-fly-token"));
	const dockerPassword = readOptional(
		path.join(resultDir, "action-docker-password")
	);
	const archive = path.join(resultDir, "release.tar");
	const publishedPayload = archiveContains(archive, PAYLOAD_NAME);
	return {
		...result,
		publishedPayload,
		attackerObservedFlyToken:
			flyToken === FLY_TOKEN || actionFlyToken === FLY_TOKEN,
		attackerObservedDockerPassword: dockerPassword === DOCKER_PASSWORD,
		runtimeExfiltratedAppSecrets:
			publishedPayload && payloadReadsRuntimeSecrets(archive, resultDir),
	};
}

function payloadReadsRuntimeSecrets(
	archive: string,
	resultDir: string
): boolean {
	const extracted = path.join(resultDir, "image");
	mkdirSync(extracted, { recursive: true });
	execFileSync("tar", ["-xf", archive, "-C", extracted]);
	const exfil = path.join(resultDir, "runtime-exfil.txt");
	execFileSync("node", [path.join(extracted, PAYLOAD_NAME)], {
		env: {
			PATH: process.env.PATH,
			SIM_RUNTIME_EXFIL: exfil,
			SHOPIFY_API_SECRET: SHOPIFY_SECRET,
			BYNDER_PERMANENT_TOKEN: BYNDER_TOKEN,
		},
	});
	const observed = readOptional(exfil);
	return observed.includes(SHOPIFY_SECRET) && observed.includes(BYNDER_TOKEN);
}

function archiveContains(archive: string, name: string): boolean {
	if (!existsSync(archive)) {
		return false;
	}
	const listing = execFileSync("tar", ["-tf", archive], { encoding: "utf8" });
	return listing.split(/\r?\n/).some((entry) => entry.endsWith(name));
}

type ActionRepo = { dir: string; benignSha: string };

function createActionRepository(dir: string, subpath: string): ActionRepo {
	mkdirSync(path.join(dir, subpath, "dist"), { recursive: true });
	git(dir, ["init", "-b", "master"]);
	writeActionTree(dir, subpath, benignActionSource());
	git(dir, ["add", "."]);
	git(dir, ["commit", "-m", "reviewed action"]);
	const benignSha = git(dir, ["rev-parse", "HEAD"]);
	writeActionTree(dir, subpath, maliciousActionSource());
	git(dir, ["add", "."]);
	git(dir, ["commit", "-m", "changed action"]);
	if (!FULL_SHA.test(benignSha)) {
		throw new Error("Action repository did not create a full SHA");
	}
	return { dir, benignSha };
}

function resolveActionSha(repo: ActionRepo, ref: string): string {
	if (FULL_SHA.test(ref)) {
		return repo.benignSha;
	}
	git(repo.dir, ["update-ref", `refs/heads/${ref}`, "HEAD"]);
	return git(repo.dir, ["rev-parse", ref]);
}

function parseUses(uses: string): {
	ref: string;
	subpath: string;
} {
	const segments = uses.split("@");
	const ref = segments[1];
	if (segments.length !== 2 || !ref) {
		throw new Error(`Unparseable action reference: ${uses}`);
	}
	const ownerAndPath = segments[0];
	if (!ownerAndPath) {
		throw new Error(`Unparseable action reference: ${uses}`);
	}
	const pathSegments = ownerAndPath.split("/").filter(Boolean);
	if (pathSegments.length < 2) {
		throw new Error(`Unparseable action reference: ${uses}`);
	}
	return {
		ref,
		subpath: pathSegments.slice(2).join("/"),
	};
}

function actionRole(uses: string): string {
	if (uses.includes("setup-flyctl")) {
		return "setup-flyctl";
	}
	if (uses.includes("login-action")) {
		return "login";
	}
	if (uses.includes("/checkout@") || uses.startsWith("actions/checkout@")) {
		return "checkout";
	}
	return "other";
}

function writeActionTree(dir: string, subpath: string, source: string): void {
	const actionDir = path.join(dir, subpath);
	writeFile(
		path.join(actionDir, "action.yml"),
		"name: Fixture\nruns:\n  using: node24\n  main: dist/index.js\n"
	);
	writeFile(path.join(actionDir, "dist", "index.js"), source);
}

function benignActionSource(): string {
	const flyctl = [
		"#!/bin/sh",
		"set -eu",
		"printf '%s' pinned > \"$SIM_RESULT_DIR/fly-role\"",
		'tar -cf "$SIM_RESULT_DIR/release.tar" -C "$PWD" .',
		"",
	].join("\n");
	return `
const fs = require("fs");
const path = require("path");
const role = process.env.SIM_ACTION_ROLE || "";
const workspace = process.env.GITHUB_WORKSPACE;
const toolDir = process.env.SIM_TOOL_DIR;
const pathFile = process.env.GITHUB_PATH;
if (role === "checkout") {
  fs.writeFileSync(path.join(workspace, "app-marker.txt"), "shopify-app\\n");
}
if (role === "login") {
  const dockerDir = path.join(workspace, ".docker");
  fs.mkdirSync(dockerDir, { recursive: true });
  fs.writeFileSync(path.join(dockerDir, "config.json"), process.env.INPUT_PASSWORD || "");
}
if (role === "setup-flyctl") {
  fs.mkdirSync(toolDir, { recursive: true });
  const flyctlPath = path.join(toolDir, "flyctl");
  fs.writeFileSync(flyctlPath, ${JSON.stringify(flyctl)}, { mode: 0o755 });
  fs.chmodSync(flyctlPath, 0o755);
  fs.appendFileSync(pathFile, toolDir + "\\n");
}
`;
}

function maliciousActionSource(): string {
	const payload = [
		"const fs = require('fs');",
		"fs.writeFileSync(process.env.SIM_RUNTIME_EXFIL, [process.env.SHOPIFY_API_SECRET || '', process.env.BYNDER_PERMANENT_TOKEN || ''].join('\\n'));",
		"",
	].join("\n");
	const flyctl = [
		"#!/bin/sh",
		"set -eu",
		'printf \'%s\' "$FLY_API_TOKEN" > "$SIM_RESULT_DIR/fly-token"',
		"printf '%s' attacker > \"$SIM_RESULT_DIR/fly-role\"",
		'tar -cf "$SIM_RESULT_DIR/release.tar" -C "$PWD" .',
		"",
	].join("\n");
	return `
const fs = require("fs");
const path = require("path");
const workspace = process.env.GITHUB_WORKSPACE;
const toolDir = process.env.SIM_TOOL_DIR;
const pathFile = process.env.GITHUB_PATH;
const resultDir = process.env.SIM_RESULT_DIR;
const actionsRoot = process.env.SIM_ACTIONS_ROOT;
fs.writeFileSync(path.join(workspace, ${JSON.stringify(PAYLOAD_NAME)}), ${JSON.stringify(payload)});
fs.mkdirSync(toolDir, { recursive: true });
const flyctlPath = path.join(toolDir, "flyctl");
fs.writeFileSync(flyctlPath, ${JSON.stringify(flyctl)}, { mode: 0o755 });
fs.chmodSync(flyctlPath, 0o755);
fs.appendFileSync(pathFile, toolDir + "\\n");
if (process.env.FLY_API_TOKEN) {
  fs.writeFileSync(path.join(resultDir, "action-fly-token"), process.env.FLY_API_TOKEN);
}
if (process.env.INPUT_PASSWORD) {
  fs.writeFileSync(path.join(resultDir, "action-docker-password"), process.env.INPUT_PASSWORD);
}
const dockerConfig = path.join(workspace, ".docker", "config.json");
if (!process.env.INPUT_PASSWORD && fs.existsSync(dockerConfig)) {
  const stored = fs.readFileSync(dockerConfig, "utf8");
  if (stored) fs.writeFileSync(path.join(resultDir, "action-docker-password"), stored);
}
walk(actionsRoot);
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (full.endsWith(path.sep + "dist" + path.sep + "index.js") && path.resolve(full) !== __filename) {
      fs.copyFileSync(__filename, full);
    }
  }
}
`;
}

function jobRunsForRef(expression: string | null, ref: string): boolean {
	if (!expression) {
		return ref === "refs/heads/main" || ref === "refs/heads/master";
	}
	return expression.split("||").some((part) => {
		const match = part.trim().match(/^github\.ref\s*==\s*'([^']*)'$/);
		if (!match) {
			throw new Error(`Unsupported job if clause: ${part}`);
		}
		return ref === match[1];
	});
}

function git(cwd: string, args: string[]): string {
	return execFileSync(
		"git",
		[
			"-c",
			"user.name=ci-test",
			"-c",
			"user.email=ci-test@example.com",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		{ cwd, encoding: "utf8" }
	).trim();
}

function readPathEntries(filePath: string): string[] {
	return readFileSync(filePath, "utf8")
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function readOptional(filePath: string): string {
	if (!existsSync(filePath)) {
		return "";
	}
	return readFileSync(filePath, "utf8");
}

function writeFile(filePath: string, contents: string): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, contents);
}
