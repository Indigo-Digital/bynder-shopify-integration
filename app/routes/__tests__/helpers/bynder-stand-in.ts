import { createServer, type IncomingMessage, type Server } from "node:http";

export interface RecordedRequest {
	method: string;
	path: string;
}

const PDF = Buffer.from("%PDF-1.1\n");

/**
 * Local stand-in for the Bynder HTTP API the app calls, and for the staged
 * upload target Shopify's GraphQL response points at. Nothing here is sent
 * to Bynder or Shopify.
 */
export class BynderStandIn {
	readonly requests: RecordedRequest[] = [];
	private server: Server | null = null;
	private origin = "";

	async start(): Promise<string> {
		this.server = createServer((req, res) => {
			this.route(req, res);
		});
		await new Promise<void>((resolve) => {
			this.server?.listen(0, "127.0.0.1", () => resolve());
		});
		const address = this.server.address();
		if (!address || typeof address === "string") {
			throw new Error("Bynder stand-in failed to bind");
		}
		this.origin = `http://127.0.0.1:${address.port}`;
		return this.origin;
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (!server) {
			return;
		}
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	private route(req: IncomingMessage, res: import("node:http").ServerResponse) {
		const url = new URL(req.url ?? "/", this.origin);
		const method = req.method ?? "GET";
		this.requests.push({ method, path: url.pathname });

		if (method === "DELETE" && url.pathname.includes("/subscriptions/")) {
			res.writeHead(204);
			res.end();
			return;
		}
		if (method === "POST" && url.pathname.endsWith("/staged-upload")) {
			res.writeHead(204);
			res.end();
			return;
		}
		if (url.pathname.endsWith("/download")) {
			res.writeHead(200, { "Content-Type": "application/pdf" });
			res.end(PDF);
			return;
		}
		if (/\/v4\/media\/[^/]+\/?$/.test(url.pathname)) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					id: "asset-previous-install",
					name: "previous-campaign.jpg",
					description: "previous install asset",
					type: "image",
					tags: ["shopify-sync"],
					version: 2,
				})
			);
			return;
		}
		if (url.pathname.includes("/v4/media")) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify([
					{
						id: "asset-previous-install",
						name: "previous-campaign.pdf",
						tags: ["shopify-sync"],
						version: 2,
					},
				])
			);
			return;
		}
		res.writeHead(404);
		res.end();
	}
}
