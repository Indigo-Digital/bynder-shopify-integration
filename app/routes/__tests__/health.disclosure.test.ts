/**
 * @vitest-environment node
 *
 * Production builds copy prisma/schema.postgresql.prisma before generating
 * the client (Dockerfile). These tests use that schema so a failed probe
 * is the same PostgreSQL client the deployed app runs.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LoaderFunctionArgs } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const DATABASE_HOST = "db.internal.example";
const DATABASE_PORT = 5432;
const DATABASE_URL = `postgresql://${DATABASE_HOST}:${DATABASE_PORT}/appdb?connect_timeout=1`;

const clientRoot = path.join(
	process.cwd(),
	"node_modules/.cache/health-disclosure"
);

type ProbeClient = {
	$disconnect: () => Promise<void>;
};

type GeneratedClientModule = {
	PrismaClient: new (options: {
		datasources: { db: { url: string } };
	}) => ProbeClient;
};

let probeClient: ProbeClient | undefined;

function writePostgresSchema(): string {
	const sourcePath = path.join(
		process.cwd(),
		"prisma/schema.postgresql.prisma"
	);
	const source = fs.readFileSync(sourcePath, "utf8");
	const output = path.join(clientRoot, "client").replaceAll("\\", "/");
	const schema = source.replace(
		'provider = "prisma-client-js"',
		`provider = "prisma-client-js"\n  output   = "${output}"`
	);
	fs.mkdirSync(clientRoot, { recursive: true });
	const schemaPath = path.join(clientRoot, "schema.prisma");
	fs.writeFileSync(schemaPath, schema);
	return schemaPath;
}

function generatePostgresClient(schemaPath: string): void {
	execFileSync("pnpm", ["exec", "prisma", "generate", "--schema", schemaPath], {
		cwd: process.cwd(),
		env: {
			...process.env,
			DATABASE_URL,
			PRISMA_GENERATE_SKIP_AUTOINSTALL: "1",
		},
		stdio: "inherit",
	});
}

async function loadProbeClient(): Promise<ProbeClient> {
	const entry = path.join(clientRoot, "client/index.js");
	const generated = (await import(
		pathToFileURL(entry).href
	)) as GeneratedClientModule;
	return new generated.PrismaClient({
		datasources: { db: { url: DATABASE_URL } },
	});
}

async function invokeHealthLoader(): Promise<Response> {
	vi.resetModules();
	vi.doMock("../../db.server.js", () => ({ default: probeClient }));
	vi.doMock("../../db.server", () => ({ default: probeClient }));
	const health = await import("../health.js");
	const args = {
		request: new Request("http://127.0.0.1/health"),
		params: {},
		context: {},
	} as LoaderFunctionArgs;
	return health.loader(args);
}

describe("health check database error disclosure", () => {
	beforeAll(() => {
		const schemaPath = writePostgresSchema();
		generatePostgresClient(schemaPath);
	}, 120_000);

	afterAll(async () => {
		await probeClient?.$disconnect();
	});

	it("omits the database host and port when the probe cannot connect", async () => {
		probeClient = await loadProbeClient();
		const response = await invokeHealthLoader();
		const body: unknown = await response.json();
		const serialized = JSON.stringify(body);

		expect(response.status).toBe(503);
		expect(serialized).not.toContain(DATABASE_HOST);
		expect(serialized).not.toContain(`${DATABASE_HOST}:${DATABASE_PORT}`);
		expect(serialized).not.toContain("Can't reach database server");
		expect(serialized).not.toContain("Please make sure your database server");
	});
});
