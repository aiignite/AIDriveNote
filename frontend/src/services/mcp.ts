import { api } from './client';

export interface McpToolInfo {
  id: string;
  name: string;
  description?: string | null;
  inputSchema: Record<string, unknown>;
  isEnabled: boolean;
  approvalPolicy: 'auto' | 'ask' | 'deny';
}

export interface McpServerInfo {
  id: string;
  name: string;
  url: string;
  transport: string;
  command?: string | null;
  args?: string[];
  isEnabled: boolean;
  tools: McpToolInfo[];
}

export interface McpAuditItem {
  id: string;
  serverId: string;
  toolName: string;
  status: string;
  error?: string | null;
  durationMs: number;
  createdAt?: string | null;
}

export const mcpApi = {
  list: () => api.get<McpServerInfo[]>('/mcp/servers'),
  create: (data: {
    name: string;
    url?: string;
    headers?: Record<string, string>;
    transport?: 'http' | 'stdio';
    command?: string;
    args?: string[];
  }) => api.post<McpServerInfo>('/mcp/servers', data),
  update: (id: string, data: { name?: string; url?: string; isEnabled?: boolean }) =>
    api.patch<McpServerInfo>(`/mcp/servers/${id}`, data),
  remove: (id: string) => api.delete<{ success: boolean }>(`/mcp/servers/${id}`),
  discover: (id: string) => api.post<McpToolInfo[]>(`/mcp/servers/${id}/discover`, {}),
  updateTool: (id: string, data: { isEnabled?: boolean; approvalPolicy?: 'auto' | 'ask' | 'deny' }) =>
    api.patch<McpToolInfo>(`/mcp/tools/${id}`, data),
  callTool: (id: string, args: Record<string, unknown>) =>
    api.post<Record<string, unknown>>(`/mcp/tools/${id}/call`, { arguments: args }),
  audit: (limit = 30) => api.get<McpAuditItem[]>(`/mcp/audit?limit=${limit}`),
};
