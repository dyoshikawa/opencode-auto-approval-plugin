export type Fetch = typeof globalThis.fetch;

/** The most of an error body read, to classify a refusal without buffering a large one. */
const MAX_ERROR_BODY_CHARS = 4_096;

export type PostResult = { ok: true; body: unknown } | { ok: false; status: number; text: string };

/**
 * One authenticated JSON POST, shared by the HTTP review backends. The
 * deadline covers the response body as well as the headers, a redirect is
 * refused so the bearer token never reaches another host, and errors stay
 * generic because network errors may echo the URL. A non-2xx answer is
 * returned, not thrown, so the caller can tell a refusal it can act on (an
 * oversized request) from any other failure.
 */
export async function postJSON(input: {
  fetch: Fetch;
  url: string;
  apiKey: string;
  body: unknown;
  timeoutMs: number;
  /** Names the service in error messages, e.g. "Decision model". */
  label: string;
}): Promise<PostResult> {
  const controller = new AbortController();
  // Racing the abort as well as passing the signal keeps the deadline even
  // when a fetch implementation does not honour the signal.
  const timedOut = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("Reviewer timed out.")));
  });
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    return await Promise.race([send({ ...input, signal: controller.signal }), timedOut]);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Reviewer timed out.", { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function send(input: {
  fetch: Fetch;
  url: string;
  apiKey: string;
  body: unknown;
  label: string;
  signal: AbortSignal;
}): Promise<PostResult> {
  let response: Response;
  try {
    response = await input.fetch(input.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.body),
      redirect: "error",
      signal: input.signal,
    });
  } catch (error) {
    throw new Error(`${input.label} request failed.`, { cause: error });
  }

  if (!response.ok) {
    return { ok: false, status: response.status, text: await readHead(response) };
  }
  try {
    return { ok: true, body: await response.json() };
  } catch (error) {
    throw new Error(`${input.label} response was not JSON.`, { cause: error });
  }
}

/** The start of an error body, read no further than needed. */
async function readHead(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < MAX_ERROR_BODY_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // An unreadable error body is classified like an empty one.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, MAX_ERROR_BODY_CHARS);
}
