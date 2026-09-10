/*
 * ============================================================
 * MY AI — CLOUDFLARE WORKER BACKEND
 * ============================================================
 *
 * Frontend:
 *   https://aabirgoon.github.io/my-ai/
 *
 * Worker:
 *   https://my-ai-backend.techaabir.workers.dev/
 *
 * Required Cloudflare bindings:
 *   AI           -> Workers AI
 *   MY_AI_DATA   -> KV Namespace
 *
 * Required Worker variable:
 *   SUPABASE_URL -> https://YOUR-PROJECT.supabase.co
 *
 * Main features:
 *   - Supabase JWT authentication
 *   - Workers AI
 *   - User-owned chats
 *   - KV persistence
 *   - Normal AI answers
 *   - Research mode
 *   - Wikipedia search
 *   - Crossref scholarly search
 *   - Source deduplication
 *   - URL verification
 *   - Relevance filtering
 *   - Claim-level evidence checking
 *   - Citation validation
 *   - CORS protection
 *   - Request validation
 *   - Error handling
 *   - Logging
 *
 * ============================================================
 */

const MODEL = "@cf/meta/llama-3.2-3b-instruct";

const FRONTEND_ORIGIN = "https://aabirgoon.github.io";

const CACHE_TTL = 86400; // 24 hours

const MAX_MESSAGES = 100;
const MAX_CHATS = 100;
const MAX_CHAT_SIZE = 1024 * 1024; // 1 MB
const MAX_PROMPT_LENGTH = 20000;
const MAX_REQUEST_SIZE = 256 * 1024; // 256 KB
const MAX_TITLE_LENGTH = 100;
const MAX_CHAT_ID_LENGTH = 100;

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

/*
 * ============================================================
 * GLOBAL JWT/JWKS CACHE
 * ============================================================
 */

let jwksCache = null;
let jwksCacheExpiry = 0;

/*
 * ============================================================
 * CORS
 * ============================================================
 */

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin");

  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };

  if (origin === FRONTEND_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = FRONTEND_ORIGIN;
  }

  return headers;
}

function json(data, status = 200, request = null) {
  const cors = request
    ? getCorsHeaders(request)
    : {
        "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      };

  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

/*
 * ============================================================
 * MAIN FETCH HANDLER
 * ============================================================
 */

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    console.log(
      `[${requestId}] ${method} ${path}`
    );

    try {
      /*
       * --------------------------------------------------------
       * CORS PREFLIGHT
       * --------------------------------------------------------
       */

      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: getCorsHeaders(request)
        });
      }

      /*
       * --------------------------------------------------------
       * BASIC REQUEST SIZE PROTECTION
       * --------------------------------------------------------
       */

      const contentLength = request.headers.get("Content-Length");

      if (
        contentLength &&
        Number.isFinite(Number(contentLength)) &&
        Number(contentLength) > MAX_REQUEST_SIZE
      ) {
        console.warn(
          `[${requestId}] Request too large`
        );

        return json(
          {
            success: false,
            error: "Request is too large."
          },
          413,
          request
        );
      }

      /*
       * --------------------------------------------------------
       * HEALTH / ROOT
       * --------------------------------------------------------
       */

      if (path === "/health") {
        if (method !== "GET") {
          return methodNotAllowed(request);
        }

        return json(
          {
            success: true,
            status: "ok",
            service: "my-ai-backend",
            model: MODEL,
            timestamp: new Date().toISOString()
          },
          200,
          request
        );
      }

      /*
       * Root:
       * GET  /
       * POST /
       */

      if (path === "/") {
        if (method === "GET") {
          return json(
            {
              success: true,
              status: "ok",
              service: "my-ai-backend"
            },
            200,
            request
          );
        }

        if (method === "POST") {
          const user = await verifyAuth(request, env);

          if (!user) {
            console.warn(
              `[${requestId}] Root POST authentication failed`
            );

            return json(
              {
                success: false,
                error: "Authentication required. Please log in."
              },
              401,
              request
            );
          }

          const bodyResult = await readJsonBody(request);

          if (!bodyResult.ok) {
            return json(
              {
                success: false,
                error: bodyResult.error
              },
              400,
              request
            );
          }

          const prompt = normalizePrompt(bodyResult.body?.prompt);

          if (!prompt) {
            return json(
              {
                success: false,
                error: "No prompt provided."
              },
              400,
              request
            );
          }

          if (prompt.length > MAX_PROMPT_LENGTH) {
            return json(
              {
                success: false,
                error: `Prompt is too long. Maximum length is ${MAX_PROMPT_LENGTH} characters.`
              },
              413,
              request
            );
          }

          console.log(
            `[${requestId}] Running root AI request for user ${user.id}`
          );

          const result = await runAI(env, prompt);

          console.log(
            `[${requestId}] Root AI completed in ${Date.now() - startedAt}ms`
          );

          return json(result, 200, request);
        }

        return methodNotAllowed(request);
      }

      /*
       * --------------------------------------------------------
       * POST /api/ask
       * --------------------------------------------------------
       */

      if (path === "/api/ask") {
        if (method !== "POST") {
          return methodNotAllowed(request);
        }

        console.log(
          `[${requestId}] /api/ask authentication starting`
        );

        const user = await verifyAuth(request, env);

        if (!user) {
          console.warn(
            `[${requestId}] /api/ask authentication failed`
          );

          return json(
            {
              success: false,
              error: "Authentication required. Please log in."
            },
            401,
            request
          );
        }

        console.log(
          `[${requestId}] /api/ask authenticated user=${user.id}`
        );

        const response = await handleAsk(
          request,
          env,
          user,
          requestId
        );

        console.log(
          `[${requestId}] /api/ask completed in ${Date.now() - startedAt}ms`
        );

        return response;
      }

      /*
       * --------------------------------------------------------
       * /api/chats
       * --------------------------------------------------------
       */

      if (path === "/api/chats") {
        if (method === "GET") {
          const user = await verifyAuth(request, env);

          if (!user) {
            return json(
              {
                success: false,
                error: "Authentication required. Please log in."
              },
              401,
              request
            );
          }

          return handleListChats(request, env, user);
        }

        if (method === "POST") {
          const user = await verifyAuth(request, env);

          if (!user) {
            return json(
              {
                success: false,
                error: "Authentication required. Please log in."
              },
              401,
              request
            );
          }

          return handleCreateChat(request, env, user);
        }

        return methodNotAllowed(request);
      }

      /*
       * --------------------------------------------------------
       * /api/chats/:id
       * --------------------------------------------------------
       */

      const chatMatch = path.match(/^\/api\/chats\/([^/]+)$/);

      if (chatMatch) {
        const chatId = decodeURIComponent(chatMatch[1]);

        if (!isValidChatId(chatId)) {
          return json(
            {
              success: false,
              error: "Invalid chat ID."
            },
            400,
            request
          );
        }

        const user = await verifyAuth(request, env);

        if (!user) {
          return json(
            {
              success: false,
              error: "Authentication required. Please log in."
            },
            401,
            request
          );
        }

        if (method === "GET") {
          return handleGetChat(request, env, user, chatId);
        }

        if (method === "DELETE") {
          return handleDeleteChat(request, env, user, chatId);
        }

        return methodNotAllowed(request);
      }

      /*
       * --------------------------------------------------------
       * UNKNOWN ROUTE
       * --------------------------------------------------------
       */

      return json(
        {
          success: false,
          error: "Not found."
        },
        404,
        request
      );
    } catch (error) {
      console.error(
        `[${requestId}] UNHANDLED ERROR`,
        error?.stack || error
      );

      return json(
        {
          success: false,
          error: "Something went wrong. Please try again."
        },
        500,
        request
      );
    }
  }
};

/*
 * ============================================================
 * HTTP HELPERS
 * ============================================================
 */

function methodNotAllowed(request) {
  return json(
    {
      success: false,
      error: "Method not allowed."
    },
    405,
    request
  );
}

async function readJsonBody(request) {
  try {
    const text = await request.text();

    if (!text) {
      return {
        ok: true,
        body: {}
      };
    }

    if (text.length > MAX_REQUEST_SIZE) {
      return {
        ok: false,
        error: "Request is too large."
      };
    }

    const body = JSON.parse(text);

    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body)
    ) {
      return {
        ok: false,
        error: "Invalid request body."
      };
    }

    return {
      ok: true,
      body
    };
  } catch (error) {
    console.warn("Invalid JSON body:", error);
    return {
      ok: false,
      error: "Invalid request."
    };
  }
}

function normalizePrompt(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function isValidChatId(chatId) {
  if (
    typeof chatId !== "string" ||
    !chatId ||
    chatId.length > MAX_CHAT_ID_LENGTH
  ) {
    return false;
  }

  /*
   * Chats created by this Worker use UUIDs.
   */

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    chatId
  );
}

/*
 * ============================================================
 * AUTHENTICATION
 * ============================================================
 */

function base64UrlDecode(str) {
  let value = String(str)
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  while (value.length % 4) {
    value += "=";
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function base64UrlToString(str) {
  try {
    return new TextDecoder().decode(
      base64UrlDecode(str)
    );
  } catch {
    return "";
  }
}

async function getSupabaseJWKS(supabaseUrl) {
  const now = Date.now();

  if (
    jwksCache &&
    now < jwksCacheExpiry
  ) {
    return jwksCache;
  }

  const base = String(supabaseUrl).replace(/\/+$/, "");

  const jwksUrl =
    base +
    "/auth/v1/.well-known/jwks.json";

  console.log("Refreshing Supabase JWKS");

  const response = await fetch(jwksUrl, {
    method: "GET",
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(
      `JWKS request failed: ${response.status}`
    );
  }

  const data = await response.json();

  if (
    !data ||
    !Array.isArray(data.keys) ||
    data.keys.length === 0
  ) {
    throw new Error("Invalid JWKS response.");
  }

  jwksCache = data;
  jwksCacheExpiry =
    now + JWKS_CACHE_TTL_MS;

  return data;
}

async function verifySupabaseJWT(
  token,
  supabaseUrl
) {
  if (
    typeof token !== "string" ||
    !token
  ) {
    return null;
  }

  const parts = token.split(".");

  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, encodedSignature] =
    parts;

  let header;
  let payload;

  try {
    header = JSON.parse(
      base64UrlToString(encodedHeader)
    );

    payload = JSON.parse(
      base64UrlToString(encodedPayload)
    );
  } catch {
    return null;
  }

  /*
   * JWT header checks
   */

  if (
    !header ||
    header.alg !== "RS256" ||
    !header.kid
  ) {
    return null;
  }

  /*
   * JWT payload checks
   */

  if (!payload) {
    return null;
  }

  if (
    !payload.exp ||
    Number(payload.exp) <
      Math.floor(Date.now() / 1000)
  ) {
    return null;
  }

  if (!payload.sub) {
    return null;
  }

  if (
    payload.role !== "authenticated"
  ) {
    return null;
  }

  /*
   * Get signing keys
   */

  let jwks;

  try {
    jwks = await getSupabaseJWKS(
      supabaseUrl
    );
  } catch (error) {
    console.error(
      "Could not retrieve JWKS:",
      error
    );

    return null;
  }

  /*
   * Find matching RSA signing key.
   *
   * Some valid JWKS documents omit "use",
   * so we accept either "sig" or no use field.
   */

  const jwk = jwks.keys.find(
    key =>
      key &&
      key.kid === header.kid &&
      key.kty === "RSA" &&
      (!key.use || key.use === "sig")
  );

  if (!jwk) {
    console.warn(
      "No matching JWT signing key found."
    );

    return null;
  }

  try {
    const cryptoKey =
      await crypto.subtle.importKey(
        "jwk",
        jwk,
        {
          name: "RSASSA-PKCS1-v1_5",
          hash: "SHA-256"
        },
        false,
        ["verify"]
      );

    const signingInput =
      `${encodedHeader}.${encodedPayload}`;

    const data =
      new TextEncoder().encode(
        signingInput
      );

    const signature =
      base64UrlDecode(
        encodedSignature
      );

    const valid =
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        cryptoKey,
        signature,
        data
      );

    if (!valid) {
      return null;
    }

    return payload;
  } catch (error) {
    console.error(
      "JWT verification error:",
      error
    );

    return null;
  }
}

async function verifyAuth(request, env) {
  const authorization =
    request.headers.get(
      "Authorization"
    );

  if (
    !authorization ||
    !authorization.startsWith(
      "Bearer "
    )
  ) {
    return null;
  }

  const token =
    authorization.substring(7).trim();

  if (
    !token ||
    !env.SUPABASE_URL
  ) {
    return null;
  }

  try {
    const payload =
      await verifySupabaseJWT(
        token,
        env.SUPABASE_URL
      );

    if (
      !payload ||
      !payload.sub
    ) {
      return null;
    }

    return {
      id: payload.sub,
      email: payload.email || ""
    };
  } catch (error) {
    console.error(
      "Authentication error:",
      error
    );

    return null;
  }
}

/*
 * ============================================================
 * CHAT SYSTEM
 * ============================================================
 */

function generateChatId() {
  return crypto.randomUUID();
}

function generateTitle(prompt) {
  let title = String(prompt)
    .trim()
    .replace(
      /^(please\s+)?(research|investigate|study|analyze|find evidence (for|about|on)|look into|explore)\s+/i,
      ""
    )
    .replace(/[.;,]+$/, "");

  const words = title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);

  if (!words.length) {
    return String(prompt)
      .trim()
      .substring(0, 60);
  }

  const stopWords = new Set([
    "a",
    "an",
    "the",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "is",
    "are",
    "was",
    "were"
  ]);

  const formatted =
    words.map((word, index) => {
      const cleaned =
        word
          .toLowerCase()
          .replace(/[^a-z']/g, "");

      if (
        index > 0 &&
        stopWords.has(cleaned)
      ) {
        return word.toLowerCase();
      }

      return (
        word.charAt(0).toUpperCase() +
        word.slice(1)
      );
    });

  title = formatted.join(" ");

  return (
    title.charAt(0).toUpperCase() +
    title.slice(1)
  ).substring(0, MAX_TITLE_LENGTH);
}

function createNewChat(
  userId,
  firstPrompt
) {
  const now = Date.now();

  return {
    id: generateChatId(),
    userId,
    title: generateTitle(
      firstPrompt
    ),
    createdAt: now,
    updatedAt: now,
    messages: []
  };
}

async function saveChat(
  env,
  userId,
  chat
) {
  if (!env.MY_AI_DATA) {
    throw new Error(
      "MY_AI_DATA binding is missing."
    );
  }

  if (
    !chat ||
    !chat.id ||
    !userId
  ) {
    throw new Error(
      "Invalid chat."
    );
  }

  if (
    !Array.isArray(chat.messages)
  ) {
    chat.messages = [];
  }

  if (
    chat.messages.length >
    MAX_MESSAGES
  ) {
    chat.messages =
      chat.messages.slice(
        -MAX_MESSAGES
      );
  }

  let serialized =
    JSON.stringify(chat);

  /*
   * Reduce old messages if the chat
   * becomes too large.
   */

  if (
    serialized.length >
    MAX_CHAT_SIZE
  ) {
    chat.messages =
      chat.messages.slice(-50);

    serialized =
      JSON.stringify(chat);
  }

  if (
    serialized.length >
    MAX_CHAT_SIZE
  ) {
    chat.messages =
      chat.messages.slice(-20);

    serialized =
      JSON.stringify(chat);
  }

  if (
    serialized.length >
    MAX_CHAT_SIZE
  ) {
    throw new Error(
      "Chat is too large to store."
    );
  }

  await env.MY_AI_DATA.put(
    `user:${userId}:chat:${chat.id}`,
    serialized
  );
}

async function updateChatList(
  env,
  userId,
  chat
) {
  if (!env.MY_AI_DATA) {
    throw new Error(
      "MY_AI_DATA binding is missing."
    );
  }

  const listKey =
    `user:${userId}:chats`;

  let list =
    await env.MY_AI_DATA.get(
      listKey,
      "json"
    );

  if (!Array.isArray(list)) {
    list = [];
  }

  const metadata = {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt
  };

  const index =
    list.findIndex(
      item => item.id === chat.id
    );

  if (index >= 0) {
    list[index] = metadata;
  } else {
    list.unshift(metadata);
  }

  list.sort(
    (a, b) =>
      Number(b.updatedAt || 0) -
      Number(a.updatedAt || 0)
  );

  if (
    list.length > MAX_CHATS
  ) {
    list =
      list.slice(0, MAX_CHATS);
  }

  await env.MY_AI_DATA.put(
    listKey,
    JSON.stringify(list)
  );
}

/*
 * ============================================================
 * ASK HANDLER
 * ============================================================
 */

async function handleAsk(
  request,
  env,
  user,
  requestId
) {
  if (!env.MY_AI_DATA) {
    console.error(
      `[${requestId}] MY_AI_DATA missing`
    );

    return json(
      {
        success: false,
        error: "Storage unavailable."
      },
      500,
      request
    );
  }

  const bodyResult =
    await readJsonBody(request);

  if (!bodyResult.ok) {
    return json(
      {
        success: false,
        error: bodyResult.error
      },
      400,
      request
    );
  }

  const body =
    bodyResult.body || {};

  const prompt =
    normalizePrompt(body.prompt);

  const chatId =
    body.chatId
      ? String(body.chatId)
      : null;

  if (!prompt) {
    return json(
      {
        success: false,
        error: "No prompt provided."
      },
      400,
      request
    );
  }

  if (
    prompt.length >
    MAX_PROMPT_LENGTH
  ) {
    return json(
      {
        success: false,
        error: `Prompt is too long. Maximum length is ${MAX_PROMPT_LENGTH} characters.`
      },
      413,
      request
    );
  }

  if (
    chatId &&
    !isValidChatId(chatId)
  ) {
    return json(
      {
        success: false,
        error: "Invalid chat ID."
      },
      400,
      request
    );
  }

  console.log(
    `[${requestId}] Prompt received. length=${prompt.length}`
  );

  let chat;
  let isNewChat = false;

  /*
   * Existing chat
   */

  if (chatId) {
    const key =
      `user:${user.id}:chat:${chatId}`;

    chat =
      await env.MY_AI_DATA.get(
        key,
        "json"
      );

    if (!chat) {
      return json(
        {
          success: false,
          error: "Chat not found."
        },
        404,
        request
      );
    }

    if (
      chat.userId !== user.id
    ) {
      console.warn(
        `[${requestId}] Chat ownership mismatch`
      );

      return json(
        {
          success: false,
          error: "Access denied."
        },
        403,
        request
      );
    }
  } else {
    /*
     * New chat
     */

    chat =
      createNewChat(
        user.id,
        prompt
      );

    isNewChat = true;
  }

  if (
    !Array.isArray(chat.messages)
  ) {
    chat.messages = [];
  }

  chat.messages.push({
    role: "user",
    content: prompt,
    timestamp: Date.now()
  });

  /*
   * Run AI
   */

  let aiResult;

  try {
    console.log(
      `[${requestId}] AI processing started`
    );

    aiResult =
      await runAI(
        env,
        prompt
      );

    console.log(
      `[${requestId}] AI processing completed`
    );
  } catch (error) {
    console.error(
      `[${requestId}] AI PROCESSING ERROR`,
      error?.stack || error
    );

    /*
     * Save an error message if possible.
     */

    try {
      chat.messages.push({
        role: "assistant",
        content:
          "Sorry, I couldn't generate a response. Please try again.",
        timestamp: Date.now(),
        type: "error"
      });

      chat.updatedAt =
        Date.now();

      await saveChat(
        env,
        user.id,
        chat
      );

      if (isNewChat) {
        await updateChatList(
          env,
          user.id,
          chat
        );
      }
    } catch (storageError) {
      console.error(
        `[${requestId}] Could not save AI error chat`,
        storageError
      );
    }

    return json(
      {
        success: false,
        error:
          "The AI service could not generate a response."
      },
      502,
      request
    );
  }

  /*
   * Make sure the AI returned
   * something usable.
   */

  const responseText =
    aiResult?.result?.response;

  if (
    typeof responseText !== "string" ||
    !responseText.trim()
  ) {
    console.error(
      `[${requestId}] AI returned empty response`
    );

    return json(
      {
        success: false,
        error:
          "The AI returned an empty response."
      },
      502,
      request
    );
  }

  /*
   * Store assistant response.
   */

  chat.messages.push({
    role: "assistant",
    content: responseText,
    timestamp: Date.now(),
    type:
      aiResult.type || "normal",
    sources:
      aiResult.sources || null
  });

  chat.updatedAt =
    Date.now();

  try {
    await saveChat(
      env,
      user.id,
      chat
    );

    await updateChatList(
      env,
      user.id,
      chat
    );
  } catch (error) {
    console.error(
      `[${requestId}] Chat storage error`,
      error
    );

    return json(
      {
        success: false,
        error:
          "The response was generated, but could not be saved."
      },
      500,
      request
    );
  }

  return json(
    {
      ...aiResult,
      chatId: chat.id,
      chatTitle: chat.title
    },
    200,
    request
  );
}

/*
 * ============================================================
 * CHAT CRUD
 * ============================================================
 */

async function handleListChats(
  request,
  env,
  user
) {
  if (!env.MY_AI_DATA) {
    return json(
      {
        success: false,
        error: "Storage unavailable."
      },
      500,
      request
    );
  }

  let chats;

  try {
    chats =
      await env.MY_AI_DATA.get(
        `user:${user.id}:chats`,
        "json"
      );
  } catch (error) {
    console.error(
      "List chats error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Could not load chats."
      },
      500,
      request
    );
  }

  if (!Array.isArray(chats)) {
    chats = [];
  }

  return json(
    {
      success: true,
      chats
    },
    200,
    request
  );
}

async function handleCreateChat(
  request,
  env,
  user
) {
  if (!env.MY_AI_DATA) {
    return json(
      {
        success: false,
        error: "Storage unavailable."
      },
      500,
      request
    );
  }

  const bodyResult =
    await readJsonBody(request);

  if (!bodyResult.ok) {
    return json(
      {
        success: false,
        error: bodyResult.error
      },
      400,
      request
    );
  }

  const body =
    bodyResult.body || {};

  let title =
    typeof body.title === "string"
      ? body.title.trim()
      : "New Chat";

  if (!title) {
    title = "New Chat";
  }

  title =
    title.substring(
      0,
      MAX_TITLE_LENGTH
    );

  const now = Date.now();

  const chat = {
    id: generateChatId(),
    userId: user.id,
    title,
    createdAt: now,
    updatedAt: now,
    messages: []
  };

  try {
    await saveChat(
      env,
      user.id,
      chat
    );

    await updateChatList(
      env,
      user.id,
      chat
    );
  } catch (error) {
    console.error(
      "Create chat error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Could not create chat."
      },
      500,
      request
    );
  }

  return json(
    {
      success: true,
      chat
    },
    200,
    request
  );
}

async function handleGetChat(
  request,
  env,
  user,
  chatId
) {
  if (!env.MY_AI_DATA) {
    return json(
      {
        success: false,
        error: "Storage unavailable."
      },
      500,
      request
    );
  }

  const key =
    `user:${user.id}:chat:${chatId}`;

  let chat;

  try {
    chat =
      await env.MY_AI_DATA.get(
        key,
        "json"
      );
  } catch (error) {
    console.error(
      "Get chat error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Could not load chat."
      },
      500,
      request
    );
  }

  if (!chat) {
    return json(
      {
        success: false,
        error: "Chat not found."
      },
      404,
      request
    );
  }

  if (
    chat.userId !== user.id
  ) {
    return json(
      {
        success: false,
        error: "Access denied."
      },
      403,
      request
    );
  }

  return json(
    {
      success: true,
      chat
    },
    200,
    request
  );
}

async function handleDeleteChat(
  request,
  env,
  user,
  chatId
) {
  if (!env.MY_AI_DATA) {
    return json(
      {
        success: false,
        error: "Storage unavailable."
      },
      500,
      request
    );
  }

  const chatKey =
    `user:${user.id}:chat:${chatId}`;

  let chat;

  try {
    chat =
      await env.MY_AI_DATA.get(
        chatKey,
        "json"
      );
  } catch (error) {
    console.error(
      "Delete chat lookup error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Could not access chat."
      },
      500,
      request
    );
  }

  if (!chat) {
    return json(
      {
        success: false,
        error: "Chat not found."
      },
      404,
      request
    );
  }

  if (
    chat.userId !== user.id
  ) {
    return json(
      {
        success: false,
        error: "Access denied."
      },
      403,
      request
    );
  }

  try {
    await env.MY_AI_DATA.delete(
      chatKey
    );

    const listKey =
      `user:${user.id}:chats`;

    let list =
      await env.MY_AI_DATA.get(
        listKey,
        "json"
      );

    if (Array.isArray(list)) {
      list =
        list.filter(
          item =>
            item.id !== chatId
        );

      await env.MY_AI_DATA.put(
        listKey,
        JSON.stringify(list)
      );
    }
  } catch (error) {
    console.error(
      "Delete chat error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Could not delete chat."
      },
      500,
      request
    );
  }

  return json(
    {
      success: true
    },
    200,
    request
  );
}

/*
 * ============================================================
 * AI ROUTER
 * ============================================================
 */

async function runAI(
  env,
  prompt
) {
  const intent =
    await understandIntent(
      env,
      prompt
    );

  const safeIntent = {
    category:
      intent?.category ||
      "NORMAL",

    goal:
      intent?.goal ||
      prompt,

    needs_research:
      Boolean(
        intent?.needs_research
      ),

    needs_clarification:
      Boolean(
        intent?.needs_clarification
      ),

    clarification_question:
      intent?.clarification_question ||
      ""
  };

  /*
   * Explicit research wording
   * overrides an accidental
   * non-research classification.
   */

  if (
    (
      safeIntent.category ===
      "COMPARISON"
    ) &&
    !safeIntent.needs_research
  ) {
    if (
      promptAsksForResearch(
        prompt
      )
    ) {
      safeIntent.needs_research =
        true;
    }
  }

  if (
    promptAsksForResearch(
      prompt
    )
  ) {
    safeIntent.needs_research =
      true;
  }

  /*
   * Clarification
   */

  if (
    safeIntent.needs_clarification &&
    safeIntent.clarification_question
  ) {
    return {
      success: true,
      type: "clarification",
      intent: safeIntent,
      researched: false,
      result: {
        response:
          safeIntent.clarification_question
      }
    };
  }

  /*
   * Research
   */

  if (
    safeIntent.category ===
      "DEEP_RESEARCH" ||
    safeIntent.needs_research === true
  ) {
    const research =
      await performResearch(
        env,
        prompt,
        safeIntent.goal
      );

    const answer =
      await synthesizeResearch(
        env,
        prompt,
        safeIntent.goal,
        research.sources,
        research.requirements
      );

    return {
      success: true,
      type: "research",
      researched: true,
      intent: safeIntent,
      sources:
        research.sources,
      result: {
        response: answer
      }
    };
  }

  /*
   * Normal AI
   */

  const answer =
    await generateNormalAnswer(
      env,
      prompt,
      safeIntent
    );

  return {
    success: true,
    type: "normal",
    researched: false,
    intent: safeIntent,
    result: {
      response: answer
    }
  };
}

/*
 * ============================================================
 * RESEARCH DETECTION
 * ============================================================
 */

function promptAsksForResearch(
  prompt
) {
  const lower =
    String(prompt)
      .toLowerCase();

  const keywords = [
    "research",
    "investigate",
    "evidence",
    "studies",
    "sources",
    "find evidence",
    "scientific evidence",
    "compare the evidence",
    "analyze the evidence",
    "peer reviewed",
    "peer-reviewed",
    "meta-analysis",
    "systematic review",
    "researchers agree",
    "researchers disagree",
    "scientific consensus",

    "গবেষণা",
    "প্রমাণ",
    "সাক্ষ্য",
    "অধ্যয়ন",
    "বৈজ্ঞানিক",
    "গবেষণাভিত্তিক",

    "शोध",
    "अनुसंधान",
    "साक्ष्य",
    "वैज्ञानिक",
    "अध्ययन",

    "investigar",
    "evidencia",
    "estudios",
    "fuentes",

    "rechercher",
    "preuves",
    "études",
    "sources scientifiques",
    "recherche",

    "untersuchen",
    "beweise",
    "studien",
    "quellen",

    "pesquisar",
    "evidência",
    "estudos",
    "fontes"
  ];

  return keywords.some(
    keyword =>
      lower.includes(keyword)
  );
}

/*
 * ============================================================
 * INTENT UNDERSTANDING
 * ============================================================
 */

async function understandIntent(
  env,
  prompt
) {
  const system = `
You are the intent-understanding layer of My AI.

Analyze the user's request and return ONLY valid JSON.

Allowed category values:

NORMAL
WRITING
PLANNING
COMPARISON
DEEP_RESEARCH
OTHER

Use DEEP_RESEARCH when the user explicitly asks to:
- research
- investigate
- find evidence
- analyze a topic deeply
- explain something requiring current or multiple sources
- compare evidence from sources
- find scientific or historical evidence
- conduct a detailed research task

Use NORMAL for ordinary questions that do not need external research.

Use WRITING for:
- stories
- scripts
- essays
- rewriting
- editing
- creative writing
- copywriting

Use PLANNING for:
- plans
- schedules
- roadmaps
- strategies

Use COMPARISON when the primary goal is comparing multiple things.

Only set needs_clarification to true when a missing piece of information is genuinely necessary.

Do not ask unnecessary questions.

Return exactly this JSON structure:

{
  "category": "NORMAL",
  "goal": "short description of the user's actual goal",
  "needs_research": false,
  "needs_clarification": false,
  "clarification_question": ""
}

Do not include markdown.
Do not include explanations outside JSON.
`;

  const result =
    await aiRun(
      env,
      [
        {
          role: "system",
          content: system
        },
        {
          role: "user",
          content: prompt
        }
      ],
      {
        max_tokens: 500,
        temperature: 0.2
      }
    );

  const text =
    extractAIText(result);

  try {
    const parsed =
      JSON.parse(
        cleanJSONResponse(text)
      );

    return parsed;
  } catch {
    return {
      category: "NORMAL",
      goal: prompt,
      needs_research: false,
      needs_clarification: false,
      clarification_question: ""
    };
  }
}

/*
 * ============================================================
 * RESEARCH REQUIREMENTS
 * ============================================================
 */

async function analyzeResearchRequirements(
  env,
  prompt,
  goal
) {
  const system = `
You are the research requirement analysis layer of My AI.

Analyze the user's research request and determine what kind of evidence is needed.

Return ONLY valid JSON:

{
  "core_question": "",
  "evidence_type": "scientific|historical|technical|statistical|political|economic|general",
  "requires_comparison": false,
  "comparison_sides": [],
  "claims_needing_evidence": [],
  "strong_evidence_would_be": "",
  "moderate_evidence_would_be": "",
  "weak_evidence_would_be": "",
  "insufficient_evidence_would_be": ""
}

Rules:
- Be specific.
- If competing explanations must be compared, set requires_comparison to true.
- Do not include text outside JSON.
`;

  const result =
    await aiRun(
      env,
      [
        {
          role: "system",
          content: system
        },
        {
          role: "user",
          content:
            `User request: ${prompt}\nActual goal: ${goal}`
        }
      ],
      {
        max_tokens: 800,
        temperature: 0.2
      }
    );

  const text =
    extractAIText(result);

  try {
    const p =
      JSON.parse(
        cleanJSONResponse(text)
      );

    return {
      core_question:
        p.core_question ||
        prompt,

      evidence_type:
        p.evidence_type ||
        "general",

      requires_comparison:
        Boolean(
          p.requires_comparison
        ),

      comparison_sides:
        Array.isArray(
          p.comparison_sides
        )
          ? p.comparison_sides
          : [],

      claims_needing_evidence:
        Array.isArray(
          p.claims_needing_evidence
        )
          ? p.claims_needing_evidence
          : [],

      strong_evidence_would_be:
        p.strong_evidence_would_be ||
        "",

      moderate_evidence_would_be:
        p.moderate_evidence_would_be ||
        "",

      weak_evidence_would_be:
        p.weak_evidence_would_be ||
        "",

      insufficient_evidence_would_be:
        p.insufficient_evidence_would_be ||
        ""
    };
  } catch {
    return {
      core_question: prompt,
      evidence_type: "general",
      requires_comparison: false,
      comparison_sides: [],
      claims_needing_evidence: [],
      strong_evidence_would_be: "",
      moderate_evidence_would_be: "",
      weak_evidence_would_be: "",
      insufficient_evidence_would_be: ""
    };
  }
}

/*
 * ============================================================
 * RESEARCH QUERY GENERATION
 * ============================================================
 */

async function createResearchQueries(
  env,
  prompt,
  goal,
  requirements
) {
  const reqContext =
    requirements?.core_question
      ? `
Research requirements:
- Core question: ${requirements.core_question}
- Evidence type: ${requirements.evidence_type}
- Requires comparison: ${requirements.requires_comparison}
- Comparison sides: ${(requirements.comparison_sides || []).join(", ")}
- Claims needing evidence: ${(requirements.claims_needing_evidence || []).join("; ")}
`
      : "";

  const system = `
You are a research planner for a serious research engine.

Create precise search queries for the user's research request.

Return ONLY valid JSON:

{
  "wikipedia": [
    "query 1",
    "query 2",
    "query 3"
  ],
  "crossref": [
    "query 1",
    "query 2",
    "query 3"
  ]
}

Rules:
- Maximum 3 queries per source.
- Each query should target a different aspect.
- Wikipedia queries should target useful background.
- Crossref queries should target scholarly literature.
- If comparison is required, target each side.
- Do not invent papers, authors, DOIs or sources.
- Keep queries short and specific.
- Do not merely repeat the user's prompt.
${reqContext}
`;

  const result =
    await aiRun(
      env,
      [
        {
          role: "system",
          content: system
        },
        {
          role: "user",
          content:
            `User request: ${prompt}\nActual goal: ${goal}`
        }
      ],
      {
        max_tokens: 600,
        temperature: 0.3
      }
    );

  const text =
    extractAIText(result);

  try {
    const p =
      JSON.parse(
        cleanJSONResponse(text)
      );

    return {
      wikipedia:
        Array.isArray(p.wikipedia) &&
        p.wikipedia.length
          ? p.wikipedia
          : [prompt],

      crossref:
        Array.isArray(p.crossref) &&
        p.crossref.length
          ? p.crossref
          : [prompt]
    };
  } catch {
    return {
      wikipedia: [prompt],
      crossref: [prompt]
    };
  }
}

/*
 * ============================================================
 * RESEARCH ENGINE
 * ============================================================
 */

async function performResearch(
  env,
  prompt,
  goal
) {
  const requirements =
    await analyzeResearchRequirements(
      env,
      prompt,
      goal
    );

  const queries =
    await createResearchQueries(
      env,
      prompt,
      goal,
      requirements
    );

  const rawSources = [];

  /*
   * Wikipedia
   */

  for (
    const query of
    queries.wikipedia.slice(0, 3)
  ) {
    try {
      const results =
        await wikipediaSearch(
          env,
          query
        );

      for (
        const source of results
      ) {
        rawSources.push(source);
      }
    } catch (error) {
      console.error(
        "Wikipedia search error:",
        error
      );
    }
  }

  /*
   * Crossref
   */

  for (
    const query of
    queries.crossref.slice(0, 3)
  ) {
    try {
      const results =
        await crossrefSearch(
          env,
          query
        );

      for (
        const source of results
      ) {
        rawSources.push(source);
      }
    } catch (error) {
      console.error(
        "Crossref search error:",
        error
      );
    }
  }

  /*
   * Deduplicate
   */

  const deduped =
    deduplicateSources(
      rawSources
    );

  /*
   * Validate URLs
   */

  const validated =
    await validateSourceUrls(
      deduped
    );

  /*
   * Extract evidence
   */

  const withEvidence =
    extractEvidence(
      validated
    );

  /*
   * Relevance classification
   */

  const withRelevance =
    await filterSourceRelevance(
      env,
      prompt,
      goal,
      requirements,
      withEvidence
    );

  const relevantSources =
    withRelevance.filter(
      source =>
        source.relevance ===
          "DIRECTLY_RELEVANT" ||
        source.relevance ===
          "PARTIALLY_RELEVANT"
    );

  /*
   * Ranking
   */

  const ranked =
    rankSources(
      relevantSources
    );

  /*
   * Diversity
   */

  const diverse =
    ensureSourceDiversity(
      ranked
    );

  return {
    sources:
      diverse.slice(0, 10),
    requirements
  };
}

/*
 * ============================================================
 * WIKIPEDIA SEARCH
 * ============================================================
 */

async function wikipediaSearch(
  env,
  query
) {
  const normalized =
    String(query)
      .toLowerCase()
      .trim();

  const cacheKey =
    "wiki:v5:" +
    await hashString(
      normalized
    );

  const cached =
    await getCache(
      env,
      cacheKey
    );

  if (cached) {
    return cached;
  }

  const url =
    "https://en.wikipedia.org/w/rest.php/v1/search/page?q=" +
    encodeURIComponent(query) +
    "&limit=5";

  const response =
    await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "MyAIResearchBot/2.0"
      }
    });

  if (!response.ok) {
    throw new Error(
      `Wikimedia search failed: ${response.status}`
    );
  }

  const data =
    await response.json();

  const results = [];

  for (
    const page of
    data.pages || []
  ) {
    const title =
      page.title || "";

    const key =
      page.key || title;

    if (!title) {
      continue;
    }

    results.push({
      source_type:
        "Wikimedia",

      title,

      description:
        page.description || "",

      excerpt:
        page.excerpt || "",

      url:
        "https://en.wikipedia.org/wiki/" +
        encodeURIComponent(
          key.replace(
            / /g,
            "_"
          )
        ),

      doi: "",
      authors: [],
      year: null,
      journal: "",
      abstract: "",
      type: "encyclopedia"
    });
  }

  await putCache(
    env,
    cacheKey,
    results
  );

  return results;
}

/*
 * ============================================================
 * CROSSREF SEARCH
 * ============================================================
 */

async function crossrefSearch(
  env,
  query
) {
  const normalized =
    String(query)
      .toLowerCase()
      .trim();

  const cacheKey =
    "crossref:v5:" +
    await hashString(
      normalized
    );

  const cached =
    await getCache(
      env,
      cacheKey
    );

  if (cached) {
    return cached;
  }

  const url =
    "https://api.crossref.org/works?query.bibliographic=" +
    encodeURIComponent(query) +
    "&rows=5&select=DOI,title,author,published,container-title,abstract,URL,type";

  const response =
    await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "MyAIResearchBot/2.0",
        "Accept":
          "application/json"
      }
    });

  if (!response.ok) {
    throw new Error(
      `Crossref search failed: ${response.status}`
    );
  }

  const data =
    await response.json();

  const results = [];

  const items =
    data?.message?.items || [];

  for (
    const item of items
  ) {
    const title =
      Array.isArray(
        item.title
      ) &&
      item.title.length
        ? item.title[0]
        : "";

    if (!title) {
      continue;
    }

    const authors =
      Array.isArray(
        item.author
      )
        ? item.author
            .slice(0, 6)
            .map(author =>
              [
                author.given,
                author.family
              ]
                .filter(Boolean)
                .join(" ")
            )
            .filter(Boolean)
        : [];

    const published =
      item.published?.[
        "date-parts"
      ]?.[0] || [];

    const year =
      published.length
        ? published[0]
        : null;

    const doi =
      item.DOI || "";

    const sourceUrl =
      item.URL ||
      (
        doi
          ? `https://doi.org/${doi}`
          : ""
      );

    results.push({
      source_type:
        "Crossref",

      title,

      authors,

      year,

      journal:
        Array.isArray(
          item["container-title"]
        ) &&
        item["container-title"].length
          ? item["container-title"][0]
          : "",

      abstract:
        cleanAbstract(
          item.abstract || ""
        ),

      doi,

      url: sourceUrl,

      type:
        item.type || ""
    });
  }

  await putCache(
    env,
    cacheKey,
    results
  );

  return results;
}

/*
 * ============================================================
 * SOURCE DEDUPLICATION
 * ============================================================
 */

function deduplicateSources(
  sources
) {
  const seen =
    new Set();

  const result = [];

  for (
    const source of
    sources
  ) {
    const key =
      source.doi
        ? "doi:" +
          source.doi
            .toLowerCase()
            .trim()
        : source.url
        ? "url:" +
          source.url
            .toLowerCase()
            .trim()
        : "title:" +
          String(
            source.title || ""
          )
            .toLowerCase()
            .trim();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(source);
  }

  return result;
}

/*
 * ============================================================
 * SOURCE URL VALIDATION
 * ============================================================
 */

async function validateSourceUrls(
  sources
) {
  const validated = [];

  for (
    const source of
    sources
  ) {
    const copy = {
      ...source
    };

    if (!source.url) {
      copy.url_verified = false;
      copy.url_status =
        "missing";

      validated.push(copy);
      continue;
    }

    try {
      let response =
        await fetch(
          source.url,
          {
            method: "HEAD",
            redirect: "follow",
            headers: {
              "User-Agent":
                "MyAIResearchBot/2.0"
            }
          }
        );

      /*
       * Some websites reject HEAD.
       * Fall back to GET.
       */

      if (
        response.status === 405 ||
        response.status === 403
      ) {
        response =
          await fetch(
            source.url,
            {
              method: "GET",
              redirect: "follow",
              headers: {
                "User-Agent":
                  "MyAIResearchBot/2.0"
              }
            }
          );
      }

      if (
        response.status >= 200 &&
        response.status < 400
      ) {
        copy.url_verified =
          true;

        copy.url_status =
          String(
            response.status
          );
      } else {
        copy.url_verified =
          false;

        copy.url_status =
          "http_" +
          response.status;
      }
    } catch {
      copy.url_verified =
        false;

      copy.url_status =
        "unreachable";
    }

    validated.push(copy);
  }

  return validated;
}

/*
 * ============================================================
 * EVIDENCE EXTRACTION
 * ============================================================
 */

function extractEvidence(
  sources
) {
  return sources.map(
    (source, index) => {
      const evidence = {
        source_id:
          index + 1,

        source_type:
          source.source_type,

        title:
          source.title,

        url:
          source.url,

        url_verified:
          source.url_verified !==
          false,

        url_status:
          source.url_status ||
          "unknown",

        authors:
          Array.isArray(
            source.authors
          ) &&
          source.authors.length
            ? source.authors
            : [],

        year:
          source.year ||
          null,

        doi:
          source.doi ||
          "",

        journal:
          source.journal ||
          "",

        type:
          source.type ||
          "",

        evidence_text:
          "",

        evidence_strength:
          "weak",

        limitations: []
      };

      const parts = [];

      if (
        source.source_type ===
        "Wikimedia"
      ) {
        if (
          source.description
        ) {
          parts.push(
            source.description
          );
        }

        if (
          source.excerpt
        ) {
          parts.push(
            source.excerpt
          );
        }

        evidence.evidence_text =
          parts.join(
            "\n\n"
          ).trim();

        evidence.evidence_strength =
          evidence
            .evidence_text
            .length > 0
            ? "moderate"
            : "weak";

        if (
          !evidence.evidence_text
        ) {
          evidence.limitations.push(
            "No excerpt or description was available from the API."
          );
        }

        evidence.limitations.push(
          "Wikipedia is a general reference, not a primary or peer-reviewed source."
        );
      } else if (
        source.source_type ===
        "Crossref"
      ) {
        if (
          source.abstract
        ) {
          parts.push(
            source.abstract
          );
        }

        evidence.evidence_text =
          parts.join(
            "\n\n"
          ).trim();

        evidence.evidence_strength =
          source.abstract &&
          source.abstract.length >
            50
            ? "moderate"
            : "weak";

        if (
          !source.abstract ||
          source.abstract.length <=
            50
        ) {
          evidence.limitations.push(
            "No abstract available — this is scholarly metadata only, not full-text evidence."
          );
        }

        const type =
          source.type || "";

        if (
          type ===
            "journal-article" ||
          type ===
            "proceedings-article"
        ) {
          evidence.publication_status =
            "published_scholarly";
        } else if (
          type ===
            "posted-content" ||
          type ===
            "preprint"
        ) {
          evidence.publication_status =
            "preprint";

          evidence.limitations.push(
            "This appears to be a preprint or posted content, not necessarily peer-reviewed."
          );
        } else if (
          type === "report" ||
          type ===
            "report-component"
        ) {
          evidence.publication_status =
            "report";

          evidence.limitations.push(
            "This is a report, not a peer-reviewed journal article."
          );
        } else if (
          type === "book" ||
          type ===
            "book-chapter" ||
          type === "monograph"
        ) {
          evidence.publication_status =
            "book";

          evidence.limitations.push(
            "This is a book or book chapter, not a peer-reviewed journal article."
          );
        } else {
          evidence.publication_status =
            "unclear";

          evidence.limitations.push(
            "Publication status is unclear from the retrieved metadata."
          );
        }

        if (
          !evidence.url_verified
        ) {
          evidence.limitations.push(
            "The source URL could not be verified as reachable."
          );
        }
      }

      return {
        ...source,
        evidence
      };
    }
  );
}

/*
 * ============================================================
 * SOURCE RELEVANCE FILTER
 * ============================================================
 */

async function filterSourceRelevance(
  env,
  prompt,
  goal,
  requirements,
  sources
) {
  if (!sources.length) {
    return sources;
  }

  const coreQuestion =
    requirements?.core_question ||
    prompt;

  const sourceDescriptions =
    sources
      .map(
        (source, index) => {
          const evidence =
            source.evidence ||
            {};

          const parts = [
            `[${index + 1}]`,
            `Type: ${source.source_type}`,
            `Title: ${source.title}`,
            `Evidence text: ${(evidence.evidence_text || "").substring(0, 500)}`
          ];

          if (
            source.journal
          ) {
            parts.push(
              `Journal: ${source.journal}`
            );
          }

          if (
            Array.isArray(
              evidence.authors
            ) &&
            evidence.authors.length
          ) {
            parts.push(
              `Authors: ${evidence.authors.join(", ")}`
            );
          }

          if (
            evidence.evidence_strength
          ) {
            parts.push(
              `Evidence strength: ${evidence.evidence_strength}`
            );
          }

          return parts.join(
            " | "
          );
        }
      )
      .join("\n");

  const system = `
You are the source relevance filtering layer of My AI.

Determine whether each retrieved source actually addresses the user's specific research question.

CRITICAL RULES:

- Same topic does not automatically mean relevant.
- The evidence text must actually address the specific question.
- Metadata-only Crossref records should be treated cautiously.
- Do not invent information.

Classify each source as:

DIRECTLY_RELEVANT
PARTIALLY_RELEVANT
BACKGROUND_ONLY
IRRELEVANT

Return ONLY valid JSON:

{
  "classifications": [
    {
      "source_id": 1,
      "relevance": "DIRECTLY_RELEVANT",
      "reason": "Brief explanation"
    }
  ]
}

Do not include text outside JSON.
`;

  const userMessage = `
USER RESEARCH QUESTION:
${coreQuestion}

RESEARCH GOAL:
${goal}

EVIDENCE TYPE:
${requirements?.evidence_type || "general"}

SOURCES:
${sourceDescriptions}

Classify every source.
Return ONLY JSON.
`;

  const result =
    await aiRun(
      env,
      [
        {
          role: "system",
          content: system
        },
        {
          role: "user",
          content: userMessage
        }
      ],
      {
        max_tokens: 1500,
        temperature: 0.2
      }
    );

  const text =
    extractAIText(result);

  let classifications = [];

  try {
    const parsed =
      JSON.parse(
        cleanJSONResponse(text)
      );

    if (
      Array.isArray(
        parsed.classifications
      )
    ) {
      classifications =
        parsed.classifications;
    }
  } catch {
    return sources.map(
      source => ({
        ...source,
        relevance:
          "PARTIALLY_RELEVANT",
        relevance_reason:
          "Relevance classification failed — source retained cautiously."
      })
    );
  }

  const map =
    new Map();

  for (
    const classification of
    classifications
  ) {
    if (
      classification &&
      classification.source_id &&
      classification.relevance
    ) {
      map.set(
        Number(
          classification.source_id
        ),
        {
          relevance:
            classification.relevance,
          reason:
            classification.reason ||
            ""
        }
      );
    }
  }

  return sources.map(
    (source, index) => {
      const classification =
        map.get(index + 1);

      if (classification) {
        return {
          ...source,
          relevance:
            classification.relevance,
          relevance_reason:
            classification.reason
        };
      }

      return {
        ...source,
        relevance:
          "PARTIALLY_RELEVANT",
        relevance_reason:
          "Not classified — retained cautiously."
      };
    }
  );
}

/*
 * ============================================================
 * SOURCE RANKING
 * ============================================================
 */

function rankSources(
  sources
) {
  function qualityScore(
    source
  ) {
    let score = 0;

    if (
      source.source_type ===
      "Crossref"
    ) {
      score += 50;

      if (
        source.abstract &&
        source.abstract.length >
          50
      ) {
        score += 30;
      }

      if (
        source.type ===
        "journal-article"
      ) {
        score += 20;
      }

      if (
        source.doi
      ) {
        score += 10;
      }

      if (
        source.year
      ) {
        score += 5;
      }
    } else if (
      source.source_type ===
      "Wikimedia"
    ) {
      score += 20;

      if (
        source.excerpt &&
        source.excerpt.length >
          50
      ) {
        score += 10;
      }
    }

    if (
      source.url_verified !==
      false
    ) {
      score += 15;
    }

    if (
      source.relevance ===
      "DIRECTLY_RELEVANT"
    ) {
      score += 25;
    } else if (
      source.relevance ===
      "PARTIALLY_RELEVANT"
    ) {
      score += 10;
    }

    if (
      source.evidence
        ?.evidence_strength ===
      "moderate"
    ) {
      score += 10;
    }

    return score;
  }

  return sources
    .slice()
    .sort(
      (a, b) =>
        qualityScore(b) -
        qualityScore(a)
    );
}

/*
 * ============================================================
 * SOURCE DIVERSITY
 * ============================================================
 */

function ensureSourceDiversity(
  sources
) {
  if (
    sources.length <= 1
  ) {
    return sources;
  }

  const seenAuthors =
    new Set();

  const seenJournals =
    new Set();

  const result = [];

  for (
    const source of
    sources
  ) {
    let penalty = 0;

    if (
      Array.isArray(
        source.authors
      ) &&
      source.authors.length
    ) {
      for (
        const author of
        source.authors
      ) {
        const parts =
          String(author)
            .trim()
            .split(/\s+/);

        const lastName =
          parts[
            parts.length - 1
          ].toLowerCase();

        if (
          lastName.length > 2
        ) {
          if (
            seenAuthors.has(
              lastName
            )
          ) {
            penalty += 15;
          } else {
            seenAuthors.add(
              lastName
            );
          }
        }
      }
    }

    if (
      source.journal
    ) {
      const journalKey =
        source.journal
          .toLowerCase()
          .trim();

      if (
        journalKey
      ) {
        if (
          seenJournals.has(
            journalKey
          )
        ) {
          penalty += 5;
        } else {
          seenJournals.add(
            journalKey
          );
        }
      }
    }

    result.push({
      ...source,
      diversity_penalty:
        penalty
    });
  }

  return result.sort(
    (a, b) =>
      sourceScore(b) -
      b.diversity_penalty -
      (
        sourceScore(a) -
        a.diversity_penalty
      )
  );
}

function sourceScore(
  source
) {
  let score = 0;

  if (
    source.source_type ===
    "Crossref"
  ) {
    score += 50;

    if (
      source.abstract &&
      source.abstract.length >
        50
    ) {
      score += 30;
    }

    if (
      source.type ===
      "journal-article"
    ) {
      score += 20;
    }

    if (
      source.doi
    ) {
      score += 10;
    }

    if (
      source.year
    ) {
      score += 5;
    }
  } else if (
    source.source_type ===
    "Wikimedia"
  ) {
    score += 20;

    if (
      source.excerpt &&
      source.excerpt.length >
        50
    ) {
      score += 10;
    }
  }

  if (
    source.url_verified !==
    false
  ) {
    score += 15;
  }

  if (
    source.relevance ===
    "DIRECTLY_RELEVANT"
  ) {
    score += 25;
  } else if (
    source.relevance ===
    "PARTIALLY_RELEVANT"
  ) {
    score += 10;
  }

  if (
    source.evidence
      ?.evidence_strength ===
    "moderate"
  ) {
    score += 10;
  }

  return score;
}

/*
 * ============================================================
 * EVIDENCE DOSSIER
 * ============================================================
 */

function buildEvidenceDossier(
  sources
) {
  return sources
    .map(
      (source, index) => {
        const evidence =
          source.evidence ||
          {};

        const lines = [
          `SOURCE ${index + 1}`,
          `Source ID: ${evidence.source_id || index + 1}`,
          `Source Type: ${source.source_type}`,
          `Title: ${source.title}`,
          `URL: ${source.url || ""}`,
          `URL Verified: ${evidence.url_verified ? "yes" : "no"}`,
          `Authors: ${
            Array.isArray(
              evidence.authors
            ) &&
            evidence.authors.length
              ? evidence.authors.join(", ")
              : "not available"
          }`,
          `Year: ${evidence.year || "not available"}`,
          `DOI: ${evidence.doi || "not available"}`,
          `Journal: ${evidence.journal || "not available"}`,
          `Publication Status: ${evidence.publication_status || "not available"}`,
          `Evidence Strength: ${evidence.evidence_strength || "weak"}`,
          `Relevance: ${source.relevance || "not assessed"}`,
          `Relevance Reason: ${source.relevance_reason || "not provided"}`,
          `Diversity Penalty: ${source.diversity_penalty || 0}`,
          `Limitations: ${
            Array.isArray(
              evidence.limitations
            ) &&
            evidence.limitations.length
              ? evidence.limitations.join(
                  "; "
                )
              : "none noted"
          }`,
          `Evidence Text:`,
          evidence.evidence_text ||
            "No evidence text available from the API."
        ];

        return lines.join(
          "\n"
        );
      }
    )
    .join(
      "\n\n-------------------------\n\n"
    );
}

/*
 * ============================================================
 * CLAIM VERIFICATION
 * ============================================================
 */

async function generateAndVerifyClaims(
  env,
  prompt,
  goal,
  sources,
  evidenceDossier,
  requirements
) {
  const sourceList =
    sources
      .map(
        (source, index) =>
          `[${index + 1}] ${source.title} — ${source.url || "(no URL)"} [${source.relevance || "unknown"}]`
      )
      .join("\n");

  const reqContext =
    requirements?.core_question
      ? `
RESEARCH REQUIREMENTS:

Core question:
${requirements.core_question}

Evidence type:
${requirements.evidence_type}

Requires comparison:
${requirements.requires_comparison}

Comparison sides:
${(
  requirements.comparison_sides ||
  []
).join(", ")}

Strong evidence:
${requirements.strong_evidence_would_be}

Moderate evidence:
${requirements.moderate_evidence_would_be}

Weak evidence:
${requirements.weak_evidence_would_be}

Insufficient evidence:
${requirements.insufficient_evidence_would_be}
`
      : "";

  const system = `
You are the claim verification layer of My AI.

Your job:

1. Identify the major factual claims needed to answer the user's research request.
2. Check whether retrieved evidence actually supports each claim.
3. Assign a support status.
4. Detect conflicts.

CRITICAL RULES:

- Topic similarity is not evidence.
- Only use evidence contained in the evidence dossier.
- Crossref metadata without an abstract is not substantive evidence.
- Do not use your own prior knowledge as evidence.
- Sources marked IRRELEVANT or BACKGROUND_ONLY should not support claims.
- If sources disagree, mark CONFLICTING.
- Do not manufacture disagreement.

SUPPORT STATUSES:

SUPPORTED
PARTIALLY_SUPPORTED
CONFLICTING
NOT_SUPPORTED
INSUFFICIENT_EVIDENCE

Return ONLY valid JSON:

{
  "claims": [
    {
      "claim": "",
      "supporting_source_ids": [],
      "evidence_basis": "",
      "support_status": "SUPPORTED",
      "confidence": "high",
      "limitation": "",
      "conflict_notes": ""
    }
  ]
}

Rules:
- supporting_source_ids must be real 1-based IDs.
- confidence must be high, medium, or low.
- Generate approximately 3-8 claims depending on complexity.
- Do not include text outside JSON.

${reqContext}
`;

  const userMessage = `
USER REQUEST:
${prompt}

ACTUAL GOAL:
${goal}

EVIDENCE DOSSIER:
${evidenceDossier}

AVAILABLE SOURCES:
${sourceList}

Generate and verify claims.
Return ONLY JSON.
`;

  const result =
    await aiRun(
      env,
      [
        {
          role: "system",
          content: system
        },
        {
          role: "user",
          content: userMessage
        }
      ],
      {
        max_tokens: 2000,
        temperature: 0.2
      }
    );

  const text =
    extractAIText(result);

  try {
    const parsed =
      JSON.parse(
        cleanJSONResponse(text)
      );

    return Array.isArray(
      parsed.claims
    )
      ? parsed.claims
      : [];
  } catch {
    return [];
  }
}

/*
 * ============================================================
 * RESEARCH SYNTHESIS
 * ============================================================
 */

async function synthesizeResearch(
  env,
  prompt,
  goal,
  sources,
  requirements
) {
  /*
   * If research returned nothing,
   * fall back to a normal answer
   * instead of crashing.
   */

  if (!sources.length) {
    return generateNormalAnswer(
      env,
      prompt,
      {
        category:
          "DEEP_RESEARCH",
        goal
      }
    );
  }

  const evidenceDossier =
    buildEvidenceDossier(
      sources
    );

  const sourceList =
    sources
      .map(
        (source, index) =>
          `[${index + 1}] ${source.title} — ${source.url || "(no URL)"}`
      )
      .join("\n");

  const verifiedClaims =
    await generateAndVerifyClaims(
      env,
      prompt,
      goal,
      sources,
      evidenceDossier,
      requirements
    );

  let claimSummary = "";

  if (
    verifiedClaims.length
  ) {
    claimSummary =
      verifiedClaims
        .map(
          (claim, index) => {
            const ids =
              Array.isArray(
                claim.supporting_source_ids
              )
                ? claim.supporting_source_ids.join(
                    ", "
                  )
                : "none";

            return [
              `CLAIM ${index + 1}`,
              `Claim: ${claim.claim || ""}`,
              `Supporting Source IDs: ${ids}`,
              `Support Status: ${claim.support_status || "INSUFFICIENT_EVIDENCE"}`,
              `Confidence: ${claim.confidence || "low"}`,
              `Evidence Basis: ${claim.evidence_basis || "none"}`,
              `Limitation: ${claim.limitation || "none"}`,
              `Conflict: ${claim.conflict_notes || "none"}`
            ].join("\n");
          }
        )
        .join("\n\n");
  } else {
    claimSummary =
      "No claims could be verified against the retrieved evidence. Answer with appropriate uncertainty.";
  }

  const reqContext =
    requirements?.core_question
      ? `
RESEARCH REQUIREMENTS:

Core question:
${requirements.core_question}

Evidence type:
${requirements.evidence_type}

Requires comparison:
${requirements.requires_comparison}

Comparison sides:
${(
  requirements.comparison_sides ||
  []
).join(", ")}

Strong evidence:
${requirements.strong_evidence_would_be}

Insufficient evidence:
${requirements.insufficient_evidence_would_be}
`
      : "";

  const system = `
You are the research synthesis engine of My AI.

The user asked for research.

You are given:

1. A structured evidence dossier containing retrieved sources.
2. A claim verification summary.
3. Research requirements.

CRITICAL RULES:

1. REAL SOURCES ONLY

Use only the supplied sources.

Never invent:
- sources
- titles
- authors
- DOIs
- URLs
- journals
- dates

2. CLAIM-LEVEL VERIFICATION

Only make strong factual claims when supported.

If a claim is:
- NOT_SUPPORTED: omit it.
- INSUFFICIENT_EVIDENCE: weaken or omit it.
- CONFLICTING: report the conflict.
- PARTIALLY_SUPPORTED: use appropriately cautious language.

3. NEVER TREAT TOPICAL RELEVANCE AS EVIDENCE.

4. CROSSREF METADATA

Metadata-only records are not substantive evidence.

5. WIKIPEDIA

Use Wikipedia cautiously as general reference.

6. CONFLICTS

If sources disagree, explain the disagreement honestly.

7. CONCLUSION STRENGTH

The conclusion must never be stronger than the evidence.

Useful phrases:

"strong evidence suggests..."
"the evidence supports..."
"evidence is mixed..."
"there is some evidence..."
"the available sources are insufficient..."

8. CITATIONS

Use numbered citations:

[1]
[2]
[3]

Every citation must correspond to a supplied source.

Never invent citation numbers.

9. SOURCE QUALITY

Prefer stronger scholarly evidence when available.

10. MULTIPLE SOURCES

For important claims, compare independent sources.

11. NO FAKE CONFIDENCE

Do not fill evidence gaps with model knowledge.

12. RESPONSE FORMAT

Write a natural readable research answer.

Possible structure:

Short answer

What the evidence shows

Strongest evidence

Where researchers agree

Where researchers disagree

What remains uncertain

Sources

Do not expose internal claim verification or evidence dossier.

13. SOURCES SECTION

At the end:

Sources:

[1] Actual source title — actual URL
[2] Actual source title — actual URL

Only include sources actually used.

14. LANGUAGE

Answer in the same language as the user whenever possible.

Support English, Bengali and Hindi.

Preserve actual source titles.

15. URL INTEGRITY

Use only URLs supplied by the source data.

16. DO NOT EXPOSE INTERNAL REASONING.

${reqContext}
`;

  const userMessage = `
USER REQUEST:
${prompt}

ACTUAL GOAL:
${goal}

EVIDENCE DOSSIER:
${evidenceDossier}

CLAIM VERIFICATION SUMMARY:
${claimSummary}

AVAILABLE SOURCES:
${sourceList}

Produce the final research answer.

Follow the evidence strictly.
Do not invent sources.
Do not expose internal verification.
`;

  let result =
    await aiRun(
      env,
      [
        {
          role: "system",
          content: system
        },
        {
          role: "user",
          content: userMessage
        }
      ],
      {
        max_tokens: 4096,
        temperature: 0.4,
        top_p: 0.9
      }
    );

  let answer =
    extractAIText(result);

  /*
   * Continue if model stopped
   * because of token limit.
   */

  if (
    result?.choices?.[0]?.finish_reason ===
      "length" ||
    result?.choices?.[0]?.finish_reason ===
      "max_tokens"
  ) {
    const continuation =
      await aiRun(
        env,
        [
          {
            role: "system",
            content:
              "Continue the previous research answer naturally. Do not restart it. Finish the answer and include the Sources section if it has not already been completed. Use the same citation numbers. Do not invent sources."
          },
          {
            role: "user",
            content: answer
          }
        ],
        {
          max_tokens: 4096,
          temperature: 0.4,
          top_p: 0.9
        }
      );

    answer +=
      "\n" +
      extractAIText(
        continuation
      );
  }

  return validateCitations(
    answer,
    sources
  );
}

/*
 * ============================================================
 * CITATION VALIDATION
 * ============================================================
 */

function validateCitations(
  answer,
  sources
) {
  if (
    !answer ||
    !Array.isArray(sources) ||
    !sources.length
  ) {
    return answer;
  }

  const validNumbers =
    new Set();

  for (
    let i = 0;
    i < sources.length;
    i++
  ) {
    validNumbers.add(
      i + 1
    );
  }

  const citationPattern =
    /\[(\d+)\]/g;

  const invalidNumbers =
    new Set();

  let match;

  while (
    (match =
      citationPattern.exec(
        answer
      )) !== null
  ) {
    const number =
      Number(match[1]);

    if (
      !validNumbers.has(
        number
      )
    ) {
      invalidNumbers.add(
        number
      );
    }
  }

  if (
    invalidNumbers.size === 0
  ) {
    return answer;
  }

  let cleaned =
    answer;

  for (
    const number of
    invalidNumbers
  ) {
    cleaned =
      cleaned.replace(
        new RegExp(
          "\\[" +
            number +
            "\\]",
          "g"
        ),
        ""
      );
  }

  return cleaned;
}

/*
 * ============================================================
 * NORMAL AI ANSWER
 * ============================================================
 */

async function generateNormalAnswer(
  env,
  prompt,
  intent
) {
  const system = `
You are My AI, a helpful general-purpose AI assistant.

Understand what the user actually wants and perform the task.

The user may ask for:
- explanations
- writing
- stories
- scripts
- brainstorming
- planning
- learning
- coding
- comparisons
- everyday questions

Do not unnecessarily mention research.

Do not invent external sources or citations.

If the user asks you to perform a task, actually perform it.

Write naturally and clearly.

Match the user's language when possible.

User intent category:
${intent?.category || "NORMAL"}

User goal:
${intent?.goal || prompt}
`;

  let result =
    await aiRun(
      env,
      [
        {
          role: "system",
          content: system
        },
        {
          role: "user",
          content: prompt
        }
      ],
      {
        max_tokens: 4096,
        temperature: 0.6,
        top_p: 0.9
      }
    );

  let answer =
    extractAIText(result);

  /*
   * Continue long answers.
   */

  if (
    result?.choices?.[0]?.finish_reason ===
      "length" ||
    result?.choices?.[0]?.finish_reason ===
      "max_tokens"
  ) {
    const continuation =
      await aiRun(
        env,
        [
          {
            role: "system",
            content:
              "Continue the previous answer naturally. Do not repeat the beginning. Finish the user's requested task."
          },
          {
            role: "user",
            content: answer
          }
        ],
        {
          max_tokens: 4096,
          temperature: 0.6,
          top_p: 0.9
        }
      );

    answer +=
      "\n" +
      extractAIText(
        continuation
      );
  }

  return answer;
}

/*
 * ============================================================
 * WORKERS AI
 * ============================================================
 */

async function aiRun(
  env,
  messages,
  options = {}
) {
  if (!env.AI) {
    throw new Error(
      "Workers AI binding 'AI' is missing."
    );
  }

  const result =
    await env.AI.run(
      MODEL,
      {
        messages,
        max_tokens:
          options.max_tokens ??
          4096,
        temperature:
          options.temperature ??
          0.6,
        top_p:
          options.top_p ??
          0.9
      }
    );

  return result;
}

function extractAIText(
  result
) {
  if (!result) {
    return "";
  }

  /*
   * Workers AI common response:
   *
   * { response: "..." }
   */

  if (
    typeof result.response ===
    "string"
  ) {
    return result.response;
  }

  /*
   * OpenAI-style response
   */

  if (
    Array.isArray(
      result.choices
    ) &&
    result.choices[0]
  ) {
    const choice =
      result.choices[0];

    if (
      choice.message &&
      typeof choice.message.content ===
        "string"
    ) {
      return choice.message.content;
    }

    if (
      typeof choice.text ===
      "string"
    ) {
      return choice.text;
    }
  }

  return "";
}

/*
 * ============================================================
 * JSON CLEANING
 * ============================================================
 */

function cleanJSONResponse(
  text
) {
  if (
    typeof text !== "string"
  ) {
    return "";
  }

  let cleaned =
    text.trim();

  /*
   * Remove markdown fences.
   */

  cleaned =
    cleaned.replace(
      /^```json\s*/i,
      ""
    );

  cleaned =
    cleaned.replace(
      /^```\s*/i,
      ""
    );

  cleaned =
    cleaned.replace(
      /\s*```$/i,
      ""
    );

  cleaned =
    cleaned.trim();

  /*
   * Sometimes the model adds
   * text before/after JSON.
   *
   * Try to isolate the first
   * complete object.
   */

  if (
    !cleaned.startsWith("{") &&
    !cleaned.startsWith("[")
  ) {
    const objectStart =
      cleaned.indexOf("{");

    const arrayStart =
      cleaned.indexOf("[");

    let start = -1;

    if (
      objectStart >= 0 &&
      arrayStart >= 0
    ) {
      start =
        Math.min(
          objectStart,
          arrayStart
        );
    } else if (
      objectStart >= 0
    ) {
      start =
        objectStart;
    } else if (
      arrayStart >= 0
    ) {
      start =
        arrayStart;
    }

    if (start >= 0) {
      cleaned =
        cleaned.substring(
          start
        );
    }
  }

  return cleaned;
}

/*
 * ============================================================
 * KV CACHE
 * ============================================================
 */

async function getCache(
  env,
  key
) {
  if (!env.MY_AI_DATA) {
    return null;
  }

  try {
    return (
      (await env.MY_AI_DATA.get(
        key,
        "json"
      )) || null
    );
  } catch {
    return null;
  }
}

async function putCache(
  env,
  key,
  value
) {
  if (!env.MY_AI_DATA) {
    return;
  }

  try {
    await env.MY_AI_DATA.put(
      key,
      JSON.stringify(value),
      {
        expirationTtl:
          CACHE_TTL
      }
    );
  } catch (error) {
    /*
     * Cache failure must never
     * break the actual AI request.
     */

    console.warn(
      "Cache write failed:",
      error
    );
  }
}

/*
 * ============================================================
 * HASHING
 * ============================================================
 */

async function hashString(
  text
) {
  const data =
    new TextEncoder().encode(
      String(text)
    );

  const hash =
    await crypto.subtle.digest(
      "SHA-256",
      data
    );

  return Array.from(
    new Uint8Array(hash)
  )
    .map(
      byte =>
        byte
          .toString(16)
          .padStart(2, "0")
    )
    .join("");
}

/*
 * ============================================================
 * CROSSREF ABSTRACT CLEANING
 * ============================================================
 */

function cleanAbstract(
  text
) {
  if (!text) {
    return "";
  }

  return String(text)
    .replace(
      /<[^>]+>/g,
      ""
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}
