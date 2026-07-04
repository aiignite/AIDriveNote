import { api, API_BASE, getToken } from '../client';

export interface ChatPageContextEntity {
  type: string;
  id?: string;
  name?: string;
}

export interface QuickAction {
  label: string;
  prompt: string;
}

export interface PageAIContext {
  pageName: 'notes';
  moduleName: 'note';
  recommendedAssistant?: string;
  contextHint?: string;
  quickActions?: QuickAction[];
  selectedEntities?: ChatPageContextEntity[];
}

export interface ChatPageContext {
  pageName?: string;
  moduleName?: string;
  contextHint?: string;
  quickActions?: QuickAction[];
  selectedEntities?: ChatPageContextEntity[];
}

export const buildChatPageContext = (
  pageAIContext?: PageAIContext | null,
): ChatPageContext | undefined => {
  if (!pageAIContext) return undefined;
  return {
    pageName: pageAIContext.pageName,
    moduleName: pageAIContext.moduleName,
    contextHint: pageAIContext.contextHint,
    quickActions: pageAIContext.quickActions,
    selectedEntities: pageAIContext.selectedEntities,
  };
};

export interface AIModel {
  id: string;
  name: string;
  modelId: string;
  provider: string;
  endpoint?: string | null;
  description?: string | null;
  isPublic: boolean;
  isDefault?: boolean;
  popularity?: number;
  speed?: string;
  cost?: string;
  context?: string;
  supportsText?: boolean;
  supportsImage?: boolean;
  hasApiKey?: boolean;
  createdAt?: string;
}

export interface AIModelInput {
  name: string;
  modelId: string;
  provider?: string;
  endpoint?: string;
  apiKey?: string;
  description?: string;
  isPublic?: boolean;
  popularity?: number;
  speed?: string;
  cost?: string;
  context?: string;
  supportsText?: boolean;
  supportsImage?: boolean;
  setAsDefault?: boolean;
}

export interface AIAssistantInput {
  name?: string;
  description?: string;
  avatar?: string;
  role?: string;
  category?: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  isDefault?: boolean;
  tools?: string[];
}

export interface AIAssistant {
  id: string;
  name: string;
  description?: string | null;
  avatar?: string | null;
  role?: string | null;
  category?: string | null;
  systemPrompt: string;
  model?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  isSystem: boolean;
  isDefault: boolean;
  tools: string[];
  createdAt?: string;
}

export interface AISettings {
  defaultModelName?: string | null;
  defaultProvider?: string | null;
  sidebarWidth: number;
}

export interface AIConversation {
  id: string;
  title?: string | null;
  assistantName?: string | null;
  model?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface AIMessage {
  id: string;
  role: string;
  content: string;
  toolResults?: Array<{ tool: string; result: Record<string, unknown> }>;
  createdAt?: string;
}

export interface AISkill {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  promptTemplate: string;
  toolNames: string[];
  keywords: string[];
  priority: number;
  isEnabled: boolean;
  isBuiltin: boolean;
}

export interface AISkillInput {
  code: string;
  name: string;
  description?: string;
  promptTemplate?: string;
  toolNames?: string[];
  keywords?: string[];
  priority?: number;
  isEnabled?: boolean;
}

export interface SkillBindingItem {
  skillId: string;
  skillName?: string;
  weight: number;
  isEnabled: boolean;
}

export interface ChatStreamEvent {
  type: 'content' | 'tool_result' | 'done' | 'error';
  content?: string;
  tool?: string;
  result?: Record<string, unknown>;
  conversationId?: string;
}

export const aiApi = {
  listModels: () => api.get<AIModel[]>('/ai/models'),
  createModel: (data: AIModelInput) => api.post<AIModel>('/ai/models', data),
  updateModel: (id: string, data: Partial<AIModelInput>) => api.put<AIModel>(`/ai/models/${id}`, data),
  deleteModel: (id: string) => api.delete(`/ai/models/${id}`),
  testModelConnection: (id: string) =>
    api.post<{ ok?: boolean; success?: boolean; message?: string; error?: string; provider?: string; model?: string; latencyMs?: number }>(
      `/ai/models/${id}/test-connection`,
    ),

  listProviders: () =>
    api.get<Array<{ id: string; name: string; requiresApiKey: boolean; configured?: boolean }>>('/ai/providers'),

  listAssistants: () => api.get<AIAssistant[]>('/ai/assistants'),
  createAssistant: (data: AIAssistantInput & { name: string; systemPrompt: string }) =>
    api.post<AIAssistant>('/ai/assistants', data),
  updateAssistant: (id: string, data: Partial<AIAssistantInput>) =>
    api.put<AIAssistant>(`/ai/assistants/${id}`, data),
  deleteAssistant: (id: string) => api.delete(`/ai/assistants/${id}`),
  cloneAssistant: (id: string) => api.post<AIAssistant>(`/ai/assistants/${id}/clone`),

  getSettings: () => api.get<AISettings>('/ai/settings'),
  updateSettings: (data: Partial<{
    defaultModelName: string | null;
    defaultProvider: string | null;
    sidebarWidth: number;
  }>) => api.put<AISettings>('/ai/settings', {
    default_model_name: data.defaultModelName,
    default_provider: data.defaultProvider,
    sidebar_width: data.sidebarWidth,
  }),

  listConversations: () => api.get<AIConversation[]>('/ai/conversations'),
  createConversation: (assistantName = '笔记助手') =>
    api.post<AIConversation>('/ai/conversations', undefined),
  deleteConversation: (id: string) => api.delete(`/ai/conversations/${id}`),
  listMessages: (conversationId: string) =>
    api.get<AIMessage[]>(`/ai/conversations/${conversationId}/messages`),

  toolsRegistry: () => api.get<{ categories: Record<string, Array<{ name: string; label: string }>> }>(
    '/ai/tools/registry',
  ),

  listSkills: () => api.get<AISkill[]>('/ai/skills'),
  createSkill: (data: AISkillInput) => api.post<AISkill>('/ai/skills', data),
  updateSkill: (id: string, data: Partial<AISkillInput>) =>
    api.put<AISkill>(`/ai/skills/${id}`, data),
  deleteSkill: (id: string) => api.delete(`/ai/skills/${id}`),
  getPageSkills: () => api.get<SkillBindingItem[]>('/ai/page-skills/notes'),
  savePageSkills: (items: Array<{ skillId: string; weight: number; isEnabled: boolean }>) =>
    api.put('/ai/page-skills/notes', items.map(i => ({
      skill_id: i.skillId,
      weight: i.weight,
      is_enabled: i.isEnabled,
    }))),
  getAssistantSkills: (assistantId: string) =>
    api.get<SkillBindingItem[]>(`/ai/assistants/${assistantId}/skills`),
  saveAssistantSkills: (
    assistantId: string,
    items: Array<{ skillId: string; weight: number; isEnabled: boolean }>,
  ) => api.put(`/ai/assistants/${assistantId}/skills`, items.map(i => ({
    skill_id: i.skillId,
    weight: i.weight,
    is_enabled: i.isEnabled,
  }))),

  chatStream: async function* (params: {
    message: string;
    assistantName?: string;
    conversationId?: string;
    pageContext?: ChatPageContext;
    modelId?: string;
  }): AsyncGenerator<ChatStreamEvent> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${API_BASE}/ai/chat/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: params.message,
        assistant_name: params.assistantName ?? '笔记助手',
        conversation_id: params.conversationId,
        model_id: params.modelId,
        page_context: params.pageContext,
      }),
    });
    if (!res.ok || !res.body) throw new Error('AI stream failed');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload) as ChatStreamEvent;
        } catch { /* ignore */ }
      }
    }
  },
};
