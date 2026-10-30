import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  clearSessionCookie,
  readSessionCookie,
  SESSION_COOKIE_NAME,
  setSessionCookie,
} from "../../src/auth/cookie.js";

function appWithCookieRoutes(): express.Express {
  const app = express();
  app.get("/read", (req, res) => {
    res.json({ value: readSessionCookie(req) ?? null });
  });
  app.get("/set", (_req, res) => {
    setSessionCookie(res, "secret-value", 60);
    res.status(204).end();
  });
  app.get("/clear", (_req, res) => {
    clearSessionCookie(res);
    res.status(204).end();
  });
  return app;
}

function setCookieHeader(response: request.Response, name: string): string {
  const raw = response.headers["set-cookie"];
  const headers = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const header = headers.find((value) => value.startsWith(`${name}=`));
  if (header === undefined) {
    throw new Error(`missing ${name} Set-Cookie header`);
  }
  return header;
}

describe("session cookie helpers", () => {
  it("should read a parsed cookie value", async () => {
    const response = await request(appWithCookieRoutes())
      .get("/read")
      .set("Cookie", `${SESSION_COOKIE_NAME}=parsed-value`);

    expect(response.body).toEqual({ value: "parsed-value" });
  });

  it("should fall back to the raw Cookie header", async () => {
    const response = await request(appWithCookieRoutes())
      .get("/read")
      .set("Cookie", `other=1; ${SESSION_COOKIE_NAME}=header-value; tail=2`);

    expect(response.body).toEqual({ value: "header-value" });
  });

  it("should return null when the cookie is absent", async () => {
    const response = await request(appWithCookieRoutes()).get("/read");

    expect(response.body).toEqual({ value: null });
  });

  it("should set the host-scoped hardened attributes", async () => {
    const response = await request(appWithCookieRoutes()).get("/set");
    const header = setCookieHeader(response, SESSION_COOKIE_NAME);

    expect(response.status).toBe(204);
    expect(header).toContain(`${SESSION_COOKIE_NAME}=secret-value`);
    expect(header).toMatch(/;\s*HttpOnly/i);
    expect(header).toMatch(/;\s*Secure/i);
    expect(header).toMatch(/;\s*SameSite=Lax/i);
    expect(header).toMatch(/;\s*Path=\//i);
    expect(header).toMatch(/;\s*Max-Age=60/i);
    expect(header).not.toMatch(/;\s*Domain=/i);
  });

  it("should clear the cookie with max-age zero", async () => {
    const response = await request(appWithCookieRoutes()).get("/clear");
    const header = setCookieHeader(response, SESSION_COOKIE_NAME);

    expect(header.startsWith(`${SESSION_COOKIE_NAME}=;`)).toBe(true);
    expect(header).toMatch(/;\s*Max-Age=0/i);
    expect(header).toMatch(/;\s*HttpOnly/i);
    expect(header).toMatch(/;\s*Secure/i);
  });
});
