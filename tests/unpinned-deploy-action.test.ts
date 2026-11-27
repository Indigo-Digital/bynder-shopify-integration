import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MARKER = "INJECTED_BY_UNPINNED_ACTION";
const FULL_SHA = /^[0-9a-f]{40}$/i;
const PROJECT_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	".."
);
const WORKFLOW_PATH = path.join(
	PROJECT_ROOT,
	".github",
	"workflows",
	"ci-cd.yml"
);

type Yaml = string | Yaml[] | { [key: string]: Yaml };

interface ActionCommits {
	benign: string;
	malicious: string;
}

/**
 * The runner splits `uses` on `@` and sends that ref to the download API.
 * A 40-hex ref is a Git object id. Any other ref is a tag or branch tip.
 */
function actionRef(uses: string): string | undefined {
	if (
		uses.startsWith("docker://") ||
		uses.startsWith("./") ||
		uses.startsWith(".\\") ||
		uses.startsWith("$/")
	) {
		return undefined;
	}
	const segments = uses.split("@");
	if (segments.length !== 2 || segments[1].length === 0) {
		throw new Error(`expected {org}/{repo}[/path]@ref, got ${uses}`);
	}
	const pathSegments = segments[0].split(/[/\\]/).filter((part) => part !== "");
	if (pathSegments.length < 2) {
		throw new Error(`expected {org}/{repo}[/path]@ref, got ${uses}`);
	}
	return segments[1];
}

function readWorkflow(file = WORKFLOW_PATH): string {
	return readFileSync(file, "utf8");
}

function sourceDeployIsClean(workflow: string): boolean {
	const root = asMap(parseYaml(workflow));
	const jobs = asMap(root?.jobs) ?? {};
	const dirs: string[] = [];
	try {
		for (const job of Object.values(jobs)) {
			const jobMap = asMap(job);
			if (!jobMap || !jobDeploysSourceOnMain(root, jobMap)) continue;
			if (!deployedSourceIsClean(jobMap, dirs)) return false;
		}
		return true;
	} finally {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	}
}

function jobDeploysSourceOnMain(
	root: Record<string, Yaml> | undefined,
	job: Record<string, Yaml>
): boolean {
	const deploysFromMain =
		pushRunsBranch(root ?? {}, "main") || pushRunsBranch(root ?? {}, "master");
	if (!root || !deploysFromMain) return false;
	const condition = asString(job.if);
	if (condition && !refMatches(condition)) return false;
	return (asSeq(job.steps) ?? []).some((step) =>
		isSourceDeploy(asString(asMap(step)?.run))
	);
}

function refMatches(condition: string): boolean {
	return (
		evalRefCondition(condition, "refs/heads/main") ||
		evalRefCondition(condition, "refs/heads/master")
	);
}

function deployedSourceIsClean(
	job: Record<string, Yaml>,
	dirs: string[]
): boolean {
	const workspace = prepareWorkspace(dirs);
	const actionRepo = mkdtempSync(path.join(tmpdir(), "action-repo-"));
	dirs.push(actionRepo);
	const commits = commitActionPair(actionRepo);
	for (const step of asSeq(job.steps) ?? []) {
		const uses = asString(asMap(step)?.uses);
		if (!uses) continue;
		const ref = actionRef(uses);
		if (!ref) continue;
		const sha = resolveMovedRef(actionRepo, ref, commits);
		runNodeAction(actionRepo, sha, workspace);
	}
	return !shippedFiles(workspace).some((body) => body.includes(MARKER));
}

function prepareWorkspace(dirs: string[]): string {
	const workspace = mkdtempSync(path.join(tmpdir(), "deploy-workspace-"));
	dirs.push(workspace);
	copyFileSync(
		path.join(PROJECT_ROOT, "Dockerfile"),
		path.join(workspace, "Dockerfile")
	);
	copyFileSync(
		path.join(PROJECT_ROOT, ".dockerignore"),
		path.join(workspace, ".dockerignore")
	);
	mkdirSync(path.join(workspace, "app"));
	writeFileSync(
		path.join(workspace, "app", "server.js"),
		"export const original = true;\n"
	);
	return workspace;
}

function commitActionPair(repo: string): ActionCommits {
	git(repo, ["init", "-b", "main"]);
	git(repo, ["config", "user.email", "test@example.com"]);
	git(repo, ["config", "user.name", "Tester"]);
	writeFileSync(path.join(repo, "action.yml"), nodeActionYaml());
	writeFileSync(path.join(repo, "index.js"), benignAction());
	git(repo, ["add", "action.yml", "index.js"]);
	git(repo, ["commit", "-m", "reviewed action"]);
	const benign = git(repo, ["rev-parse", "HEAD"]);
	writeFileSync(path.join(repo, "index.js"), maliciousAction());
	git(repo, ["add", "index.js"]);
	git(repo, ["commit", "-m", "replaced action"]);
	return { benign, malicious: git(repo, ["rev-parse", "HEAD"]) };
}

function resolveMovedRef(
	repo: string,
	ref: string,
	commits: ActionCommits
): string {
	git(repo, ["update-ref", "refs/tags/attacker-moved", commits.malicious]);
	if (FULL_SHA.test(ref)) return immutableCommit(repo, commits.benign);
	if (!/^[A-Za-z0-9._/-]+$/.test(ref)) {
		throw new Error(`unsupported action ref ${ref}`);
	}
	const tag = `refs/tags/${ref}`;
	git(repo, ["update-ref", tag, commits.benign]);
	const before = git(repo, ["rev-parse", tag]);
	git(repo, ["update-ref", tag, commits.malicious]);
	const after = git(repo, ["rev-parse", tag]);
	if (before !== commits.benign || after !== commits.malicious) {
		throw new Error(`tag ${ref} did not move to the attacker's commit`);
	}
	return after;
}

function immutableCommit(repo: string, benign: string): string {
	const resolved = git(repo, ["rev-parse", `${benign}^{commit}`]);
	const source = git(repo, ["show", `${benign}:index.js`]);
	if (resolved !== benign || source.includes(MARKER)) {
		throw new Error("commit object changed after the tag moved");
	}
	return benign;
}

function runNodeAction(repo: string, sha: string, workspace: string): void {
	const manifest = asMap(parseYaml(git(repo, ["show", `${sha}:action.yml`])));
	const runs = asMap(manifest?.runs);
	const using = asString(runs?.using) ?? "";
	const main = asString(runs?.main);
	if (!using.startsWith("node") || !main) {
		throw new Error(
			`resolved action ${sha} does not declare a node entrypoint`
		);
	}
	const script = path.join(repo, "ran.js");
	writeFileSync(script, git(repo, ["show", `${sha}:${main}`]));
	const result = spawnSync(process.execPath, [script], {
		cwd: workspace,
		encoding: "utf8",
		env: { ...process.env, GITHUB_WORKSPACE: workspace },
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || "action failed");
	}
}

function shippedFiles(workspace: string): string[] {
	const patterns = dockerfileException(
		readDockerignore(
			readFileSync(path.join(workspace, ".dockerignore"), "utf8")
		),
		"Dockerfile"
	);
	const bodies: string[] = [];
	collectShipped(workspace, workspace, patterns, bodies);
	return bodies;
}

function collectShipped(
	workspace: string,
	dir: string,
	patterns: string[],
	bodies: string[]
): void {
	for (const name of readdir(dir)) {
		const absolute = path.join(dir, name);
		const relative = path
			.relative(workspace, absolute)
			.split(path.sep)
			.join("/");
		if (isSkipped(relative, patterns)) continue;
		if (isDirectory(absolute)) {
			collectShipped(workspace, absolute, patterns, bodies);
			continue;
		}
		bodies.push(readFileSync(absolute, "utf8"));
	}
}

function dockerfileException(patterns: string[], dockerfile: string): string[] {
	if (!isSkipped(dockerfile, patterns)) return patterns;
	return [...patterns, `!${dockerfile}`];
}

function isSkipped(file: string, patterns: string[]): boolean {
	let matched = false;
	for (const pattern of patterns) {
		const exclusion = pattern.startsWith("!");
		if (exclusion !== matched) continue;
		const body = exclusion ? pattern.slice(1) : pattern;
		if (matchesPath(file, body)) matched = !exclusion;
	}
	return matched;
}

function matchesPath(file: string, pattern: string): boolean {
	if (pattern.includes("*") || pattern.includes("?")) {
		throw new Error(`dockerignore pattern ${pattern} is not covered`);
	}
	if (file === pattern) return true;
	const parts = file.split("/");
	for (let i = 1; i < parts.length; i++) {
		if (parts.slice(0, i).join("/") === pattern) return true;
	}
	return false;
}

function readDockerignore(text: string): string[] {
	const patterns: string[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		let line = rawLine;
		if (patterns.length === 0) line = line.replace(/^\uFEFF/, "");
		if (line.startsWith("#") || line.trim() === "") continue;
		let pattern = line.trim();
		const inverted = pattern.startsWith("!");
		if (inverted) pattern = pattern.slice(1).trim();
		pattern = pattern.replace(/^\//, "").replace(/\/+$/, "");
		if (pattern === "" || pattern === ".") continue;
		patterns.push(inverted ? `!${pattern}` : pattern);
	}
	return patterns;
}

function readdir(dir: string): string[] {
	return readdirSync(dir);
}

function isDirectory(target: string): boolean {
	return statSync(target).isDirectory();
}

function nodeActionYaml(): string {
	return "runs:\n  using: node20\n  main: index.js\n";
}

function benignAction(): string {
	return "process.stdout.write('reviewed\\n');\n";
}

function maliciousAction(): string {
	return [
		"const fs = require('node:fs');",
		"const path = require('node:path');",
		"const root = process.env.GITHUB_WORKSPACE;",
		`fs.appendFileSync(path.join(root, 'Dockerfile'), '\\n# ${MARKER}\\n');`,
		"fs.mkdirSync(path.join(root, 'app'), { recursive: true });",
		`fs.writeFileSync(path.join(root, 'app', 'compromised-server.js'), '// ${MARKER}\\n');`,
	].join("\n");
}

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
		cwd,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
	}
	return result.stdout.trim();
}

function flyTokenLocations(workflow: string): string[] {
	const root = asMap(parseYaml(workflow));
	const locations: string[] = [];
	if (asMap(root?.env) && "FLY_API_TOKEN" in (asMap(root?.env) ?? {})) {
		locations.push("workflow");
	}
	for (const job of Object.values(asMap(root?.jobs) ?? {})) {
		const jobMap = asMap(job);
		if (!jobMap) continue;
		if (asMap(jobMap.env) && "FLY_API_TOKEN" in (asMap(jobMap.env) ?? {})) {
			locations.push("job");
		}
		for (const step of asSeq(jobMap.steps) ?? []) {
			const stepMap = asMap(step);
			const env = asMap(stepMap?.env);
			if (!env || !("FLY_API_TOKEN" in env)) continue;
			locations.push(
				asString(stepMap?.uses) ?? asString(stepMap?.run) ?? "step"
			);
		}
	}
	return locations;
}

function pushRunsBranch(root: Record<string, Yaml>, branch: string): boolean {
	const on = asMap(root.on);
	if (!on || !("push" in on)) return false;
	const push = on.push;
	if (typeof push !== "object" || Array.isArray(push)) return true;
	const branches = push.branches;
	if (branches == null) return true;
	const names = Array.isArray(branches) ? branches : [branches];
	return names.map((name) => asString(name) ?? "").includes(branch);
}

function isSourceDeploy(run: string | undefined): boolean {
	if (!run || !/\bfly(?:ctl)?\s+deploy\b/.test(run)) return false;
	return !/(^|\s)--image(\s|=)/.test(run);
}

function evalRefCondition(expression: string, ref: string): boolean {
	const tokens = tokenize(expression);
	let index = 0;
	const value = parseOr();
	if (index !== tokens.length) throw new Error(`unused ${tokens[index]}`);
	return value;

	function parseOr(): boolean {
		let left = parseAnd();
		while (tokens[index] === "||") {
			index++;
			const right = parseAnd();
			left = left || right;
		}
		return left;
	}

	function parseAnd(): boolean {
		let left = parsePrimary();
		while (tokens[index] === "&&") {
			index++;
			const right = parsePrimary();
			left = left && right;
		}
		return left;
	}

	function parsePrimary(): boolean {
		if (tokens[index] === "(") {
			index++;
			const inner = parseOr();
			if (tokens[index] !== ")") throw new Error("expected )");
			index++;
			return inner;
		}
		const left = tokenValue(tokens[index++]);
		const operator = tokens[index++];
		const right = tokenValue(tokens[index++]);
		if (operator === "==") return left === right;
		if (operator === "!=") return left !== right;
		throw new Error(`unsupported operator ${operator}`);
	}

	function tokenValue(token: string | undefined): string {
		if (token === "github.ref") return ref;
		if (token?.startsWith("'") && token.endsWith("'"))
			return token.slice(1, -1);
		throw new Error(`unsupported condition token ${token}`);
	}
}

function tokenize(expression: string): string[] {
	const tokens: string[] = [];
	const pattern = /\s+|&&|\|\||==|!=|\(|\)|'[^']*'|[A-Za-z.][A-Za-z0-9._]*/g;
	for (const match of expression.matchAll(pattern)) {
		if (!match[0].trim()) continue;
		tokens.push(match[0]);
	}
	return tokens;
}

function parseYaml(source: string): Yaml {
	const lines = source.split(/\r?\n/);
	let index = 0;
	return parseBlock(0);

	function parseBlock(minIndent: number): Yaml {
		const lineIndex = skipBlanks();
		if (lineIndex >= lines.length || indentOf(lines[lineIndex]) < minIndent) {
			return {};
		}
		const text = stripComment(lines[lineIndex].trim());
		if (text.startsWith("- ")) return parseSeq(indentOf(lines[lineIndex]));
		return parseMap(indentOf(lines[lineIndex]));
	}

	function parseMap(indent: number): Record<string, Yaml> {
		const map: Record<string, Yaml> = {};
		while (index < lines.length) {
			const lineIndex = skipBlanks();
			if (lineIndex >= lines.length || indentOf(lines[lineIndex]) < indent)
				break;
			if (indentOf(lines[lineIndex]) !== indent) {
				throw new Error(`bad indent: ${lines[lineIndex]}`);
			}
			const text = stripComment(lines[lineIndex].trim());
			if (text.startsWith("- ")) break;
			const colon = keyColon(text);
			if (colon < 0) break;
			index = lineIndex + 1;
			const key = unquote(text.slice(0, colon).trim());
			map[key] = parseValue(text.slice(colon + 1).trim(), indent);
		}
		return map;
	}

	function parseSeq(indent: number): Yaml[] {
		const seq: Yaml[] = [];
		while (index < lines.length) {
			const lineIndex = skipBlanks();
			if (lineIndex >= lines.length || indentOf(lines[lineIndex]) !== indent)
				break;
			const text = stripComment(lines[lineIndex].trim());
			if (!text.startsWith("- ")) break;
			const rest = text.slice(2).trim();
			index = lineIndex + 1;
			seq.push(parseSeqItem(rest, indent));
		}
		return seq;
	}

	function parseSeqItem(rest: string, indent: number): Yaml {
		if (rest === "") return parseBlock(indent + 2);
		const colon = keyColon(rest);
		if (colon <= 0) return parseScalar(rest);
		const item: Record<string, Yaml> = {};
		item[unquote(rest.slice(0, colon).trim())] = parseValue(
			rest.slice(colon + 1).trim(),
			indent
		);
		Object.assign(item, parseMap(indent + 2));
		return item;
	}

	function parseValue(value: string, indent: number): Yaml {
		if (value === "|" || value === ">") return parseLiteral(indent + 2);
		if (value === "") return parseBlock(indent + 2);
		return parseScalar(value);
	}

	function parseLiteral(minIndent: number): string {
		const collected: string[] = [];
		while (index < lines.length) {
			const line = lines[index];
			if (line.trim() === "") {
				collected.push("");
				index++;
				continue;
			}
			if (indentOf(line) < minIndent) break;
			collected.push(line.slice(minIndent));
			index++;
		}
		return collected.join("\n").replace(/\n+$/, "");
	}

	function parseScalar(value: string): Yaml {
		if (value.startsWith("[") && value.endsWith("]")) {
			const inner = value.slice(1, -1).trim();
			if (inner === "") return [];
			return inner.split(",").map((part) => parseScalar(part.trim()));
		}
		return unquote(value);
	}

	function skipBlanks(): number {
		let cursor = index;
		while (cursor < lines.length) {
			const text = lines[cursor].trim();
			if (text !== "" && !text.startsWith("#")) break;
			cursor++;
		}
		return cursor;
	}
}

function indentOf(line: string): number {
	return line.match(/^ */)?.[0].length ?? 0;
}

function keyColon(text: string): number {
	let quote = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === ":") return i;
	}
	return -1;
}

function stripComment(text: string): string {
	let quote = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "#") return text.slice(0, i).trim();
	}
	return text.trim();
}

function unquote(value: string): string {
	if (
		(value.startsWith("'") && value.endsWith("'")) ||
		(value.startsWith('"') && value.endsWith('"'))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function asMap(value: Yaml | undefined): Record<string, Yaml> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) return value;
	return undefined;
}

function asSeq(value: Yaml | undefined): Yaml[] | undefined {
	if (Array.isArray(value)) return value;
	return undefined;
}

function asString(value: Yaml | undefined): string | undefined {
	if (typeof value === "string") return value;
	return undefined;
}

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function workflow(steps: string, condition = ""): string {
	const ifLine = condition ? `\n    if: ${condition}` : "";
	return `on:\n  push:\n    branches: [main, master]\njobs:\n  deploy:\n    runs-on: ubuntu-latest${ifLine}\n    steps:\n${steps}`;
}

const deployIf =
	"github.ref == 'refs/heads/main' || github.ref == 'refs/heads/master'";

describe("production deploy action pins", () => {
	it("keeps an attacker's moved tag out of the source flyctl deploy archives", () => {
		expect(sourceDeployIsClean(readWorkflow())).toBe(true);
	});

	it("treats a full commit SHA as an object the attacker cannot retarget", () => {
		const steps = [
			`      - uses: actions/checkout@${SHA_A}`,
			`      - uses: superfly/flyctl-actions/setup-flyctl@${SHA_B}`,
			"      - run: flyctl deploy --remote-only --app bynder-shopify-integration",
		].join("\n");
		expect(sourceDeployIsClean(workflow(steps, deployIf))).toBe(true);
	});

	it("still archives the attacker's files when only the checkout action is pinned", () => {
		const steps = [
			`      - uses: actions/checkout@${SHA_A}`,
			"      - uses: superfly/flyctl-actions/setup-flyctl@master",
			"      - run: flyctl deploy --remote-only --app bynder-shopify-integration",
		].join("\n");
		expect(sourceDeployIsClean(workflow(steps, deployIf))).toBe(false);
	});

	it("still archives the attacker's files when a run step only records a SHA", () => {
		const steps = [
			`      - run: echo ${SHA_A}`,
			"      - uses: actions/checkout@v4",
			"      - run: flyctl deploy --remote-only --app bynder-shopify-integration",
		].join("\n");
		expect(sourceDeployIsClean(workflow(steps, deployIf))).toBe(false);
	});

	it("ignores an unpinned action in a job that does not deploy on main", () => {
		const steps = [
			"      - uses: actions/checkout@v4",
			"      - run: flyctl deploy --remote-only --app bynder-shopify-integration",
		].join("\n");
		const condition = "github.ref == 'refs/heads/release'";
		expect(sourceDeployIsClean(workflow(steps, condition))).toBe(true);
	});

	it("keeps FLY_API_TOKEN on the source deploy step", () => {
		const locations = flyTokenLocations(readWorkflow());
		expect(locations).toEqual([
			"flyctl deploy --remote-only --app bynder-shopify-integration",
		]);
	});
});
