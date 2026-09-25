/**
 * 原生前端：把浏览器工具直接注册进 DSH 的工具表。
 *
 * 这样安装后不需要额外配置路径，也不需要 MCP 子进程——loader 自己解析本包，
 * core.mjs 在同一进程里被 import。想要 MCP 形态的人可以改用 core.mjs（见 README）。
 */
import { TOOLS, handleTool } from './core.mjs';

export const name = 'browser-connector';

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
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          output: {
            schema: { type: 'object', additionalProperties: true },
            // core 返回的是 MCP 形状的 content 数组，这里原样交给 DSH 渲染，
            // 于是 inline 截图那样的 image 块也能直接显示。
            render: (_args, value) => {
              if (value !== null && typeof value === 'object' && Array.isArray(value.content)) return value.content;
              return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
            },
          },
          timeoutMs: 180000,
          execute: (args) => handleTool(tool.name, args ?? {}),
        }),
      `browser-connector: ${tool.name}`,
    );
  }
}
