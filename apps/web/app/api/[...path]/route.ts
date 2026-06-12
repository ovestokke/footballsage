const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://localhost:8000";

const hopByHopHeaders = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function upstreamUrl(path: string[], request: Request) {
  const url = new URL(request.url);
  const upstream = new URL(path.join("/"), apiInternalUrl.endsWith("/") ? apiInternalUrl : `${apiInternalUrl}/`);
  upstream.search = url.search;
  return upstream;
}

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!hopByHopHeaders.has(key.toLowerCase())) headers.set(key, value);
  });

  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : Buffer.from(await request.arrayBuffer());

  try {
    const response = await fetch(upstreamUrl(path, request), {
      method,
      headers,
      body,
      cache: "no-store",
    });

    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (!hopByHopHeaders.has(key.toLowerCase())) responseHeaders.set(key, value);
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("API proxy failed", error);
    return Response.json({ detail: "API proxy failed" }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
