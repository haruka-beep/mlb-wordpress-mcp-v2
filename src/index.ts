import { WorkerEntrypoint } from "cloudflare:workers";
import {
  OAuthAuthorizationServer,
  type AuthRequest,
} from "@cloudflare/workers-oauth-provider";

interface Env {
  OAUTH_KV: KVNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
}

type AuthProps = {
  githubLogin: string;
};

const AUTH_ISSUER =
  "https://mlb-wordpress-auth.t-haruka-1203.workers.dev";

const MCP_RESOURCE =
  "https://mlb-wordpress-mcp.t-haruka-1203.workers.dev/mcp";

const MCP_RESOURCE_V2 =
  "https://mlb-wordpress-mcp-v2.t-haruka-1203.workers.dev/mcp";

const authorizationServer =
  new OAuthAuthorizationServer<Env>({
    issuer: AUTH_ISSUER,

    resources: [
      MCP_RESOURCE,
      MCP_RESOURCE_V2,
    ],

    scopesSupported: [
      "mcp:read",
      "mcp:write",
    ],

    clientIdMetadataDocumentEnabled: true,
  });

function escapeHtml(
  value: string
): string {
  return value.replace(
    /[&<>"']/g,
    (char) => {
      const map:
        Record<string, string> = {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#039;",
        };

      return map[char] ?? char;
    }
  );
}

function createConsentPage(
  clientName: string,
  scopes: string[],
  handle: string
): string {
  const scopeHtml = scopes
    .map(
      (scope) => `
        <label>
          <input
            type="checkbox"
            name="scope"
            value="${escapeHtml(scope)}"
            checked
          />
          ${escapeHtml(scope)}
        </label>
      `
    )
    .join("<br>");

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta
    name="viewport"
    content="width=device-width,initial-scale=1"
  >
  <title>
    MLB WordPress Publisher
  </title>
</head>

<body>
  <main>
    <h1>
      アクセスを許可しますか？
    </h1>

    <p>
      ${escapeHtml(clientName)}
      が MLB WordPress Publisher
      へのアクセスを要求しています。
    </p>

    <form
      method="post"
      action="/authorize"
    >
      <input
        type="hidden"
        name="handle"
        value="${escapeHtml(handle)}"
      />

      <p>
        ${scopeHtml}
      </p>

      <button
        type="submit"
        name="action"
        value="allow"
      >
        許可
      </button>

      <button
        type="submit"
        name="action"
        value="deny"
      >
        拒否
      </button>
    </form>
  </main>
</body>
</html>`;
}

async function exchangeGithubCode(
  env: Env,
  code: string
): Promise<string | null> {
  const response = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",

      headers: {
        Accept: "application/json",

        "Content-Type":
          "application/x-www-form-urlencoded",
      },

      body: new URLSearchParams({
        client_id:
          env.GITHUB_CLIENT_ID,

        client_secret:
          env.GITHUB_CLIENT_SECRET,

        code,

        redirect_uri:
          `${AUTH_ISSUER}/callback`,
      }),
    }
  );

  if (!response.ok) {
    return null;
  }

  const data =
    (await response.json()) as {
      access_token?: string;
    };

  return data.access_token ?? null;
}

async function getGithubUser(
  accessToken: string
): Promise<{
  id: number;
  login: string;
} | null> {
  const response = await fetch(
    "https://api.github.com/user",
    {
      headers: {
        Authorization:
          `Bearer ${accessToken}`,

        Accept:
          "application/vnd.github+json",

        "User-Agent":
          "mlb-wordpress-auth",
      },
    }
  );

  if (!response.ok) {
    return null;
  }

  return (
    await response.json()
  ) as {
    id: number;
    login: string;
  };
}

async function startGithubAuthorization(
  authRequest: AuthRequest,
  env: Env,
  headers: Headers,
  oauth: ReturnType<
    OAuthAuthorizationServer<Env>[
      "getOAuthApi"
    ]
  >
): Promise<Response> {
  const upstream =
    await oauth.beginUpstream(
      authRequest,
      { headers }
    );

  const githubUrl =
    new URL(
      "https://github.com/login/oauth/authorize"
    );

  githubUrl.searchParams.set(
    "client_id",
    env.GITHUB_CLIENT_ID
  );

  githubUrl.searchParams.set(
    "redirect_uri",
    `${AUTH_ISSUER}/callback`
  );

  githubUrl.searchParams.set(
    "state",
    upstream.state
  );

  githubUrl.searchParams.set(
    "scope",
    "read:user user:email"
  );

  upstream.headers.set(
    "Location",
    githubUrl.toString()
  );

  return new Response(
    null,
    {
      status: 302,
      headers:
        upstream.headers,
    }
  );
}

export default class AuthServer
  extends WorkerEntrypoint<Env>
{
  async fetch(
    request: Request
  ): Promise<Response> {
    const url =
      new URL(request.url);

    const oauth =
      authorizationServer.getOAuthApi(
        this.env
      );

    if (
      url.pathname === "/authorize" &&
      request.method === "GET"
    ) {
      const authRequest =
        await oauth.parseAuthRequest(
          request
        );

      const description =
        await oauth.describeConsent(
          authRequest
        );

      const consent =
        await oauth.beginConsent(
          authRequest
        );

      const html =
        createConsentPage(
          description.clientName,
          description.scope,
          consent.handle
        );

      const headers =
        new Headers(
          consent.headers
        );

      headers.set(
        "Content-Type",
        "text/html; charset=utf-8"
      );

      return new Response(
        html,
        {
          status: 200,
          headers,
        }
      );
    }

    if (
      url.pathname === "/authorize" &&
      request.method === "POST"
    ) {
      const form =
        await request.formData();

      const handle =
        String(
          form.get("handle") ?? ""
        );

      const action =
        String(
          form.get("action") ?? ""
        );

      if (!handle) {
        return new Response(
          "Missing consent handle",
          {
            status: 400,
          }
        );
      }

      if (action === "deny") {
        const denied =
          await oauth.denyConsent(
            request,
            handle
          );

        return new Response(
          null,
          {
            status: 302,
            headers:
              denied.headers,
          }
        );
      }

      const scopes =
        form
          .getAll("scope")
          .map(String);

      const approved =
        await oauth.approveConsent(
          request,
          handle,
          {
            scope: scopes,
          }
        );

      return startGithubAuthorization(
        approved.request,
        this.env,
        approved.headers,
        oauth
      );
    }

    if (
      url.pathname === "/callback" &&
      request.method === "GET"
    ) {
      const resumed =
        await oauth.finishUpstream(
          request
        );

      const code =
        url.searchParams.get(
          "code"
        );

      if (!code) {
        return new Response(
          "Missing GitHub authorization code",
          {
            status: 400,
          }
        );
      }

      const githubAccessToken =
        await exchangeGithubCode(
          this.env,
          code
        );

      if (
        !githubAccessToken
      ) {
        return new Response(
          "GitHub token exchange failed",
          {
            status: 400,
          }
        );
      }

      const githubUser =
        await getGithubUser(
          githubAccessToken
        );

      if (!githubUser) {
        return new Response(
          "GitHub user lookup failed",
          {
            status: 400,
          }
        );
      }

      const completed =
        await oauth
          .completeAuthorization({
            request:
              resumed.request,

            userId:
              String(
                githubUser.id
              ),

            metadata: {
              provider:
                "github",
            },

            scope:
              resumed.request.scope,

            props: {
              githubLogin:
                githubUser.login,
            } satisfies AuthProps,
          });

      const headers =
        new Headers(
          resumed.headers
        );

      headers.set(
        "Location",
        completed.redirectTo
      );

      return new Response(
        null,
        {
          status: 302,
          headers,
        }
      );
    }

    return authorizationServer.fetch(
      request,
      this.env,
      this.ctx
    );
  }

  validateToken(
    resource: string,
    token: string
  ) {
    return authorizationServer
      .validateToken(
        resource,
        token,
        this.env
      );
  }
}
