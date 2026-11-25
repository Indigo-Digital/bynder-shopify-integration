// @vitest-environment node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const JOB_TOKEN_PLACEHOLDER = "PLACEHOLDER_JOB_TOKEN";
const COMPROMISED_VERSION = "0.0.0-compromised";
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const ACTION_SHA = /^pnpm\/action-setup@[0-9a-f]{40}$/;
const REQUIRED_JOBS = ["lint-and-format", "type-check", "test", "build"];

const RECORD_SCRIPT = `const fs = require("fs");
const path = require("path");
const phase = require.main === module ? process.argv[2] : "bin";
const workspace = process.env.GITHUB_WORKSPACE;
const marker = process.env.SUPPLY_CHAIN_MARKER;
const config = fs.readFileSync(path.join(workspace, ".git", "config"), "utf8");
fs.appendFileSync(marker, phase + "\\n" + config);
`;

interface WorkflowStep {
	uses?: string;
	run?: string;
	version?: string;
	line: number;
}

interface ParsedJob {
	name: string;
	steps: WorkflowStep[];
}

interface ParsedWorkflow {
	file: string;
	triggers: Map<string, string[]>;
	jobs: ParsedJob[];
}

interface PackedPackage {
	bytes: Buffer;
	manifest: {
		name: string;
		version: string;
		scripts?: { postinstall: string };
		bin?: { pnpm: string };
	};
}

const actionEntries = new Map<string, Promise<string>>();

describe("pnpm/action-setup supply chain pin", () => {
	const workflows = readWorkflows();
	const setups = workflows.flatMap(findPnpmSetups);
	const jobs = [
		...new Set([...REQUIRED_JOBS, ...setups.map((setup) => setup.job)]),
	];

	for (const job of jobs) {
		it(`${job} does not execute the latest pnpm release`, async () => {
			const setup = setups.find((candidate) => candidate.job === job);
			expect(
				setup,
				`${job} must install pnpm with pnpm/action-setup`
			).toBeDefined();
			if (!setup) return;

			const result = await reproduceSetup(setup);
			expect(result.actionExitCode, result.actionOutput).toBe(0);
			expect(result.followupExitCode, result.followupOutput).toBe(0);
			expect(
				result.marker,
				`${job} installed the registry's latest pnpm release and that release read the checkout credential`
			).toBe("");
			expect(setup.version).toMatch(EXACT_VERSION);
			expect(setup.uses).toMatch(ACTION_SHA);
			expect(setup.triggers.get("push")).toEqual(
				expect.arrayContaining(["main", "master"])
			);
			expect(setup.triggers.get("pull_request")).toEqual(
				expect.arrayContaining(["main", "master"])
			);
		}, 120_000);
	}
});

function readWorkflows(): ParsedWorkflow[] {
	const directory = path.join(process.cwd(), ".github", "workflows");
	return fs
		.readdirSync(directory)
		.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
		.map((name) => parseWorkflow(path.join(directory, name)));
}

function findPnpmSetups(workflow: ParsedWorkflow) {
	return workflow.jobs.flatMap((job) =>
		job.steps.flatMap((step, index) => {
			if (!step.uses?.startsWith("pnpm/action-setup@")) return [];
			const followup = job.steps
				.slice(index + 1)
				.find((candidate) => candidate.run?.startsWith("pnpm "));
			return [
				{
					file: workflow.file,
					job: job.name,
					uses: step.uses,
					version: step.version ?? "",
					followup: followup?.run ?? "",
					line: step.line,
					triggers: workflow.triggers,
				},
			];
		})
	);
}

type PnpmSetup = ReturnType<typeof findPnpmSetups>[number];

async function reproduceSetup(setup: PnpmSetup) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-setup-spec-"));
	const marker = path.join(root, "marker.txt");
	const workspace = path.join(root, "workspace");
	const registry = await startRegistry(await packagesFor(setup.version));
	try {
		prepareWorkspace(workspace);
		const action = await runAction(
			setup,
			workspace,
			root,
			registry.url,
			marker
		);
		const followup = await runFollowup(
			setup.followup,
			action.binDir,
			registry.url,
			marker,
			workspace
		);
		return {
			actionExitCode: action.exitCode,
			actionOutput: action.output,
			followupExitCode: followup.exitCode,
			followupOutput: followup.output,
			marker: fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "",
		};
	} finally {
		await registry.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function prepareWorkspace(workspace: string): void {
	fs.mkdirSync(workspace, { recursive: true });
	fs.copyFileSync(
		path.join(process.cwd(), "package.json"),
		path.join(workspace, "package.json")
	);
	const npmrc = path.join(process.cwd(), ".npmrc");
	if (fs.existsSync(npmrc)) {
		fs.copyFileSync(npmrc, path.join(workspace, ".npmrc"));
	}
	writeCheckoutCredential(workspace);
}

function writeCheckoutCredential(workspace: string): void {
	// actions/checkout writes the job token into this file and leaves it there
	// until the job post step. pnpm setup runs before that cleanup.
	const basic = Buffer.from(
		`x-access-token:${JOB_TOKEN_PLACEHOLDER}`,
		"utf8"
	).toString("base64");
	const config = `[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic ${basic}\n`;
	fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
	fs.writeFileSync(path.join(workspace, ".git", "config"), config);
}

async function packagesFor(
	version: string
): Promise<Map<string, PackedPackage>> {
	const packages = new Map<string, PackedPackage>();
	packages.set(COMPROMISED_VERSION, await packPnpm(COMPROMISED_VERSION, true));
	if (EXACT_VERSION.test(version)) {
		packages.set(version, await packPnpm(version, false));
	}
	return packages;
}

async function packPnpm(
	version: string,
	compromised: boolean
): Promise<PackedPackage> {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pnpm-pack-"));
	const packageDir = path.join(directory, "package");
	fs.mkdirSync(packageDir);
	const manifest: PackedPackage["manifest"] = { name: "pnpm", version };
	if (compromised) {
		fs.writeFileSync(path.join(packageDir, "record.js"), RECORD_SCRIPT);
		fs.writeFileSync(
			path.join(packageDir, "bin.js"),
			"#!/usr/bin/env node\nrequire('./record.js');\n"
		);
		manifest.scripts = { postinstall: "node ./record.js postinstall" };
		manifest.bin = { pnpm: "./bin.js" };
	} else {
		fs.writeFileSync(
			path.join(packageDir, "bin.js"),
			"#!/usr/bin/env node\nprocess.exit(0);\n"
		);
		manifest.bin = { pnpm: "./bin.js" };
	}
	fs.writeFileSync(
		path.join(packageDir, "package.json"),
		JSON.stringify(manifest)
	);
	const tarball = path.join(directory, "package.tgz");
	await exec("tar", ["-czf", tarball, "-C", directory, "package"]);
	const bytes = fs.readFileSync(tarball);
	fs.rmSync(directory, { recursive: true, force: true });
	return { bytes, manifest };
}

async function startRegistry(packages: Map<string, PackedPackage>) {
	const versions = Object.fromEntries(
		[...packages.entries()].map(([version, packed]) => [
			version,
			metadata(version, packed),
		])
	);
	const server = http.createServer((request, response) => {
		const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
		const port = (server.address() as { port: number }).port;
		if (requestUrl.pathname === "/pnpm") {
			sendJson(response, {
				name: "pnpm",
				"dist-tags": { latest: COMPROMISED_VERSION },
				versions: withTarballUrls(versions, port),
			});
			return;
		}
		const tarball = requestUrl.pathname.match(/^\/pnpm\/-\/pnpm-(.+)\.tgz$/);
		const tarballVersion = tarball?.[1];
		const packed = tarballVersion
			? packages.get(decodeURIComponent(tarballVersion))
			: undefined;
		if (packed) {
			response.writeHead(200, { "content-type": "application/octet-stream" });
			response.end(packed.bytes);
			return;
		}
		response.writeHead(404);
		response.end("not found");
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = (server.address() as { port: number }).port;
	return {
		url: `http://127.0.0.1:${port}/`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

function metadata(version: string, packed: PackedPackage) {
	return {
		...packed.manifest,
		dist: {
			integrity: `sha512-${crypto.createHash("sha512").update(packed.bytes).digest("base64")}`,
			shasum: crypto.createHash("sha1").update(packed.bytes).digest("hex"),
			tarball: version,
		},
	};
}

function withTarballUrls(
	versions: Record<string, ReturnType<typeof metadata>>,
	port: number
) {
	return Object.fromEntries(
		Object.entries(versions).map(([version, manifest]) => [
			version,
			{
				...manifest,
				dist: {
					...manifest.dist,
					tarball: `http://127.0.0.1:${port}/pnpm/-/pnpm-${version}.tgz`,
				},
			},
		])
	);
}

function sendJson(response: http.ServerResponse, body: unknown): void {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

async function runAction(
	setup: PnpmSetup,
	workspace: string,
	root: string,
	registryUrl: string,
	marker: string
) {
	const entry = await actionEntry(setup.uses);
	const outputFiles = ["output", "state", "path", "env"].map((name) =>
		path.join(root, name)
	);
	for (const file of outputFiles) fs.writeFileSync(file, "");
	const outputFile = outputFiles[0] ?? "";
	const stateFile = outputFiles[1] ?? "";
	const pathFile = outputFiles[2] ?? "";
	const envFile = outputFiles[3] ?? "";
	const childEnv = actionEnv(
		setup.version,
		workspace,
		root,
		registryUrl,
		marker
	);
	childEnv.GITHUB_OUTPUT = outputFile;
	childEnv.GITHUB_STATE = stateFile;
	childEnv.GITHUB_PATH = pathFile;
	childEnv.GITHUB_ENV = envFile;
	const result = await spawnNode(entry, childEnv, workspace);
	const binDir =
		fs
			.readFileSync(pathFile, "utf8")
			.split("\n")
			.find((line) => line.length > 0) ?? "";
	return { ...result, binDir };
}

function actionEnv(
	version: string,
	workspace: string,
	root: string,
	registryUrl: string,
	marker: string
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.npm_config_ignore_scripts;
	delete env.npm_config_ignore_dep_scripts;
	env.INPUT_VERSION = version;
	env.INPUT_DEST = path.join(root, "setup-pnpm");
	env.INPUT_RUN_INSTALL = "null";
	env.INPUT_CACHE = "false";
	env.INPUT_CACHE_DEPENDENCY_PATH = "pnpm-lock.yaml";
	env.INPUT_PACKAGE_JSON_FILE = "package.json";
	env.INPUT_STANDALONE = "false";
	env.GITHUB_WORKSPACE = workspace;
	env.npm_config_registry = registryUrl;
	env.SUPPLY_CHAIN_MARKER = marker;
	env.npm_config_store_dir = path.join(root, "store");
	env.npm_config_cache = path.join(root, "cache");
	return env;
}

async function runFollowup(
	command: string,
	binDir: string,
	registryUrl: string,
	marker: string,
	workspace: string
) {
	expect(command, "the job must run the pnpm it just installed").toMatch(
		/^pnpm(?:\s|$)/
	);
	expect(binDir, "pnpm/action-setup must put pnpm on PATH").not.toBe("");
	const args = command.split(/\s+/).slice(1);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		npm_config_registry: registryUrl,
	};
	env.SUPPLY_CHAIN_MARKER = marker;
	env.GITHUB_WORKSPACE = workspace;
	env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ""}`;
	return spawnCaptured(path.join(binDir, "pnpm"), args, env, workspace);
}

async function actionEntry(uses: string): Promise<string> {
	const ref = uses.slice(uses.lastIndexOf("@") + 1);
	const pending = actionEntries.get(ref);
	if (pending) return pending;
	const clone = cloneAction(ref);
	actionEntries.set(ref, clone);
	return clone;
}

async function cloneAction(ref: string): Promise<string> {
	const directory = path.join(
		os.tmpdir(),
		`pnpm-action-setup-${ref.replace(/[^\w.-]/g, "_")}`
	);
	const entry = path.join(directory, "dist", "index.js");
	if (fs.existsSync(entry)) return entry;
	fs.rmSync(directory, { recursive: true, force: true });
	if (/^[0-9a-f]{40}$/.test(ref)) {
		fs.mkdirSync(directory);
		await exec("git", ["-C", directory, "init"]);
		await exec("git", [
			"-C",
			directory,
			"remote",
			"add",
			"origin",
			"https://github.com/pnpm/action-setup.git",
		]);
		await exec("git", [
			"-C",
			directory,
			"fetch",
			"--depth",
			"1",
			"origin",
			ref,
		]);
		await exec("git", ["-C", directory, "checkout", "FETCH_HEAD"]);
		return entry;
	}
	await exec("git", [
		"clone",
		"--depth",
		"1",
		"--branch",
		ref,
		"https://github.com/pnpm/action-setup.git",
		directory,
	]);
	return entry;
}

function parseWorkflow(file: string): ParsedWorkflow {
	const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
	const triggers = new Map<string, string[]>();
	const jobs: ParsedJob[] = [];
	let section: "top" | "on" | "jobs" = "top";
	let event = "";
	let job: ParsedJob | undefined;
	let step: WorkflowStep | undefined;
	let inWith = false;

	for (const [index, line] of lines.entries()) {
		const lineNumber = index + 1;
		if (line === "on:") {
			section = "on";
			continue;
		}
		if (line === "jobs:") {
			section = "jobs";
			continue;
		}
		if (section === "on") {
			const eventMatch = line.match(/^ {2}([A-Za-z_]+):\s*$/);
			const branchMatch = line.match(/^ {4}branches:\s*(.+)$/);
			if (eventMatch?.[1]) event = eventMatch[1];
			if (branchMatch?.[1] && event) {
				triggers.set(event, parseList(branchMatch[1]));
			}
			if (/^\S/.test(line)) section = "top";
			continue;
		}
		if (section !== "jobs") continue;
		const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
		const jobName = jobMatch?.[1];
		if (jobName) {
			job = { name: jobName, steps: [] };
			jobs.push(job);
			step = undefined;
			inWith = false;
			continue;
		}
		const parsed = parseStepLine(line, lineNumber, job, step, inWith);
		step = parsed.step;
		inWith = parsed.inWith;
	}
	return { file, triggers, jobs };
}

function parseStepLine(
	line: string,
	lineNumber: number,
	job: ParsedJob | undefined,
	step: WorkflowStep | undefined,
	inWith: boolean
) {
	if (!job) return { step, inWith };
	const uses = line.match(/^ {6}- uses:\s*(.+?)\s*$/);
	const inlineRun = line.match(/^ {6}- run:\s*(.+?)\s*$/);
	const named = line.match(/^ {6}- name:\s*(.*?)\s*$/);
	if (uses || inlineRun || named) {
		const next: WorkflowStep = { line: lineNumber };
		if (uses?.[1]) next.uses = unquote(uses[1]);
		if (inlineRun?.[1]) next.run = unquote(inlineRun[1]);
		job.steps.push(next);
		return { step: next, inWith: false };
	}
	const run = line.match(/^ {8}run:\s*(.+?)\s*$/);
	if (step && run?.[1]) {
		step.run = unquote(run[1]);
		return { step, inWith };
	}
	if (step && /^ {8}with:\s*$/.test(line)) return { step, inWith: true };
	const version = line.match(/^ {10}version:\s*(.+?)\s*$/);
	if (step && inWith && version?.[1]) step.version = unquote(version[1]);
	return { step, inWith };
}

function parseList(value: string): string[] {
	const inner = value.match(/\[(.*)\]/)?.[1];
	const items = inner !== undefined ? inner.split(",") : [value];
	return items.map((item) => unquote(item)).filter(Boolean);
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

function exec(command: string, args: string[]): Promise<void> {
	return spawnCaptured(command, args, process.env, process.cwd()).then(
		(result) => {
			if (result.exitCode !== 0) {
				throw new Error(
					`${command} ${args.join(" ")} exited ${result.exitCode}\n${result.output}`
				);
			}
		}
	);
}

function spawnNode(script: string, env: NodeJS.ProcessEnv, cwd: string) {
	return spawnCaptured(process.execPath, [script], env, cwd);
}

function spawnCaptured(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	cwd: string
): Promise<{ exitCode: number; output: string }> {
	const child = spawn(command, args, {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	return once(child, "exit").then(([code]) => ({
		exitCode: code ?? 1,
		output,
	}));
}
