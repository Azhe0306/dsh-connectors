/**
 * 原生前端：把桌面控制工具直接注册进 DSH 的工具表。
 *
 * 工具名统一加 `desktop_` 前缀（`desktop_screen_shot` 等），与浏览器连接器、
 * 官方工具区分开。core.mjs 里的函数与 MCP 前端共用同一份实现。
 */
import { TOOLS, handleTool } from './core.mjs';

export const name = 'desktop-connector';

/** 需要工具注册表。 */
export const inject = ['tools'];

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文
 */
export function apply(ctx) {
  for (const tool of TOOLS) {
    ctx.effect(
      () =>
        ctx.tools.register({
          name: `desktop_${tool.name}`,
          description: tool.description,
          parameters: tool.inputSchema,
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => {
              if (value !== null && typeof value === 'object' && Array.isArray(value.content)) return value.content;
              return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
            },
          },
          timeoutMs: 120000,
          execute: (args) => handleTool(tool.name, args ?? {}),
        }),
      `desktop-connector: ${tool.name}`,
    );
  }
}
