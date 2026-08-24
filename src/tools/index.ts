import { bashTool } from './bash.ts';
import { claudeTool } from './claude.ts';
import { herdrAgentTool, herdrTool } from './herdr.ts';
import type { Tool } from './types.ts';

export const tools: Tool[] = [claudeTool, herdrTool, herdrAgentTool, bashTool];

export function toolById(id: string): Tool | undefined {
  return tools.find((tool) => tool.id === id);
}
