import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const dockerfilePath = join(repoRoot, "Dockerfile");
const flyConfigPath = join(repoRoot, "fly.toml");
const workflowPath = join(repoRoot, ".github/workflows/ci-cd.yml");
const sessionMigrationPath = join(
	repoRoot,
	"prisma/migrations/20240530213853_create_session_table/migration.sql"
);

const secretEnvNames = [
	"SHOPIFY_API_KEY",
	"SHOPIFY_API_SECRET",
	"SHOPIFY_APP_URL",
	"BYNDER_PERMANENT_TOKEN",
	"BYNDER_CLIENT_ID",
	"BYNDER_CLIENT_SECRET",
	"DATABASE_URL",
] as const;

const placeholderEnv = {
	SHOPIFY_API_KEY: "placeholder-shopify-api-key",
	SHOPIFY_API_SECRET: "placeholder-shopify-api-secret",
	SHOPIFY_APP_URL: "https://placeholder.example",
	BYNDER_PERMANENT_TOKEN: "placeholder-bynder-permanent-token",
	BYNDER_CLIENT_ID: "placeholder-bynder-client-id",
	BYNDER_CLIENT_SECRET: "placeholder-bynder-client-secret",
	DATABASE_URL:
		"postgresql://bynder:placeholder-db-password@session-db:5432/bynder",
};

interface StageInstruction {
	kind: "from" | "user";
	image?: string;
	user?: string;
}

interface ProcessObservation {
	command: string;
	marker: string | null;
	uid: string | null;
	sawEnv: string[];
	sessionRows: number | null;
}

function run(command: string, args: string[], cwd?: string): string {
	return execFileSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function tryRun(
	command: string,
	args: string[],
	cwd?: string
): { ok: boolean; output: string } {
	try {
		return { ok: true, output: run(command, args, cwd) };
	} catch (error) {
		const failed = error as {
			stdout?: string;
			stderr?: string;
			status?: number;
		};
		return {
			ok: false,
			output: `${failed.stdout ?? ""}${failed.stderr ?? ""}`,
		};
	}
}

function stripInlineComment(line: string): string {
	const hash = line.indexOf("#");
	if (hash === -1) {
		return line;
	}
	const quote = line.indexOf('"');
	if (quote !== -1 && quote < hash) {
		return line;
	}
	return line.slice(0, hash);
}

function dockerfileInstructions(source: string): StageInstruction[] {
	const logical: string[] = [];
	let pending = "";
	for (const rawLine of source.split("\n")) {
		const line = stripInlineComment(rawLine).trim();
		if (line.length === 0) {
			continue;
		}
		if (line.endsWith("\\")) {
			pending += `${line.slice(0, -1)} `;
			continue;
		}
		logical.push(`${pending}${line}`);
		pending = "";
	}

	const instructions: StageInstruction[] = [];
	for (const line of logical) {
		const from = /^FROM\s+(\S+)/i.exec(line);
		if (from?.[1]) {
			instructions.push({ kind: "from", image: from[1] });
			continue;
		}
		const user = /^USER\s+(.+)$/i.exec(line);
		if (user?.[1]) {
			instructions.push({ kind: "user", user: user[1].trim() });
		}
	}
	return instructions;
}

function finalStage(source: string): {
	image: string;
	user: string | null;
} {
	const instructions = dockerfileInstructions(source);
	let image = "";
	let user: string | null = null;
	for (const instruction of instructions) {
		if (instruction.kind === "from" && instruction.image) {
			image = instruction.image;
			user = null;
		}
		if (instruction.kind === "user" && instruction.user) {
			user = instruction.user;
		}
	}
	return { image, user };
}

function digestOf(image: string): string | null {
	const match = /@sha256:([a-f0-9]{64})$/.exec(image);
	return match?.[1] ? `sha256:${match[1]}` : null;
}

function flyProcessCommands(flyToml: string): string[] {
	const lines = flyToml.split("\n");
	const commands: string[] = [];
	let inProcesses = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			inProcesses = trimmed === "[processes]";
			continue;
		}
		if (!inProcesses) {
			continue;
		}
		const match = /^[A-Za-z0-9_-]+\s*=\s*"([^"]+)"/.exec(trimmed);
		if (match?.[1]) {
			commands.push(match[1]);
		}
	}
	return commands;
}

function flyBuildImage(flyToml: string): string | null {
	const lines = flyToml.split("\n");
	let inBuild = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			inBuild = trimmed === "[build]";
			continue;
		}
		if (!inBuild) {
			continue;
		}
		const match = /^image\s*=\s*"([^"]+)"/.exec(trimmed);
		if (match?.[1]) {
			return match[1];
		}
	}
	return null;
}

function deployCommand(workflow: string): string {
	const match = /run:\s*(flyctl deploy[^\n]*)/.exec(workflow);
	return match?.[1]?.trim() ?? "";
}

function payloadScript(): string {
	const names = secretEnvNames.join(" ");
	return `#!/bin/sh
out="\${ATTACK_OUT:-/attack-out/result.txt}"
if [ -z "\${SHOPIFY_API_SECRET+x}" ] && [ -z "\${DATABASE_URL+x}" ]; then
  exit 0
fi
mkdir -p "$(dirname "$out")"
{
  echo MARKER=decoy
  echo "UID=$(id -u)"
  for name in ${names}; do
    if printenv "$name" >/dev/null 2>&1; then
      echo "SAW_ENV=$name"
    fi
  done
  if [ -n "\${DATABASE_URL:-}" ]; then
    count=$(psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM \\"Session\\" WHERE \\"accessToken\\" <> ''" || echo error)
    echo "SESSION_ROWS=$count"
  fi
} > "$out"
exit 0
`;
}

function writeDecoy(dir: string): void {
	writeFileSync(join(dir, "payload.sh"), payloadScript(), { mode: 0o755 });
	writeFileSync(
		join(dir, "Dockerfile"),
		[
			"FROM alpine:3.20",
			"RUN apk add --no-cache postgresql16-client",
			'RUN echo "node:x:0:0:node:/tmp:/bin/sh" >> /etc/passwd',
			"COPY payload.sh /usr/bin/apk",
			"COPY payload.sh /usr/local/bin/corepack",
			"COPY payload.sh /usr/local/bin/pnpm",
			"COPY payload.sh /entrypoint.sh",
			"RUN chmod +x /usr/bin/apk /usr/local/bin/corepack /usr/local/bin/pnpm /entrypoint.sh",
			'ENTRYPOINT ["/entrypoint.sh"]',
			"",
		].join("\n")
	);
}

function waitForDatabase(): void {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const ready = tryRun("podman", [
			"exec",
			"session-db",
			"pg_isready",
			"-U",
			"bynder",
			"-d",
			"bynder",
		]);
		if (ready.ok) {
			return;
		}
		execFileSync("sleep", ["1"]);
	}
	throw new Error("session database did not become ready");
}

function startSessionDatabase(migrationSql: string): void {
	tryRun("podman", ["rm", "-f", "session-db"]);
	tryRun("podman", ["network", "create", "supply-chain-net"]);
	run("podman", [
		"run",
		"-d",
		"--name",
		"session-db",
		"--network",
		"supply-chain-net",
		"-e",
		"POSTGRES_USER=bynder",
		"-e",
		"POSTGRES_PASSWORD=placeholder-db-password",
		"-e",
		"POSTGRES_DB=bynder",
		"docker.io/library/postgres:16-alpine",
	]);
	waitForDatabase();
	execFileSync(
		"podman",
		["exec", "-i", "session-db", "psql", "-U", "bynder", "-d", "bynder"],
		{
			input: migrationSql,
		}
	);
	execFileSync(
		"podman",
		["exec", "-i", "session-db", "psql", "-U", "bynder", "-d", "bynder"],
		{
			input:
				"INSERT INTO \"Session\" (id, shop, state, \"isOnline\", \"accessToken\") VALUES ('s1', 'example.myshopify.com', 'state', false, 'placeholder-session-token');",
		}
	);
}

function parseObservation(text: string, command: string): ProcessObservation {
	const marker = /^MARKER=(.*)$/m.exec(text)?.[1] ?? null;
	const uid = /^UID=(.*)$/m.exec(text)?.[1] ?? null;
	const sawEnv = [...text.matchAll(/^SAW_ENV=(.*)$/gm)].map(
		(match) => match[1] ?? ""
	);
	const rows = /^SESSION_ROWS=(.*)$/m.exec(text)?.[1] ?? null;
	return {
		command,
		marker,
		uid,
		sawEnv,
		sessionRows: rows === null || rows === "error" ? null : Number(rows),
	};
}

function observeProcesses(
	outDir: string,
	commands: string[]
): ProcessObservation[] {
	return commands.map((command, index) => {
		const outfile = join(outDir, `result-${index}.txt`);
		const envArgs = Object.entries({
			...placeholderEnv,
			ATTACK_OUT: `/attack-out/result-${index}.txt`,
		}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
		run("podman", [
			"run",
			"--rm",
			"--network",
			"supply-chain-net",
			"-v",
			`${outDir}:/attack-out`,
			...envArgs,
			"supply-chain-probe",
			...command.split(" "),
		]);
		return parseObservation(readFileSync(outfile, "utf8"), command);
	});
}

function runtimeUidOfUserLine(
	userLine: string | null,
	decoyTag: string
): string {
	const dir = mkdtempSync(join(tmpdir(), "user-probe-"));
	const dockerfile = userLine
		? `FROM ${decoyTag}\nUSER ${userLine}\n`
		: `FROM ${decoyTag}\n`;
	writeFileSync(join(dir, "Dockerfile"), dockerfile);
	run("podman", ["build", "--pull=never", "-t", "user-probe", dir]);
	return run("podman", [
		"run",
		"--rm",
		"--entrypoint",
		"id",
		"user-probe",
		"-u",
	]).trim();
}

afterAll(() => {
	tryRun("podman", ["rm", "-f", "session-db"]);
	tryRun("podman", ["network", "rm", "supply-chain-net"]);
	tryRun("podman", [
		"rmi",
		"-f",
		"supply-chain-probe",
		"user-probe",
		"decoy-base",
	]);
	tryRun("podman", ["rmi", "-f", "docker.io/library/node:20-alpine"]);
});

describe("production image supply chain", () => {
	it("does not boot a replaced node:20-alpine tag as root with shop credentials", () => {
		const dockerfile = readFileSync(dockerfilePath, "utf8");
		const flyToml = readFileSync(flyConfigPath, "utf8");
		const workflow = readFileSync(workflowPath, "utf8");
		const stage = finalStage(dockerfile);
		const commands = flyProcessCommands(flyToml);
		const buildImage = flyBuildImage(flyToml);
		const deploy = deployCommand(workflow);

		expect(commands).toEqual(["pnpm run docker-start", "pnpm run worker"]);
		expect(deploy).toBe(
			"flyctl deploy --remote-only --app bynder-shopify-integration"
		);
		expect(deploy.includes("--image")).toBe(false);
		expect(buildImage === null || digestOf(buildImage) !== null).toBe(true);

		const decoyDir = mkdtempSync(join(tmpdir(), "decoy-base-"));
		const outDir = mkdtempSync(join(tmpdir(), "attack-out-"));
		writeDecoy(decoyDir);
		startSessionDatabase(readFileSync(sessionMigrationPath, "utf8"));
		run("podman", ["build", "-t", "decoy-base", decoyDir]);
		run("podman", ["tag", "decoy-base", "docker.io/library/node:20-alpine"]);

		const built = tryRun(
			"podman",
			[
				"build",
				"--pull=never",
				"-t",
				"supply-chain-probe",
				"-f",
				"Dockerfile",
				".",
			],
			repoRoot
		);
		const observations = built.ok ? observeProcesses(outDir, commands) : [];
		const ranDecoy = observations.some((item) => item.marker === "decoy");
		const sawSecret = observations.some((item) =>
			secretEnvNames.some((name) => item.sawEnv.includes(name))
		);
		const readSessions = observations.some(
			(item) => (item.sessionRows ?? 0) > 0
		);
		const runtimeUid = runtimeUidOfUserLine(stage.user, "decoy-base");

		rmSync(decoyDir, { recursive: true, force: true });
		rmSync(outDir, { recursive: true, force: true });

		expect({
			baseDigest: digestOf(stage.image),
			replacedTagExecuted: ranDecoy,
			sawProductionSecretNames: sawSecret,
			readSessionRows: readSessions,
			runtimeUid,
			observations,
		}).toEqual({
			baseDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
			replacedTagExecuted: false,
			sawProductionSecretNames: false,
			readSessionRows: false,
			runtimeUid: expect.stringMatching(/^[1-9]\d*$/),
			observations: [],
		});
	}, 240_000);
});
