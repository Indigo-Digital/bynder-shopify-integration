import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = join(process.cwd(), ".github/workflows/ci-cd.yml");
const PLACEHOLDER_JOB_TOKEN = "placeholder-job-github-token";
const ATTACKER_NODE_VERSION = "20.99.0";
const ATTACKER_MARKER = "attacker-executed";
const SETUP_NODE_JOBS = [
	"lint-and-format",
	"type-check",
	"test",
	"build",
] as const;

interface WorkflowStep {
	uses: string | null;
	run: string | null;
	inputs: Record<string, string>;
}

interface WorkflowJob {
	name: string;
	needs: string[];
	steps: WorkflowStep[];
}

interface ParsedWorkflow {
	pushBranches: string[];
	pullRequestBranches: string[];
	jobs: WorkflowJob[];
}

interface ActionRepo {
	root: string;
	trustedSha: string;
	attackerSha: string;
}

/**
 * semver 7.6.3 Range.replaceXRange (classes/range.js) and semver 6.3.1
 * satisfies, checked against those packages for the specs this workflow uses.
 * "20" is >=20.0.0 <21.0.0-0. A full x.y.z spec compares equal to that release.
 */
function cleanVersion(versionSpec: string): string | null {
	const stripped = versionSpec.trim().replace(/^[=v]+/, "");
	return /^\d+\.\d+\.\d+$/.test(stripped) ? stripped : null;
}

function satisfies(version: string, versionSpec: string): boolean {
	if (!/^\d+\.\d+\.\d+$/.test(version)) {
		return false;
	}
	const exact = cleanVersion(versionSpec);
	if (exact) {
		return version === exact;
	}
	const parts = version.split(".").map(Number);
	const major = parts[0] ?? 0;
	const minor = parts[1] ?? 0;
	if (/^\d+$/.test(versionSpec)) {
		return major === Number(versionSpec);
	}
	const minorSpec = /^(\d+)\.(\d+)$/.exec(versionSpec);
	if (minorSpec) {
		return major === Number(minorSpec[1]) && minor === Number(minorSpec[2]);
	}
	return false;
}

function compareVersions(left: string, right: string): number {
	const leftParts = left.split(".").map(Number);
	const rightParts = right.split(".").map(Number);
	for (let index = 0; index < 3; index++) {
		const leftPart = leftParts[index] ?? 0;
		const rightPart = rightParts[index] ?? 0;
		if (leftPart !== rightPart) {
			return leftPart > rightPart ? 1 : -1;
		}
	}
	return 0;
}

function highestMatch(versions: string[], versionSpec: string): string {
	const sorted = [...versions].sort((left, right) =>
		compareVersions(right, left)
	);
	return sorted.find((version) => satisfies(version, versionSpec)) ?? "";
}

function releasesFor(versionSpec: string): string[] {
	const releases = [ATTACKER_NODE_VERSION, "20.19.0", "20.17.0", "22.12.0"];
	const exact = cleanVersion(versionSpec);
	if (exact && !releases.includes(exact)) {
		releases.push(exact);
	}
	return releases;
}

/** @actions/tool-cache 2.0.2 find(): explicit specs do not scan newer releases. */
function findCachedNode(versionSpec: string, cached: string[]): string {
	if (cleanVersion(versionSpec) === null) {
		return highestMatch(cached, versionSpec);
	}
	const exact = cleanVersion(versionSpec);
	return exact && cached.includes(exact) ? exact : "";
}

/**
 * @actions/tool-cache 2.0.2 _findMatch walks the manifest in file order and
 * keeps the first stable release whose version satisfies the spec.
 */
function findManifestNode(versionSpec: string, manifest: string[]): string {
	return (
		manifest.find(
			(version) =>
				satisfies(version, versionSpec) && cleanVersion(version) !== null
		) ?? ""
	);
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseList(value: string): string[] {
	const trimmed = value.trim();
	const body =
		trimmed.startsWith("[") && trimmed.endsWith("]")
			? trimmed.slice(1, -1)
			: trimmed;
	if (body.trim() === "") {
		return [];
	}
	return body.split(",").map((item) => unquote(item));
}

function parseUses(value: string): { name: string; ref: string | null } {
	const atIndex = value.lastIndexOf("@");
	if (atIndex <= 0) {
		return { name: value, ref: null };
	}
	return {
		name: value.slice(0, atIndex),
		ref: value.slice(atIndex + 1),
	};
}

function startStep(remainder: string): WorkflowStep {
	const step: WorkflowStep = { uses: null, run: null, inputs: {} };
	if (remainder.startsWith("uses:")) {
		step.uses = unquote(remainder.slice("uses:".length));
	}
	if (remainder.startsWith("run:")) {
		step.run = unquote(remainder.slice("run:".length));
	}
	return step;
}

function parseWorkflow(source: string): ParsedWorkflow {
	const workflow: ParsedWorkflow = {
		pushBranches: [],
		pullRequestBranches: [],
		jobs: [],
	};
	let section: "root" | "on" | "jobs" = "root";
	let eventName: string | null = null;
	let job: WorkflowJob | null = null;
	let step: WorkflowStep | null = null;
	let inWith = false;

	for (const line of source.split("\n")) {
		if (/^on:\s*$/.test(line)) {
			section = "on";
			continue;
		}
		if (/^jobs:\s*$/.test(line)) {
			section = "jobs";
			continue;
		}
		if (section === "on") {
			const event = /^ {2}([A-Za-z0-9_]+):\s*$/.exec(line);
			if (event) {
				eventName = event[1] ?? null;
				continue;
			}
			const branches = /^ {4}branches:\s*(.+)$/.exec(line);
			if (branches && eventName === "push") {
				workflow.pushBranches = parseList(branches[1] ?? "");
			}
			if (branches && eventName === "pull_request") {
				workflow.pullRequestBranches = parseList(branches[1] ?? "");
			}
		}
		if (section !== "jobs") {
			continue;
		}
		const jobHeader = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
		if (jobHeader) {
			job = { name: jobHeader[1] ?? "", needs: [], steps: [] };
			workflow.jobs.push(job);
			step = null;
			inWith = false;
			continue;
		}
		if (!job) {
			continue;
		}
		const needs = /^ {4}needs:\s*(.+)$/.exec(line);
		if (needs) {
			job.needs = parseList(needs[1] ?? "");
			continue;
		}
		const stepHeader = /^ {6}- (.*)$/.exec(line);
		if (stepHeader) {
			step = startStep(stepHeader[1] ?? "");
			job.steps.push(step);
			inWith = false;
			continue;
		}
		if (!step) {
			continue;
		}
		const uses = /^ {8}uses:\s*(.+)$/.exec(line);
		if (uses) {
			step.uses = unquote(uses[1] ?? "");
			inWith = false;
			continue;
		}
		const run = /^ {8}run:\s*(.+)$/.exec(line);
		if (run) {
			step.run = unquote(run[1] ?? "");
			inWith = false;
			continue;
		}
		if (/^ {8}with:\s*$/.test(line)) {
			inWith = true;
			continue;
		}
		const input = /^ {10}([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (inWith && input) {
			step.inputs[input[1] ?? ""] = unquote(input[2] ?? "");
		}
	}
	return workflow;
}

function setupNodeSteps(job: WorkflowJob): WorkflowStep[] {
	return job.steps.filter((candidate) => {
		if (!candidate.uses) {
			return false;
		}
		return parseUses(candidate.uses).name === "actions/setup-node";
	});
}

function git(repo: string, args: string[]): string {
	const result = spawnSync(
		"git",
		[
			"-C",
			repo,
			"-c",
			"user.email=test@example.com",
			"-c",
			"user.name=Test",
			...args,
		],
		{ encoding: "utf8" }
	);
	if (result.status !== 0) {
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	}
	return (result.stdout ?? "").trim();
}

function writeActionCommit(repo: string, kind: "trusted" | "attacker"): void {
	const script =
		kind === "attacker"
			? [
					"const fs = require('fs');",
					"const path = require('path');",
					"const workspace = process.env.GITHUB_WORKSPACE;",
					"fs.mkdirSync(workspace, { recursive: true });",
					`fs.writeFileSync(path.join(workspace, '${ATTACKER_MARKER}'), 'ran');`,
					"fs.writeFileSync(path.join(workspace, 'job-result'), 'altered');",
				].join("\n")
			: "process.stdout.write('trusted\\n');\n";
	mkdirSync(join(repo, "dist/setup"), { recursive: true });
	writeFileSync(
		join(repo, "action.yml"),
		[
			"name: Setup Node.js environment",
			"inputs:",
			"  node-version:",
			"    description: Version Spec",
			"  token:",
			"    description: token",
			"    default: $" +
				"{{ github.server_url == 'https://github.com' && github.token || '' }}",
			"runs:",
			"  using: node20",
			"  main: dist/setup/index.js",
			"",
		].join("\n")
	);
	writeFileSync(join(repo, "dist/setup/index.js"), script);
	git(repo, ["add", "action.yml", "dist/setup/index.js"]);
	git(repo, ["commit", "-m", kind]);
}

function createActionRepo(): ActionRepo {
	const root = mkdtempSync(join(tmpdir(), "setup-node-action-"));
	git(root, ["init", "-b", "main"]);
	writeActionCommit(root, "trusted");
	const trustedSha = git(root, ["rev-parse", "HEAD"]);
	writeActionCommit(root, "attacker");
	const attackerSha = git(root, ["rev-parse", "HEAD"]);
	git(root, ["tag", "-f", "v4", attackerSha]);
	return { root, trustedSha, attackerSha };
}

function resolveActionCommit(repo: string, ref: string): string | null {
	if (/^[0-9a-f]{40}$/.test(ref)) {
		try {
			return git(repo, ["cat-file", "-t", ref]) === "commit" ? ref : null;
		} catch {
			return null;
		}
	}
	try {
		return git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
	} catch {
		return null;
	}
}

function inputDefault(manifest: string, name: string): string | null {
	const pattern = new RegExp(
		`^ {2}${name}:\\n(?: {4}.*\\n)*? {4}default:\\s*(.+)$`,
		"m"
	);
	const match = pattern.exec(manifest);
	return match?.[1] ? unquote(match[1]) : null;
}

function evaluateInputDefault(value: string): string {
	const expression = /^\$\{\{\s*(.+)\s*\}\}$/.exec(value);
	if (!expression) {
		return value;
	}
	const body = expression[1] ?? "";
	if (!body.includes("github.token")) {
		return "";
	}
	if (
		body.includes("github.server_url") &&
		!body.includes("https://github.com")
	) {
		return "";
	}
	return PLACEHOLDER_JOB_TOKEN;
}

function actionInputs(
	manifest: string,
	supplied: Record<string, string>
): Record<string, string> {
	const resolved: Record<string, string> = { ...supplied };
	for (const name of ["node-version", "token", "cache"]) {
		if (resolved[name] !== undefined) {
			continue;
		}
		const fallback = inputDefault(manifest, name);
		if (fallback !== null) {
			resolved[name] = evaluateInputDefault(fallback);
		}
	}
	return resolved;
}

function runSetupNodeStep(
	actionRepo: ActionRepo,
	ref: string,
	inputs: Record<string, string>
): boolean {
	const workspace = mkdtempSync(join(tmpdir(), "setup-node-job-"));
	try {
		const commit = resolveActionCommit(actionRepo.root, ref);
		if (!commit) {
			return false;
		}
		const actionDir = join(workspace, "action");
		git(actionRepo.root, ["worktree", "add", "--detach", actionDir, commit]);
		const manifest = readFileSync(join(actionDir, "action.yml"), "utf8");
		const using = /^\s*using:\s*(\S+)\s*$/m.exec(manifest)?.[1] ?? "";
		const main = /^\s*main:\s*(\S+)\s*$/m.exec(manifest)?.[1] ?? "";
		if (!using.startsWith("node") || main === "") {
			throw new Error(`action at ${commit} has no node entrypoint`);
		}
		const env: NodeJS.ProcessEnv = {
			...process.env,
			GITHUB_WORKSPACE: workspace,
		};
		for (const [name, value] of Object.entries(
			actionInputs(manifest, inputs)
		)) {
			env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] = value;
		}
		execFileSync(process.execPath, [join(actionDir, main)], {
			cwd: workspace,
			env,
		});
		return existsSync(join(workspace, ATTACKER_MARKER));
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

function executeInstalledNode(version: string): string {
	const root = mkdtempSync(join(tmpdir(), "setup-node-bin-"));
	try {
		const bin = join(root, "bin");
		mkdirSync(bin);
		const marker = join(root, "executed-version");
		writeFileSync(
			join(bin, "node"),
			`#!/bin/sh\nprintf '%s\\n' '${version}' > '${marker}'\n`
		);
		chmodSync(join(bin, "node"), 0o755);
		const pathValue = `${bin}:${process.env.PATH ?? ""}`;
		execFileSync("node", ["-e", "process.exit(0)"], {
			env: { ...process.env, PATH: pathValue },
		});
		return readFileSync(marker, "utf8").trim();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function loadWorkflow(): ParsedWorkflow {
	return parseWorkflow(readFileSync(WORKFLOW_PATH, "utf8"));
}

function requireJob(workflow: ParsedWorkflow, name: string): WorkflowJob {
	const job = workflow.jobs.find((candidate) => candidate.name === name);
	if (!job) {
		throw new Error(`missing job ${name}`);
	}
	return job;
}

describe("setup-node supply chain", () => {
	it("follows a moved v4 tag into the action entrypoint", () => {
		const actionRepo = createActionRepo();
		try {
			const beforeMove = git(actionRepo.root, ["rev-parse", "v4^{commit}"]);
			git(actionRepo.root, ["tag", "-f", "v4", actionRepo.trustedSha]);
			expect(git(actionRepo.root, ["rev-parse", "v4^{commit}"])).toBe(
				actionRepo.trustedSha
			);
			expect(beforeMove).not.toBe(actionRepo.trustedSha);
			git(actionRepo.root, ["tag", "-f", "v4", actionRepo.attackerSha]);
			expect(runSetupNodeStep(actionRepo, "v4", { "node-version": "20" })).toBe(
				true
			);
		} finally {
			rmSync(actionRepo.root, { recursive: true, force: true });
		}
	});

	it("checks out a full commit SHA after the v4 tag moves", () => {
		const actionRepo = createActionRepo();
		try {
			expect(
				runSetupNodeStep(actionRepo, actionRepo.trustedSha, {
					"node-version": "20.19.0",
				})
			).toBe(false);
			expect(
				runSetupNodeStep(
					actionRepo,
					"49933ea5288caeca8642d1e84afbd3f7d6820020",
					{
						"node-version": "20.19.0",
					}
				)
			).toBe(false);
		} finally {
			rmSync(actionRepo.root, { recursive: true, force: true });
		}
	});

	it("pins setup-node in every job that runs on pull requests and main pushes", () => {
		const workflow = loadWorkflow();
		expect(workflow.pullRequestBranches).toEqual(
			expect.arrayContaining(["main", "master"])
		);
		expect(workflow.pushBranches).toEqual(
			expect.arrayContaining(["main", "master"])
		);
		const actionRepo = createActionRepo();
		try {
			for (const name of SETUP_NODE_JOBS) {
				const job = requireJob(workflow, name);
				const steps = setupNodeSteps(job);
				expect.soft(steps, name).toHaveLength(1);
				const step = steps[0];
				if (!step?.uses) {
					throw new Error(`${name} is missing setup-node`);
				}
				const ref = parseUses(step.uses).ref ?? "";
				expect
					.soft(runSetupNodeStep(actionRepo, ref, step.inputs), name)
					.toBe(false);
				expect.soft(ref, `${name} ref`).toMatch(/^[0-9a-f]{40}$/);
			}
		} finally {
			rmSync(actionRepo.root, { recursive: true, force: true });
		}
	});

	it("installs an exact Node release for those setup-node steps", () => {
		const workflow = loadWorkflow();
		for (const name of SETUP_NODE_JOBS) {
			const step = setupNodeSteps(requireJob(workflow, name))[0];
			const versionSpec = step?.inputs["node-version"] ?? "";
			const releases = releasesFor(versionSpec);
			const cached = findCachedNode(versionSpec, releases);
			const fromManifest = findManifestNode(versionSpec, releases);
			const fromIndex = highestMatch(releases, versionSpec);
			const exact = cleanVersion(versionSpec);
			expect.soft(exact, name).not.toBeNull();
			expect.soft(cached, `${name} cache`).toBe(exact);
			expect.soft(fromManifest, `${name} manifest`).toBe(exact);
			expect.soft(fromIndex, `${name} index`).toBe(exact);
			expect.soft(executeInstalledNode(cached), `${name} executed`).toBe(exact);
			expect
				.soft(executeInstalledNode(fromIndex), `${name} index executed`)
				.not.toBe(ATTACKER_NODE_VERSION);
		}
	});

	it("gates image and deploy jobs on the jobs that install Node", () => {
		const workflow = loadWorkflow();
		expect(requireJob(workflow, "build").needs).toEqual(
			expect.arrayContaining(["lint-and-format", "type-check"])
		);
		expect(requireJob(workflow, "docker-build").needs).toEqual(["build"]);
		expect(requireJob(workflow, "deploy-flyio").needs).toEqual(["build"]);
	});
});
