import { claudeTool } from './claude.ts';
import { ghosttyTool } from './ghostty.ts';
import { gitTool } from './git.ts';
import type { Tool } from './types.ts';

export const tools: Tool[] = [claudeTool, ghosttyTool, gitTool];

export function toolById(id: string): Tool | undefined {
  return tools.find((tool) => tool.id === id);
}

export function toolByKey(key: string): Tool | undefined {
  return tools.find((tool) => tool.key === key);
}
