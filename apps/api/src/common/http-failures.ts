/**
 * The two ways an HTTP call to somebody else's server fails without producing
 * an HTTP status, and what to say about each.
 *
 * Both are the same defect wearing different clothes: `fetch` rejects with a
 * bare `TypeError` when the request never left, and `JSON.parse` throws a
 * `SyntaxError` when what came back is a web page. Neither is an
 * `HttpException`, so Nest's default filter reduces both to "Internal server
 * error" — and a user who is told that learns nothing about a VPN, a
 * certificate, or an SSO portal, which is what it always turns out to be.
 *
 * These live in `common/` rather than beside any one adapter because every
 * outbound integration has the same two failure modes: GitLab, GitHub, Jira
 * and the embeddings provider all talk to a host somebody else configured.
 */

/**
 * Why a request never reached the host, phrased for the person who configured
 * it. `fetch` reports every transport failure as `TypeError: fetch failed`
 * with the real reason on `cause.code`, and a self-managed or on-prem host is
 * where every one of these actually happens: behind a VPN, on an internal DNS
 * name, behind a certificate the machine does not trust.
 *
 * Returns null when the error is not a transport failure, so a caller can tell
 * "this is not mine to explain" from "here is the explanation".
 */
export function describeTransportFailure(err: unknown, host: string): string | null {
  if (!(err instanceof TypeError)) return null;

  const code = (err.cause as { code?: string } | undefined)?.code ?? '';
  const detail =
    {
      ENOTFOUND: `${host} does not resolve from the machine specd runs on. Check the hostname, and whether this machine needs to be on your VPN.`,
      EAI_AGAIN: `${host} could not be resolved right now — a DNS failure rather than a wrong name. Check the machine's network.`,
      ECONNREFUSED: `${host} refused the connection. The host resolves, so check the port and that the service is actually running there.`,
      ECONNRESET: `${host} closed the connection mid-request. Often a proxy or a load balancer in front of it.`,
      ETIMEDOUT: `${host} did not answer in time — typically a firewall or a VPN that is not connected.`,
      UND_ERR_CONNECT_TIMEOUT: `${host} did not answer in time — typically a firewall or a VPN that is not connected.`,
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: `${host} presented a certificate this machine does not trust. A host behind an internal CA needs that CA installed where specd runs (NODE_EXTRA_CA_CERTS).`,
      DEPTH_ZERO_SELF_SIGNED_CERT: `${host} presented a self-signed certificate. Install its CA where specd runs (NODE_EXTRA_CA_CERTS) rather than disabling verification.`,
      SELF_SIGNED_CERT_IN_CHAIN: `${host} presented a self-signed certificate in its chain. Install its CA where specd runs (NODE_EXTRA_CA_CERTS).`,
      CERT_HAS_EXPIRED: `${host} presented an expired certificate.`,
    }[code] ?? `${host} could not be reached (${code || err.message}).`;

  return `Could not reach ${host}. ${detail}`;
}

/**
 * A 2xx that is not JSON, explained.
 *
 * The status said yes and the body is a web page, which on a corporate host
 * has one overwhelmingly common cause: an SSO or access portal sitting in
 * front of the service, answering an API request with its login page at 200
 * rather than a 401. `JSON.parse` on that produces "Unexpected token '<',
 * \"<!DOCTYPE \"...", which names the symptom and nothing else.
 */
export function describeNonJsonBody(url: string, body: string): string {
  const head = body.trimStart().slice(0, 200).toLowerCase();
  const isHtml = head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml');

  if (!isHtml) {
    return (
      `${url} answered with something that is not JSON: ` +
      `"${body.trimStart().slice(0, 120).replace(/\s+/g, ' ')}". ` +
      'Check the URL points at the API root.'
    );
  }

  return (
    `${url} answered with an HTML page rather than JSON. ` +
    'That is usually an SSO or access portal in front of the service: it serves its own ' +
    'login page at 200, so the request never reached the API. specd talks to the API ' +
    'directly with a token, and cannot complete a browser sign-in — the service has to be ' +
    'reachable from this machine without one, or the token has to be accepted by whatever ' +
    'sits in front of it.'
  );
}

/**
 * `fetch`, with the transport failure already explained.
 *
 * Every outbound call in this codebase should go through this rather than
 * calling `fetch` directly, so the "request never left the machine" case
 * cannot reach a controller as a bare TypeError. `wrap` turns the explanation
 * into whichever typed error that integration uses.
 */
export async function fetchOrExplain(
  url: string,
  init: RequestInit,
  opts: { host: string; wrap: (message: string, cause: unknown) => Error },
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const explained = describeTransportFailure(err, opts.host);
    if (explained) throw opts.wrap(explained, err);
    throw err;
  }
}

/**
 * Read a response body as JSON, with the not-JSON case already explained.
 *
 * Deliberately takes the whole `Response` and handles 204 itself: an empty
 * body is not a broken body, and every caller that forgot that produced a
 * confident error message about a portal on a successful branch deletion.
 */
export async function readJsonOrExplain<T>(
  res: Response,
  opts: { url: string; wrap: (message: string, cause?: unknown) => Error },
): Promise<T> {
  if (res.status === 204) return undefined as T;

  const body = await res.text();
  if (!body) return undefined as T;

  try {
    return JSON.parse(body) as T;
  } catch (err) {
    throw opts.wrap(describeNonJsonBody(opts.url, body), err);
  }
}

/**
 * A URL somebody typed, in a shape `fetch` will accept.
 *
 * `gitlab.example.com` is what people type, and it is not a URL: WHATWG reads
 * the host as a *scheme*. Rather than refuse it, assume https — that is what
 * was meant every time, and a service on plain http is still reachable by
 * typing `http://` explicitly.
 *
 * The path is KEPT. A service can be served from a subpath (GitLab's relative
 * URL root, a reverse-proxied Jira), where the API really is under it.
 * Reducing this to the origin would be a convenience for someone pasting a
 * page URL bought by breaking every subpath-hosted instance, and only one of
 * those two is a deployment somebody chose.
 */
export function normalizeServiceUrl(
  raw: string,
  wrap: (message: string) => Error,
): string {
  const trimmed = raw.trim();
  if (!trimmed) throw wrap('No URL was given.');

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw wrap(
      `"${raw}" is not a URL specd can reach. Give the service's origin, e.g. ` +
        'https://example.com.',
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw wrap(
      `"${raw}" uses ${url.protocol.replace(':', '')}, and specd speaks only http and https. ` +
        "Give the service's origin, e.g. https://example.com.",
    );
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
