import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Spec for the release workflow's Docker Hub login step.
 *
 * These tests fail while `docker/login-action` is selected by a movable ref
 * and the registry secrets are passed into that step on a main-branch push
 * even though the image is not pushed. They pass once that action is pinned
 * to a full commit SHA and the registry secrets are passed only when an image
 * is pushed.
 *
 * Untested, because they do not receive the registry secrets as action inputs:
 * actions/checkout, pnpm/action-setup, actions/setup-node,
 * docker/setup-buildx-action, and superfly/flyctl-actions/setup-flyctl.
 * docker/build-push-action reading a docker config written by login is also
 * untested.
 */

const WORKFLOW_PATH = path.join(process.cwd(), ".github/workflows/ci-cd.yml");
const REGISTRY_PASSWORD = "placeholder-registry-password";
const REGISTRY_USERNAME = "placeholder-registry-user";
const LOGIN_REPOSITORY = "docker/login-action";
const SECRET_REFERENCE =
	/secrets\s*(?:\.|\[\s*['"])docker_(username|password)\b/i;

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("release workflow docker login", () => {
	it("delivers the registry password to a moved v3 tag", () => {
		const result = assessRelease(vulnerableWorkflow("v3"), "main");

		expect(result.attackerSawPassword).toBe(true);
		expect(result.loginPinnedToCommit).toBe(false);
		expect(result.exposesRegistrySecretsWithoutPush).toBe(true);
	});

	it("keeps a commit SHA after the v3 tag is moved", () => {
		const fixture = createLoginFixture();
		const moved = revParse(fixture.repo, "v3");
		const pinned = revParse(fixture.repo, fixture.benignSha);

		expect(moved).toBe(fixture.attackerSha);
		expect(pinned).toBe(fixture.benignSha);
	});

	it("accepts a full SHA and omits registry secrets when nothing is pushed", () => {
		const sha = "0123456789abcdef0123456789abcdef01234567";
		const result = assessRelease(fixedWorkflow(sha), "main");

		expect(result.attackerSawPassword).toBe(false);
		expect(result.loginPinnedToCommit).toBe(true);
		expect(result.exposesRegistrySecretsWithoutPush).toBe(false);
	});

	it("allows registry secrets only on a pinned login step that pushes", () => {
		const sha = "0123456789abcdef0123456789abcdef01234567";
		const result = assessRelease(pushingWorkflow(sha), "main");

		expect(result.attackerSawPassword).toBe(false);
		expect(result.loginPinnedToCommit).toBe(true);
		expect(result.exposesRegistrySecretsWithoutPush).toBe(false);
	});

	it("does not give a moved login tag the registry password on main or master", () => {
		const source = readFileSync(WORKFLOW_PATH, "utf8");

		for (const branch of ["main", "master"]) {
			const result = assessRelease(source, branch);
			expect.soft(result.attackerSawPassword, branch).toBe(false);
			expect.soft(result.loginPinnedToCommit, branch).toBe(true);
			expect.soft(result.exposesRegistrySecretsWithoutPush, branch).toBe(false);
		}
	});
});

interface Assessment {
	attackerSawPassword: boolean;
	loginPinnedToCommit: boolean;
	exposesRegistrySecretsWithoutPush: boolean;
}

interface WorkflowStep {
	uses?: string;
	run?: string;
	with: Record<string, string>;
	env: Record<string, string>;
	raw: string;
	runs: boolean;
}

interface WorkflowJob {
	env: Record<string, string>;
	steps: WorkflowStep[];
	runs: boolean;
	pushesImage: boolean;
}

function assessRelease(source: string, branch: string): Assessment {
	const fixture = createLoginFixture();
	const jobs = scheduledJobs(source, branch);
	let attackerSawPassword = false;
	let loginPinnedToCommit = true;
	let exposesRegistrySecretsWithoutPush = false;

	for (const job of jobs) {
		if (jobExposesSecretsWithoutPush(job)) {
			exposesRegistrySecretsWithoutPush = true;
		}
		for (const step of job.steps) {
			const outcome = runLoginStep(fixture, job, step);
			attackerSawPassword ||= outcome.attackerSawPassword;
			loginPinnedToCommit &&= outcome.loginPinnedToCommit;
		}
	}

	return {
		attackerSawPassword,
		loginPinnedToCommit,
		exposesRegistrySecretsWithoutPush,
	};
}

function jobExposesSecretsWithoutPush(job: WorkflowJob): boolean {
	if (!job.runs || job.pushesImage) {
		return false;
	}
	const raw = [JSON.stringify(job.env), ...job.steps.map((step) => step.raw)];
	return raw.some((value) => SECRET_REFERENCE.test(value));
}

function runLoginStep(
	fixture: LoginFixture,
	job: WorkflowJob,
	step: WorkflowStep
): Pick<Assessment, "attackerSawPassword" | "loginPinnedToCommit"> {
	const uses = step.uses ? parseUses(step.uses) : null;
	if (
		!step.runs ||
		!uses ||
		!sameRepository(uses.repository, LOGIN_REPOSITORY)
	) {
		return { attackerSawPassword: false, loginPinnedToCommit: true };
	}
	if (!isFullCommitSha(uses.ref)) {
		const sha = revParse(fixture.repo, uses.ref);
		if (!sha) {
			throw new Error(`Action ref '${uses.ref}' did not resolve`);
		}
		const dump = executeAction(fixture.repo, sha, actionEnvironment(job, step));
		return {
			attackerSawPassword: dump.includes(REGISTRY_PASSWORD),
			loginPinnedToCommit: false,
		};
	}
	const sha = revParse(fixture.repo, uses.ref);
	if (sha === fixture.attackerSha) {
		const dump = executeAction(fixture.repo, sha, actionEnvironment(job, step));
		return {
			attackerSawPassword: dump.includes(REGISTRY_PASSWORD),
			loginPinnedToCommit: true,
		};
	}
	return { attackerSawPassword: false, loginPinnedToCommit: true };
}

function actionEnvironment(
	job: WorkflowJob,
	step: WorkflowStep
): Record<string, string> {
	const env: Record<string, string> = { ...job.env, ...step.env };
	for (const [key, value] of Object.entries(step.with)) {
		env[`INPUT_${key.replace(/ /g, "_").toUpperCase()}`] = value;
	}
	return env;
}

function scheduledJobs(source: string, branch: string): WorkflowJob[] {
	const document = parseWorkflowYaml(source);
	const events = asMap(document.on);
	if (!pushSelectsBranch(events.push, branch)) {
		return [];
	}
	const context = pushContext(branch);
	return Object.values(asMap(document.jobs)).map((value) =>
		toJob(asMap(value), context)
	);
}

function toJob(
	job: Record<string, YamlNode>,
	context: Record<string, string | boolean>
): WorkflowJob {
	const runs = evaluateCondition(textValue(job.if), context);
	const steps = asList(job.steps).map((step) =>
		toStep(asMap(step), context, runs)
	);
	return {
		env: stringMap(asMap(job.env), context),
		steps,
		runs,
		pushesImage: steps.some(stepPushesImage),
	};
}

function toStep(
	step: Record<string, YamlNode>,
	context: Record<string, string | boolean>,
	jobRuns: boolean
): WorkflowStep {
	const stepRuns = jobRuns && evaluateCondition(textValue(step.if), context);
	const uses = textValue(step.uses);
	const run = textValue(step.run);
	return {
		...(uses === undefined ? {} : { uses }),
		...(run === undefined ? {} : { run }),
		with: stringMap(asMap(step.with), context),
		env: stringMap(asMap(step.env), context),
		raw: JSON.stringify(step),
		runs: stepRuns,
	};
}

function stepPushesImage(step: WorkflowStep): boolean {
	if (!step.runs) {
		return false;
	}
	if (step.run && /\bdocker\s+push\b/.test(step.run)) {
		return true;
	}
	const uses = step.uses ? parseUses(step.uses) : null;
	if (!uses || !sameRepository(uses.repository, "docker/build-push-action")) {
		return false;
	}
	return step.with.push === "true";
}

function pushSelectsBranch(
	filter: YamlNode | undefined,
	branch: string
): boolean {
	if (filter === undefined || filter === null || filter === true) {
		return filter === true;
	}
	const mapping = asMap(filter);
	if (!mapping.branches) {
		return true;
	}
	return branchListMatches(asList(mapping.branches).map(String), branch);
}

function branchListMatches(patterns: string[], branch: string): boolean {
	const included = patterns.filter((pattern) => !pattern.startsWith("!"));
	const excluded = patterns
		.filter((pattern) => pattern.startsWith("!"))
		.map((pattern) => pattern.slice(1));
	const positive = included.some((pattern) => globMatch(pattern, branch));
	const negative = excluded.some((pattern) => globMatch(pattern, branch));
	return positive && !negative;
}

function globMatch(pattern: string, branch: string): boolean {
	const expression = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "DOUBLE_STAR")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/DOUBLE_STAR/g, ".*");
	return new RegExp(`^${expression}$`).test(branch);
}

function pushContext(branch: string): Record<string, string | boolean> {
	return {
		"github.ref": `refs/heads/${branch}`,
		"github.ref_name": branch,
		"github.event_name": "push",
	};
}

function evaluateCondition(
	expression: string | undefined,
	context: Record<string, string | boolean>
): boolean {
	if (!expression) {
		return true;
	}
	const source = expression
		.trim()
		.replace(/^\$\{\{\s*/, "")
		.replace(/\s*\}\}$/, "");
	const parser = new ConditionParser(source, context);
	return parser.parse();
}

class ConditionParser {
	private index = 0;

	constructor(
		private readonly source: string,
		private readonly context: Record<string, string | boolean>
	) {}

	parse(): boolean {
		const value = this.parseOr();
		this.skip();
		if (this.index !== this.source.length) {
			throw new Error(`Unparsed workflow condition '${this.source}'`);
		}
		return value;
	}

	private parseOr(): boolean {
		let value = this.parseAnd();
		while (this.consume("||")) {
			value = this.parseAnd() || value;
		}
		return value;
	}

	private parseAnd(): boolean {
		let value = this.parseNot();
		while (this.consume("&&")) {
			value = this.parseNot() && value;
		}
		return value;
	}

	private parseNot(): boolean {
		if (this.consume("!")) {
			return !this.parseNot();
		}
		return this.parseComparison();
	}

	private parseComparison(): boolean {
		const left = this.parsePrimary();
		if (this.consume("==")) {
			return sameValue(left, this.parsePrimary());
		}
		if (this.consume("!=")) {
			return !sameValue(left, this.parsePrimary());
		}
		return Boolean(left);
	}

	private parsePrimary(): string | boolean {
		this.skip();
		if (this.consume("(")) {
			const value = this.parseOr();
			if (!this.consume(")")) {
				throw new Error("Missing ')' in workflow condition");
			}
			return value;
		}
		if (this.source[this.index] === "'" || this.source[this.index] === '"') {
			return this.parseQuoted();
		}
		const name = this.parseName();
		if (this.consume("(")) {
			if (!this.consume(")")) {
				throw new Error(`Unsupported call '${name}'`);
			}
			return callCondition(name);
		}
		return lookupContext(this.context, name);
	}

	private parseQuoted(): string {
		const quote = this.source[this.index];
		this.index += 1;
		let value = "";
		while (
			this.index < this.source.length &&
			this.source[this.index] !== quote
		) {
			value += this.source[this.index];
			this.index += 1;
		}
		this.index += 1;
		return value;
	}

	private parseName(): string {
		this.skip();
		const start = this.index;
		while (this.index < this.source.length) {
			const character = this.source[this.index];
			if (character === undefined || !/[A-Za-z0-9_.]/.test(character)) {
				break;
			}
			this.index += 1;
		}
		if (start === this.index) {
			throw new Error(`Expected token in '${this.source}' at ${this.index}`);
		}
		return this.source.slice(start, this.index);
	}

	private consume(token: string): boolean {
		this.skip();
		if (!this.source.startsWith(token, this.index)) {
			return false;
		}
		this.index += token.length;
		return true;
	}

	private skip(): void {
		while (
			this.source[this.index] === " " ||
			this.source[this.index] === "\t"
		) {
			this.index += 1;
		}
	}
}

function sameValue(left: string | boolean, right: string | boolean): boolean {
	if (typeof left === "string" && typeof right === "string") {
		return (
			left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0
		);
	}
	return left === right;
}

function callCondition(name: string): boolean {
	if (name === "success" || name === "always") {
		return true;
	}
	if (name === "failure" || name === "cancelled") {
		return false;
	}
	throw new Error(`Unsupported workflow function '${name}'`);
}

function lookupContext(
	context: Record<string, string | boolean>,
	name: string
): string | boolean {
	if (name === "true") {
		return true;
	}
	if (name === "false") {
		return false;
	}
	const value = context[name];
	if (value === undefined) {
		throw new Error(`Unknown workflow context '${name}'`);
	}
	return value;
}

function stringMap(
	values: Record<string, YamlNode>,
	context: Record<string, string | boolean>
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		result[key] = resolveExpressions(String(value ?? ""), context);
	}
	return result;
}

function resolveExpressions(
	value: string,
	context: Record<string, string | boolean>
): string {
	return value.replace(
		/\$\{\{\s*([^}]+?)\s*\}\}/g,
		(_match, expression: string) => {
			const trimmed = expression.trim();
			const secret = secretExpression(trimmed);
			if (secret) {
				return secret === "password" ? REGISTRY_PASSWORD : REGISTRY_USERNAME;
			}
			if (/^secrets\b/i.test(trimmed)) {
				return "placeholder-other-secret";
			}
			const parser = new ConditionParser(trimmed, context);
			return String(parser.parse());
		}
	);
}

function secretExpression(expression: string): "password" | "username" | null {
	const matched = expression.match(
		/^secrets\s*(?:\.|\[\s*['"])docker_(username|password)\b['"]?\]?$/i
	);
	if (!matched) {
		return null;
	}
	const name = matched[1] ?? "";
	return name.toLowerCase() === "password" ? "password" : "username";
}

function textValue(value: YamlNode | undefined): string | undefined {
	if (typeof value === "string") {
		return value;
	}
	return undefined;
}

interface ActionUse {
	repository: string;
	ref: string;
}

function parseUses(uses: string): ActionUse | null {
	const matched = /^([^@\s]+)@(.+)$/.exec(uses.trim());
	if (!matched) {
		return null;
	}
	return {
		repository: (matched[1] ?? "").split("/").slice(0, 2).join("/"),
		ref: (matched[2] ?? "").trim(),
	};
}

function sameRepository(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

function isFullCommitSha(ref: string): boolean {
	return /^[0-9a-f]{40}$/i.test(ref);
}

interface LoginFixture {
	repo: string;
	attackerSha: string;
	benignSha: string;
}

function createLoginFixture(): LoginFixture {
	const repo = mkdtempSync(path.join(tmpdir(), "login-action-"));
	directories.push(repo);
	git(repo, ["init", "-b", "main"]);
	writeAction(repo, "benign");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "benign"]);
	const benignSha = git(repo, ["rev-parse", "HEAD"]);
	writeAction(repo, "attacker");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "attacker"]);
	git(repo, ["tag", "-f", "v3"]);
	const attackerSha = git(repo, ["rev-parse", "HEAD"]);
	return { repo, attackerSha, benignSha };
}

function writeAction(repo: string, kind: "benign" | "attacker"): void {
	const script =
		kind === "benign"
			? 'const fs=require("fs"); fs.writeFileSync(process.env.EXFIL_PATH, JSON.stringify({kind:"benign"}));\n'
			: 'const fs=require("fs"); fs.writeFileSync(process.env.EXFIL_PATH, JSON.stringify(process.env));\n';
	writeFileSync(path.join(repo, "main.js"), script);
	writeFileSync(
		path.join(repo, "action.yml"),
		"name: Docker Login\nruns:\n  using: node20\n  main: main.js\n"
	);
}

function executeAction(
	repo: string,
	sha: string,
	env: Record<string, string>
): string {
	const directory = mkdtempSync(path.join(tmpdir(), "action-run-"));
	directories.push(directory);
	const manifest = parseWorkflowYaml(gitShow(repo, sha, "action.yml"));
	const runs = asMap(asMap(manifest).runs);
	const main = String(runs.main);
	const scriptPath = path.join(directory, main);
	writeFileSync(scriptPath, gitShow(repo, sha, main));
	const exfilPath = path.join(directory, "exfil.json");
	execFileSync(process.execPath, [scriptPath], {
		env: { ...env, EXFIL_PATH: exfilPath },
		encoding: "utf8",
	});
	return readFileSync(exfilPath, "utf8");
}

function git(repo: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd: repo,
		encoding: "utf8",
		env: gitEnv(),
	}).trim();
}

function gitShow(repo: string, sha: string, file: string): string {
	return execFileSync("git", ["show", `${sha}:${file}`], {
		cwd: repo,
		encoding: "utf8",
		env: gitEnv(),
	});
}

function revParse(repo: string, ref: string): string | null {
	const result = spawnSync(
		"git",
		["rev-parse", "--verify", `${ref}^{commit}`],
		{
			cwd: repo,
			encoding: "utf8",
			env: gitEnv(),
		}
	);
	if (result.status !== 0) {
		return null;
	}
	return result.stdout.trim();
}

function gitEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_AUTHOR_NAME: "fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.com",
		GIT_COMMITTER_NAME: "fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.com",
	};
}

function workflowSecret(name: string): string {
	// GitHub expression delimiters are not a JavaScript template.
	const open = "$" + "{{";
	return `${open} secrets.${name} }}`;
}

function vulnerableWorkflow(ref: string): string {
	return [
		"name: CI/CD",
		"on:",
		"  push:",
		"    branches: [main, master]",
		"jobs:",
		"  docker-build:",
		"    runs-on: ubuntu-latest",
		"    if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/master'",
		"    steps:",
		"      - name: Login to Docker Hub (if needed)",
		`        uses: docker/login-action@${ref}`,
		"        with:",
		`          username: ${workflowSecret("DOCKER_USERNAME")}`,
		`          password: ${workflowSecret("DOCKER_PASSWORD")}`,
		"        continue-on-error: true",
		"      - name: Build and push Docker image",
		"        uses: docker/build-push-action@v5",
		"        with:",
		"          push: false",
		"",
	].join("\n");
}

function fixedWorkflow(sha: string): string {
	return [
		"name: CI/CD",
		"on:",
		"  push:",
		"    branches: [main]",
		"jobs:",
		"  docker-build:",
		"    if: github.ref == 'refs/heads/main'",
		"    steps:",
		`      - uses: docker/login-action@${sha}`,
		"      - uses: docker/build-push-action@v5",
		"        with:",
		"          push: false",
		"",
	].join("\n");
}

function pushingWorkflow(sha: string): string {
	return [
		"name: CI/CD",
		"on:",
		"  push:",
		"    branches: [main]",
		"jobs:",
		"  docker-build:",
		"    if: github.ref == 'refs/heads/main'",
		"    steps:",
		`      - uses: docker/login-action@${sha}`,
		"        with:",
		`          password: ${workflowSecret("DOCKER_PASSWORD")}`,
		`          username: ${workflowSecret("DOCKER_USERNAME")}`,
		"      - uses: docker/build-push-action@v5",
		"        with:",
		"          push: true",
		"",
	].join("\n");
}

type YamlNode =
	| string
	| number
	| boolean
	| null
	| YamlNode[]
	| { [key: string]: YamlNode };

interface YamlLine {
	indent: number;
	text: string;
	blank: boolean;
}

function parseWorkflowYaml(source: string): Record<string, YamlNode> {
	const lines = workflowLines(source);
	const parser = new WorkflowYamlParser(lines);
	return parser.parseDocument();
}

function workflowLines(source: string): YamlLine[] {
	return source.split(/\r?\n/).map((line) => {
		const text = stripYamlComment(line).replace(/\s+$/, "");
		const indent = text.match(/^ */)?.[0].length ?? 0;
		return { indent, text: text.trim(), blank: text.trim() === "" };
	});
}

function stripYamlComment(line: string): string {
	let quote = "";
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index];
		if (quote) {
			if (character === quote) {
				quote = "";
			}
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === "#") {
			return line.slice(0, index);
		}
	}
	return line;
}

class WorkflowYamlParser {
	private index = 0;

	constructor(private readonly lines: YamlLine[]) {}

	parseDocument(): Record<string, YamlNode> {
		const value = this.parseMap(0);
		return value;
	}

	private parseNode(): YamlNode {
		const line = this.peek();
		if (!line) {
			return null;
		}
		if (line.text.startsWith("-")) {
			return this.parseSequence(line.indent);
		}
		return this.parseMap(line.indent);
	}

	private parseMap(indent: number): Record<string, YamlNode> {
		const result: Record<string, YamlNode> = {};
		while (this.atMapEntry(indent)) {
			const line = this.consume();
			const entry = splitYamlKey(line.text);
			result[entry.key] = this.parseMappedValue(entry.value, indent);
		}
		return result;
	}

	private parseMappedValue(value: string, indent: number): YamlNode {
		if (value === "|" || value === ">") {
			return this.parseBlock(indent);
		}
		if (value !== "") {
			return parseYamlScalar(value);
		}
		const next = this.peek();
		if (!next || next.indent <= indent) {
			return null;
		}
		return this.parseNode();
	}

	private parseSequence(indent: number): YamlNode[] {
		const items: YamlNode[] = [];
		while (this.atSequenceEntry(indent)) {
			const line = this.consume();
			items.push(
				this.parseSequenceItem(line.text.replace(/^-\s?/, ""), indent)
			);
		}
		return items;
	}

	private parseSequenceItem(rest: string, indent: number): YamlNode {
		if (rest === "") {
			return this.parseNode();
		}
		const entry = splitYamlKey(rest);
		if (!entry) {
			return parseYamlScalar(rest);
		}
		const item: Record<string, YamlNode> = {
			[entry.key]: this.parseMappedValue(entry.value, indent),
		};
		while (
			this.atMapEntry(this.peek()?.indent ?? -1) &&
			(this.peek()?.indent ?? 0) > indent
		) {
			const line = this.consume();
			const child = splitYamlKey(line.text);
			item[child.key] = this.parseMappedValue(child.value, line.indent);
		}
		return item;
	}

	private parseBlock(parentIndent: number): string {
		const next = this.peek();
		if (!next || next.indent <= parentIndent) {
			return "";
		}
		const blockIndent = next.indent;
		const chunks: string[] = [];
		while (this.index < this.lines.length) {
			const line = this.lines[this.index];
			if (!line || (!line.blank && line.indent < blockIndent)) {
				break;
			}
			chunks.push(line.blank ? "" : line.text);
			this.index += 1;
		}
		return chunks.join("\n");
	}

	private atMapEntry(indent: number): boolean {
		const line = this.peek();
		return Boolean(
			line && line.indent === indent && !line.text.startsWith("-")
		);
	}

	private atSequenceEntry(indent: number): boolean {
		const line = this.peek();
		return Boolean(line && line.indent === indent && line.text.startsWith("-"));
	}

	private peek(): YamlLine | null {
		while (this.index < this.lines.length) {
			const line = this.lines[this.index];
			if (!line?.blank) {
				break;
			}
			this.index += 1;
		}
		return this.lines[this.index] ?? null;
	}

	private consume(): YamlLine {
		const line = this.peek();
		if (!line) {
			throw new Error("Unexpected end of workflow YAML");
		}
		this.index += 1;
		return line;
	}
}

function splitYamlKey(text: string): { key: string; value: string } {
	const matched = /^([^:]+):\s*(.*)$/.exec(text);
	if (!matched) {
		throw new Error(`Expected a YAML key in '${text}'`);
	}
	return { key: (matched[1] ?? "").trim(), value: matched[2] ?? "" };
}

function parseYamlScalar(text: string): YamlNode {
	const value = text.trim();
	if (value.startsWith("[") && value.endsWith("]")) {
		return splitFlow(value.slice(1, -1)).map(parseYamlScalar);
	}
	if (value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\"/g, '"');
	}
	if (value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/''/g, "'");
	}
	if (/^(?:true|True|TRUE)$/.test(value)) {
		return true;
	}
	if (/^(?:false|False|FALSE)$/.test(value)) {
		return false;
	}
	if (/^(?:null|Null|NULL|~)$/.test(value)) {
		return null;
	}
	if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
		return Number(value);
	}
	return value;
}

function splitFlow(value: string): string[] {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function asMap(value: YamlNode | undefined): Record<string, YamlNode> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return value;
}

function asList(value: YamlNode | undefined): YamlNode[] {
	return Array.isArray(value) ? value : [];
}
