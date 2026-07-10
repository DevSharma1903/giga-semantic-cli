export interface ModelConfig {
  id: string;
  provider: string;
  description: string;
}

export const AVAILABLE_MODELS: ModelConfig[] = [
  // Google Tiers
  { id: 'gemini-2.5-flash', provider: 'Google', description: 'Fast, low-latency, ultra-cheap structural code repairs.' },
  { id: 'gemini-2.5-pro', provider: 'Google', description: 'Premium multi-file reasoning, high-context comprehension.' },
  
  // Anthropic Tiers
  { id: 'claude-3.5-sonnet', provider: 'Anthropic', description: 'Highly accurate systemic architectural changes.' },
  { id: 'claude-3.5-haiku', provider: 'Anthropic', description: 'Fast and lightweight reasoning tier.' },

  // OpenAI Tiers
  { id: 'gpt-4o', provider: 'OpenAI', description: 'Fast cross-functional code generation.' },
  { id: 'gpt-4o-mini', provider: 'OpenAI', description: 'Low-latency code iterations.' },
  { id: 'o1-mini', provider: 'OpenAI', description: 'Deep reasoning and logic-heavy codebase modifications.' },

  // Local Ollama Tiers
  { id: 'qwen2.5-coder:7b', provider: 'Ollama', description: 'Qwen 2.5 Coder (7B Local)' },
  { id: 'qwen2.5-coder:14b', provider: 'Ollama', description: 'Qwen 2.5 Coder (14B Local)' },
  { id: 'llama3.1:8b', provider: 'Ollama', description: 'Llama 3.1 (8B Local)' },
  { id: 'codellama:7b', provider: 'Ollama', description: 'CodeLlama (7B Local)' }
];
