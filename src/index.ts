// trigger cloudflare deploy
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import {
  OAuthResourceServer,
  type AuthorizationServerBinding,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

type AuthProps = {
  githubLogin: string;
};

interface Env {
  AUTH_SERVER: AuthorizationServerBinding<AuthProps>;
  WORDPRESS_PUBLISHER_API_KEY: string;
  PUBLISHER_API_KEY: string;
}

const MCP_RESOURCE =
  "https://mlb-wordpress-mcp-v2.t-haruka-1203.workers.dev/mcp";

const AUTH_ISSUER =
  "https://mlb-wordpress-auth.t-haruka-1203.workers.dev";

const PUBLISHER_URL =
  "https://mlb-wordpress-publisher.t-haruka-1203.workers.dev";

function createServer(env: Env) {
  const server = new McpServer({
    name: "mlb-wordpress-mcp-v2",
    version: "2.0.0",
  });

  server.registerTool(
    "publisher_runtime_probe_v2",
    {
      description:
        "Check the v2 MCP runtime and publisher secret bindings. " +
        "This tool does not create a WordPress post.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              server: "mlb-wordpress-mcp-v2",
              build: "2026-10-05-v2",
              wordpress_publisher_api_key_configured:
                Boolean(env.WORDPRESS_PUBLISHER_API_KEY),
              publisher_api_key_configured:
                Boolean(env.PUBLISHER_API_KEY),
              mode: "draft-only",
            },
            null,
            2
          ),
        },
      ],
    })
  );

  server.registerTool(
    "create_wordpress_draft",
    {
      description:
        "Create a new WordPress post as a draft only. " +
        "This tool cannot publish, schedule, update, or delete posts.",

      inputSchema: {
        title: z
          .string()
          .min(1)
          .describe("WordPress post title"),

        content: z
          .string()
          .min(1)
          .describe("Final WordPress HTML content"),

        excerpt: z
          .string()
          .optional()
          .describe("Optional WordPress excerpt"),

        slug: z
          .string()
          .optional()
          .describe("Optional WordPress slug"),
      },
    },
    async ({
      title,
      content,
      excerpt,
      slug,
    }) => {
      const apiKey =
        env.WORDPRESS_PUBLISHER_API_KEY ||
        env.PUBLISHER_API_KEY;

      if (!apiKey) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "No WordPress publisher API key is configured. " +
                "No WordPress request was sent.",
            },
          ],
        };
      }

      try {
        const payload: Record<string, string> = {
          title,
          content,
        };

        if (excerpt) {
          payload.excerpt = excerpt;
        }

        if (slug) {
          payload.slug = slug;
        }

        const response = await fetch(
          PUBLISHER_URL,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": apiKey,
            },
            body: JSON.stringify(payload),
          }
        );

        const responseText =
          await response.text();

        if (!response.ok) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `WordPress draft creation failed. ` +
                  `HTTP ${response.status}. ` +
                  `The request was not retried automatically. ` +
                  `Response: ${responseText}`,
              },
            ],
          };
        }

        let result: {
          success?: boolean;
          id?: number;
          status?: string;
          link?: string;
        };

        try {
          result = JSON.parse(responseText);
        } catch {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  "The publisher returned an unexpected response. " +
                  "The request was not retried automatically.",
              },
            ],
          };
        }

        if (
          result.status &&
          result.status !== "draft"
        ) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `Unexpected WordPress status: ${result.status}.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  status: "draft",
                  id: result.id,
                  link: result.link,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `WordPress draft creation failed: ${message}. ` +
                `The request was not retried automatically.`,
            },
          ],
        };
      }
    }
  );

  return server;
}

const mcpHandler = {
  fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ) {
    return createMcpHandler(
      createServer(env)
    )(
      request,
      env,
      ctx
    );
  },
};

export default new OAuthResourceServer<
  Env,
  AuthProps
>({
  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: [
      AUTH_ISSUER,
    ],
  },

  requiredScopes: [
    "mcp:read",
    "mcp:write",
  ],

  validateToken: (env) =>
    env.AUTH_SERVER.validateToken,

  handler: mcpHandler,
});
