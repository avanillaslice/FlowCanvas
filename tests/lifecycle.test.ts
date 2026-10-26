import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startService } from "../src/server/service.js";
import { Store } from "../src/server/store.js";

describe("foreground service shutdown", () => {
  it("closes active HTTP streams, releases the port, and saves SQLite before returning", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flowcanvas-lifecycle-"));
    const service = startService({
      directory,
      port: 0,
      webPath: join(directory, "no-web"),
    });
    await service.ready;
    const port = (service.server.address() as import("node:net").AddressInfo)
      .port;
    const url = `http://127.0.0.1:${port}`;
    service.store.createProject(
      "Preserved after shutdown",
      crypto.randomUUID(),
    );
    const session = await (
      await fetch(url + "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).json();
    const stream = await fetch(
      url + `/api/events?sessionId=${session.id}&sessionToken=${session.token}`,
    );
    const reader = stream.body!.getReader();
    await reader.read();
    await service.close();
    await reader.cancel();
    expect(service.server.listening).toBe(false);
    expect(service.store.db.open).toBe(false);
    await expect(fetch(url + "/api/health")).rejects.toThrow();
    await service.close(); // Repeated shutdown requests are harmless.
    const reopened = new Store(join(directory, "flowcanvas.db"));
    try {
      expect(reopened.projects()[0].name).toBe("Preserved after shutdown");
    } finally {
      reopened.close();
    }
  });
  it("releases the database when another terminal already owns the port", async () => {
    const first = startService({
      directory: mkdtempSync(join(tmpdir(), "flowcanvas-owner-")),
      port: 0,
    });
    await first.ready;
    const port = (first.server.address() as import("node:net").AddressInfo)
      .port;
    const second = startService({
      directory: mkdtempSync(join(tmpdir(), "flowcanvas-duplicate-")),
      port,
    });
    try {
      await expect(second.ready).rejects.toThrow();
      expect(second.store.db.open).toBe(false);
      expect(first.server.listening).toBe(true);
    } finally {
      await second.close();
      await first.close();
    }
  });
});
