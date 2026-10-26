import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { z, ZodError } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { editSchema, selectionSchema } from "../shared/model.js";
import { Store, AppError } from "./store.js";
import { Workspace } from "./workspace.js";
import { createMcp } from "./mcp.js";

export function createApp(
  store: Store,
  options: {
    token: string | (() => string);
    dataDirectory?: string;
    credentialDirectory?: string;
    webPath?: string;
    flushMs?: number;
    leaseMs?: number;
  },
) {
  const app = express();
  const workspace = new Workspace(store, options.leaseMs, options.flushMs);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const hostname = req.hostname;
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname))
      return res.status(403).json({
        code: "invalid_host",
        message: "Only localhost requests are allowed.",
      });
    const origin = req.get("origin");
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (
          !["http:", "https:"].includes(parsed.protocol) ||
          !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
        )
          throw new Error();
      } catch {
        return res.status(403).json({
          code: "invalid_origin",
          message: "Only local application origins are allowed.",
        });
      }
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; font-src 'self'; frame-ancestors 'none'",
    );
    next();
  });
  app.use(
    express.json({ limit: "8mb", type: ["application/json", "text/plain"] }),
  );
  app.get("/api/health", (_req, res) =>
    res.json({
      status: "ok",
      version: "0.1.0",
      dataDirectory: options.dataDirectory,
      credentialDirectory: options.credentialDirectory,
    }),
  );
  app.post("/api/session", (req, res) =>
    res.json(
      workspace.register(
        z.object({ resumeId: z.string().optional() }).parse(req.body).resumeId,
      ),
    ),
  );
  app.use("/api", (req, res, next) => {
    const sid =
      req.get("x-session-id") ??
      String(req.query.sessionId ?? req.body?.sessionId ?? "");
    const credential =
      req.get("x-session-token") ??
      String(req.query.sessionToken ?? req.body?.sessionToken ?? "");
    try {
      const session = workspace.authenticate(sid, credential);
      res.locals.sessionId = session.id;
      next();
    } catch (e) {
      next(e);
    }
  });
  const route =
    (fn: (req: express.Request, res: express.Response) => unknown) =>
    async (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      try {
        const result = await fn(req, res);
        if (!res.headersSent) res.json(result ?? { ok: true });
      } catch (e) {
        next(e);
      }
    };
  app.get("/api/events", (req, res) => {
    const session = workspace.sessions.get(res.locals.sessionId)!;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    session.send = send;
    send("ready", {});
    const timer = setInterval(() => res.write(": keepalive\n\n"), 15000);
    req.on("close", () => {
      clearInterval(timer);
      if (session.send === send) session.send = undefined;
    });
  });
  app.post(
    "/api/heartbeat",
    route((_req, res) => workspace.touch(res.locals.sessionId)),
  );
  app.post(
    "/api/close",
    route((_req, res) => workspace.close(res.locals.sessionId)),
  );
  app.post(
    "/api/share",
    route((_req, res) => workspace.claim(res.locals.sessionId)),
  );
  app.post(
    "/api/selection",
    route((req, res) =>
      workspace.select(res.locals.sessionId, selectionSchema.parse(req.body)),
    ),
  );
  app.post(
    "/api/flush",
    route((req, res) => {
      const data = z
        .object({ requestId: z.string(), success: z.boolean() })
        .parse(req.body);
      workspace.acknowledge(res.locals.sessionId, data.requestId, data.success);
    }),
  );
  app.get(
    "/api/catalog",
    route(() => ({ projects: store.projects(), concepts: store.concepts() })),
  );
  app.post("/api/inspection", route((req, res) => {
    const data = z.object({ requestId: z.string(), report: z.unknown() }).strict().parse(req.body);
    workspace.acknowledgeInspection(res.locals.sessionId, data.requestId, data.report);
  }));
  app.get(
    "/api/concepts/:id",
    route((req) => store.detail(String(req.params.id))),
  );
  app.get(
    "/api/drafts/:id",
    route((req) => ({
      ...store.draft(String(req.params.id)),
      canUndo: !!store.history.get(String(req.params.id))?.length,
      canRedo: !!store.redos.get(String(req.params.id))?.length,
    })),
  );
  app.get(
    "/api/versions/:id",
    route((req) => store.version(String(req.params.id))),
  );
  app.post(
    "/api/projects",
    route((req) => {
      const data = z
        .object({ name: z.string(), operationId: z.string() })
        .parse(req.body);
      return store.createProject(data.name, data.operationId);
    }),
  );
  app.post(
    "/api/concepts",
    route((req) => {
      const data = z
        .object({
          projectId: z.string(),
          name: z.string(),
          operationId: z.string(),
        })
        .parse(req.body);
      return store.createConcept(data.projectId, data.name, data.operationId);
    }),
  );
  app.post(
    "/api/rename",
    route((req) => {
      const data = z
        .object({
          kind: z.enum(["project", "concept"]),
          id: z.string(),
          name: z.string(),
        })
        .parse(req.body);
      store.rename(data.kind, data.id, data.name);
    }),
  );
  app.post(
    "/api/drafts",
    route((req) => {
      const data = z
        .object({
          conceptId: z.string(),
          name: z.string(),
          sourceVersionId: z.string().nullable(),
          operationId: z.string(),
        })
        .parse(req.body);
      return store.createDraft(
        data.conceptId,
        data.name,
        data.sourceVersionId,
        data.operationId,
      );
    }),
  );
  app.post(
    "/api/drafts/copy",
    route((req) => {
      const data = z
        .object({
          conceptId: z.string(),
          sourceDraftId: z.string(),
          name: z.string(),
          expectedSourceRevision: z.number().int().nonnegative(),
          operationId: z.string().min(1).max(160),
        })
        .strict()
        .parse(req.body);
      return store.copyDraft(
        data.conceptId,
        data.sourceDraftId,
        data.name,
        data.expectedSourceRevision,
        data.operationId,
      );
    }),
  );
  app.post(
    "/api/drafts/delete",
    route((req) => {
      const data = z
        .object({
          draftId: z.string(),
          expectedRevision: z.number().int().nonnegative(),
          operationId: z.string().min(1).max(160),
        })
        .parse(req.body);
      return workspace.deleteDraft(
        data.draftId,
        data.expectedRevision,
        data.operationId,
      );
    }),
  );
  app.post(
    "/api/edit",
    route((req) => store.edit(editSchema.parse(req.body))),
  );
  app.post(
    "/api/apply",
    route((req) => {
      const data = z
        .object({
          draftId: z.string(),
          expectedRevision: z.number().int().nonnegative(),
          operationId: z.string(),
        })
        .parse(req.body);
      return store.apply(data.draftId, data.expectedRevision, data.operationId);
    }),
  );
  app.post(
    "/api/history",
    route((req) => {
      const data = z
        .object({
          draftId: z.string(),
          expectedRevision: z.number().int().nonnegative(),
          operationId: z.string(),
          direction: z.enum(["undo", "redo"]),
        })
        .parse(req.body);
      return store.undo(
        data.draftId,
        data.expectedRevision,
        data.direction,
        data.operationId,
      );
    }),
  );
  app.post(
    "/api/arrange",
    route((req) => {
      const data = z
        .object({
          draftId: z.string(),
          expectedRevision: z.number().int().nonnegative(),
          operationId: z.string(),
          direction: z.enum(["RIGHT", "DOWN"]).default("RIGHT"),
        })
        .parse(req.body);
      return store.arrange(
        data.draftId,
        data.expectedRevision,
        data.operationId,
        data.direction,
      );
    }),
  );
  store.changed = (conceptId) => workspace.broadcast("changed", { conceptId });
  app.use("/mcp", (req, res, next) => {
    const received = Buffer.from(req.get("authorization") ?? "");
    const token =
      typeof options.token === "function" ? options.token() : options.token;
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    )
      return res.status(401).json({ error: "FlowCanvas MCP token required." });
    next();
  });
  app.post("/mcp", async (req, res, next) => {
    const server = createMcp(store, workspace);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      next(e);
    }
  });
  app.all("/mcp", (_req, res) => res.status(405).end());
  if (options.webPath && existsSync(options.webPath)) {
    app.use(express.static(options.webPath));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(join(options.webPath!, "index.html")),
    );
  }
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (res.headersSent) return;
      if (err instanceof AppError)
        return res
          .status(err.status)
          .json({ code: err.code, message: err.message, details: err.details });
      if (err instanceof ZodError)
        return res.status(400).json({
          code: "invalid_request",
          message: err.issues.map((i) => i.message).join("; "),
        });
      console.error(err instanceof Error ? err.message : err);
      return res.status(500).json({
        code: "internal_error",
        message:
          "The operation could not be saved. Your pending edits have been kept.",
      });
    },
  );
  return { app, workspace };
}
