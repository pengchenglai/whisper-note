// 设置保存在本机 localStorage。每个服务商的 Key 分开存，切换服务商时不会把 Key 发错地方。

const KEY = 'wn.settings.v1';

export const PRESETS = {
  openai: {
    label: 'OpenAI（中英混说最准，按量付费）',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-transcribe', 'gpt-4o-mini-transcribe'],
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  groq: {
    label: 'Groq（Whisper large-v3，有免费额度）',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['whisper-large-v3', 'whisper-large-v3-turbo'],
    keyUrl: 'https://console.groq.com/keys',
  },
  siliconflow: {
    label: '硅基流动（SenseVoice，国内可直连）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['FunAudioLLM/SenseVoiceSmall'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  custom: {
    label: '自定义（OpenAI 兼容接口）',
    baseUrl: '',
    models: [],
    keyUrl: '',
  },
};

const DEFAULTS = {
  provider: 'openai',
  keys: {},
  models: {},
  customBaseUrl: '',
  language: 'mixed', // mixed | zh | en | auto
  vocab: '',
  interim: true,
  pauseMs: 800,
  sensitivity: 'medium',
};

export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch (e) {
    saved = {};
  }
  const s = Object.assign({}, DEFAULTS, saved);
  s.keys = Object.assign({}, saved.keys);
  s.models = Object.assign({}, saved.models);
  if (!PRESETS[s.provider]) s.provider = DEFAULTS.provider;
  return s;
}

export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (e) {
    /* 无痕模式等情况下写不进去，忽略 */
  }
}

// 当前生效的接口配置
export function activeConfig(s) {
  const preset = PRESETS[s.provider];
  const baseUrl = (s.provider === 'custom' ? s.customBaseUrl : preset.baseUrl) || '';
  return {
    baseUrl: baseUrl.trim(),
    apiKey: (s.keys[s.provider] || '').trim(),
    model: (s.models[s.provider] || preset.models[0] || '').trim(),
  };
}

export function isConfigured(s) {
  const c = activeConfig(s);
  return !!(c.baseUrl && c.apiKey && c.model);
}
