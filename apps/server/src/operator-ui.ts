import staticFiles from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join("; ");

export async function registerOperatorUi(server: FastifyInstance, input: { root: string }) {
  server.addHook("onSend", async (_request, reply) => {
    reply.header("content-security-policy", CONTENT_SECURITY_POLICY);
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
  });

  await server.register(staticFiles, {
    allowedPath: (pathName, _root, request) => {
      const isIndex = pathName.endsWith("/index.html") || pathName === "index.html";
      return !isIndex || request.url !== "/index.html";
    },
    immutable: true,
    maxAge: "1y",
    root: input.root,
  });

  const sendIndex = (reply: FastifyReply) =>
    reply
      .header("cache-control", "no-cache")
      .sendFile("index.html", { cacheControl: false, immutable: false, maxAge: 0 });

  server.get("/", async (_request, reply) => sendIndex(reply));
  server.setNotFoundHandler(async (request, reply) => {
    const acceptsHtml = request.headers.accept
      ?.split(",")
      .some((value) => value.trim().split(";", 1)[0] === "text/html");
    if (request.method === "GET" && acceptsHtml && !request.url.startsWith("/api/")) {
      return sendIndex(reply);
    }
    return reply.code(404).send({
      error: {
        code: "not_found",
        current_version: null,
        details: {},
        message: "The requested resource does not exist",
      },
    });
  });
}
