import { claudeTool } from './claude.ts';
import { gitTool } from './git.ts';
import { herdrTool } from './herdr.ts';
import type { Tool } from './types.ts';

export const tools: Tool[] = [claudeTool, herdrTool, gitTool];

export function toolById(id: string): Tool | undefined {
  return tools.find((tool) => tool.id === id);
}

export function toolByKey(key: string): Tool | undefined {
  return tools.find((tool) => tool.key === key);
}
