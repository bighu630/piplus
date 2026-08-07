import React, { useState, useCallback, useEffect, useRef } from 'react';
import Modal from './Modal';
import Select from './Select';
import { PlusCircle, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTestModelProviderMutation, useCreateModelProviderMutation, useNativeModelProviders, useSetNativeProviderApiKeyMutation } from '../lib/hooks';
import type { ProviderFormModel } from '../lib/api';

interface ProviderModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function createEmptyProviderModel(): ProviderFormModel {
  return {
    id: '',
    name: '',
    reasoning: false,
    inputImage: false,
    input: undefined,
    api: '',
    contextWindow: undefined,
    maxTokens: undefined,
    cost: undefined,
    compat: '',
    thinkingLevelMap: '',
  };
}

const THINKING_PRESET_OPTIONS = [
  { value: 'none', label: '无' },
  { value: 'openai-standard', label: 'OpenAI 标准' },
  { value: 'openai-full', label: 'OpenAI 全层级' },
  { value: 'map-high', label: '全映射 high' },
  { value: 'custom', label: '自定义…' },
];

const THINKING_PRESET_JSONS: Record<string, string> = {
  'openai-standard': JSON.stringify({ off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null }),
  'openai-full': JSON.stringify({ off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: null }),
  'map-high': JSON.stringify({ off: null, minimal: null, low: 'high', medium: 'high', high: 'high', xhigh: null }),
};

const CONTEXT_PRESET_OPTIONS = [
  { value: '128k', label: '128k (131072)' },
  { value: '200k', label: '200k (200000)' },
  { value: '1m', label: '1M (1048576)' },
  { value: 'custom', label: '自定义…' },
];

const CONTEXT_PRESET_NUMS: Record<string, number> = {
  '128k': 131072,
  '200k': 200000,
  '1m': 1048576,
};

function isValidJson(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function reindexMap<T>(map: Record<number, T>, removed: number): Record<number, T> {
  const next: Record<number, T> = {};
  for (const [k, v] of Object.entries(map)) {
    const ki = Number(k);
    if (ki < removed) next[ki] = v;
    else if (ki > removed) next[ki - 1] = v;
  }
  return next;
}

function getThinkingPresetValue(thinkingLevelMap: string | undefined): string {
  const trimmed = (thinkingLevelMap ?? '').trim();
  if (!trimmed) return 'none';
  const match = Object.entries(THINKING_PRESET_JSONS).find(([, json]) => trimmed === json);
  return match ? match[0] : 'custom';
}

function getContextPresetValue(contextWindow: number | undefined): string {
  if (contextWindow === undefined) return '';
  const match = Object.entries(CONTEXT_PRESET_NUMS).find(([, num]) => num === contextWindow);
  return match ? match[0] : 'custom';
}

export default function ProviderModal({ isOpen, onClose }: ProviderModalProps) {
  const queryClient = useQueryClient();
  const testProviderMut = useTestModelProviderMutation();
  const createProviderMut = useCreateModelProviderMutation();
  const nativeProvidersQuery = useNativeModelProviders();
  const setNativeApiKeyMut = useSetNativeProviderApiKeyMutation();

  const [providerKey, setProviderKey] = useState('');
  const [providerBaseUrl, setProviderBaseUrl] = useState('');
  const [providerApiKey, setProviderApiKey] = useState('');
  const [providerAuthHeader, setProviderAuthHeader] = useState(true);
  const [supportsDeveloperRole, setSupportsDeveloperRole] = useState(false);
  const [supportsReasoningEffort, setSupportsReasoningEffort] = useState(false);
  const [providerApi, setProviderApi] = useState('');
  const [providerHeaders, setProviderHeaders] = useState('');
  const [providerCompatJson, setProviderCompatJson] = useState('');
  const [providerTab, setProviderTab] = useState<'native' | 'custom'>('native');
  const [nativeProvider, setNativeProvider] = useState('openrouter');
  const [nativeApiKey, setNativeApiKey] = useState('');
  const [providerModels, setProviderModels] = useState<ProviderFormModel[]>([]);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerTestResult, setProviderTestResult] = useState<string | null>(null);
  const [providerHeadersJsonError, setProviderHeadersJsonError] = useState(false);
  const [providerCompatJsonError, setProviderCompatJsonError] = useState(false);
  const [modelJsonErrors, setModelJsonErrors] = useState<Record<number, { compat?: boolean; thinking?: boolean }>>({});
  const [thinkingCustomModes, setThinkingCustomModes] = useState<Record<number, boolean>>({});
  const [contextCustomModes, setContextCustomModes] = useState<Record<number, boolean>>({});

  const prevIsOpenRef = useRef(isOpen);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      resetProviderForm();
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen]);

  const handleClose = useCallback(() => {
    onClose();
    setProviderError(null);
  }, [onClose]);

  const resetProviderForm = useCallback(() => {
    setProviderKey('');
    setProviderBaseUrl('');
    setProviderApiKey('');
    setProviderAuthHeader(true);
    setSupportsDeveloperRole(false);
    setSupportsReasoningEffort(false);
    setProviderApi('');
    setProviderHeaders('');
    setProviderCompatJson('');
    setProviderTab('native');
    setNativeProvider('openrouter');
    setNativeApiKey('');
    setProviderModels([]);
    setProviderError(null);
    setProviderTestResult(null);
    setProviderHeadersJsonError(false);
    setProviderCompatJsonError(false);
    setModelJsonErrors({});
    setThinkingCustomModes({});
    setContextCustomModes({});
  }, []);

  const updateProviderModel = useCallback((index: number, patch: Partial<ProviderFormModel>) => {
    setProviderModels((current) => current.map((model, modelIndex) => modelIndex === index ? { ...model, ...patch } : model));
  }, []);

  const handleRemoveProviderModel = useCallback((index: number) => {
    setProviderModels((current) => current.length === 1 ? current : current.filter((_, modelIndex) => modelIndex !== index));
    setModelJsonErrors((prev) => reindexMap(prev, index));
    setThinkingCustomModes((prev) => reindexMap(prev, index));
    setContextCustomModes((prev) => reindexMap(prev, index));
  }, []);

  const handleProviderHeadersChange = useCallback((value: string) => {
    setProviderHeaders(value);
    setProviderHeadersJsonError(value.trim() ? !isValidJson(value) : false);
  }, []);

  const handleProviderCompatChange = useCallback((value: string) => {
    setProviderCompatJson(value);
    setProviderCompatJsonError(value.trim() ? !isValidJson(value) : false);
  }, []);

  const handleModelCompatChange = useCallback((index: number, value: string) => {
    updateProviderModel(index, { compat: value });
    setModelJsonErrors((prev) => ({ ...prev, [index]: { ...prev[index], compat: value.trim() ? !isValidJson(value) : false } }));
  }, [updateProviderModel]);

  const handleModelThinkingChange = useCallback((index: number, value: string) => {
    updateProviderModel(index, { thinkingLevelMap: value });
    setModelJsonErrors((prev) => ({ ...prev, [index]: { ...prev[index], thinking: value.trim() ? !isValidJson(value) : false } }));
  }, [updateProviderModel]);

  const handleThinkingPresetChange = useCallback((index: number, value: string) => {
    if (value === 'custom') {
      // 保持当前 JSON 不变，显示手填 textarea
      setThinkingCustomModes((prev) => ({ ...prev, [index]: true }));
      return;
    }
    updateProviderModel(index, { thinkingLevelMap: value === 'none' ? '' : THINKING_PRESET_JSONS[value] });
    setThinkingCustomModes((prev) => ({ ...prev, [index]: false }));
    setModelJsonErrors((prev) => ({ ...prev, [index]: { ...prev[index], thinking: false } }));
  }, [updateProviderModel]);

  const handleContextPresetChange = useCallback((index: number, value: string) => {
    if (value === 'custom') {
      // 保持当前值不变，显示手填 number 输入框
      setContextCustomModes((prev) => ({ ...prev, [index]: true }));
      return;
    }
    updateProviderModel(index, { contextWindow: CONTEXT_PRESET_NUMS[value] });
    setContextCustomModes((prev) => ({ ...prev, [index]: false }));
  }, [updateProviderModel]);

  const handleContextWindowChange = useCallback((index: number, value: string) => {
    const num = value ? Number(value) : undefined;
    updateProviderModel(index, { contextWindow: num });
    if (num !== undefined && Object.values(CONTEXT_PRESET_NUMS).includes(num)) {
      // 手填值与某个预设相等时，回归预设模式
      setContextCustomModes((prev) => ({ ...prev, [index]: false }));
    }
  }, [updateProviderModel]);

  const buildProviderPayload = useCallback(() => {
    const compatObj: Record<string, unknown> = {
      supportsDeveloperRole,
      supportsReasoningEffort,
    };
    if (providerCompatJson.trim()) {
      try {
        const extra = JSON.parse(providerCompatJson.trim());
        Object.assign(compatObj, extra);
      } catch { /* invalid JSON, skip */ }
    }

    let headersObj: Record<string, string> | undefined;
    if (providerHeaders.trim()) {
      try {
        headersObj = JSON.parse(providerHeaders.trim());
      } catch { /* invalid JSON, skip */ }
    }

    return {
      providerKey: providerKey.trim(),
      baseUrl: providerBaseUrl.trim(),
      apiKey: providerApiKey,
      authHeader: providerAuthHeader,
      api: providerApi.trim() || undefined,
      headers: headersObj,
      compat: Object.keys(compatObj).length > 0 ? compatObj : undefined,
      models: providerModels.map((model) => ({
        id: model.id.trim(),
        name: model.name?.trim() || undefined,
        reasoning: Boolean(model.reasoning),
        inputImage: Boolean(model.inputImage),
        input: model.input,
        api: model.api?.trim() || undefined,
        contextWindow: model.contextWindow ? Number(model.contextWindow) : undefined,
        maxTokens: model.maxTokens ? Number(model.maxTokens) : undefined,
        cost: model.cost
          ? {
              ...(model.cost.input !== undefined && !Number.isNaN(Number(model.cost.input)) ? { input: Number(model.cost.input) } : {}),
              ...(model.cost.output !== undefined && !Number.isNaN(Number(model.cost.output)) ? { output: Number(model.cost.output) } : {}),
              ...(model.cost.cacheRead !== undefined && !Number.isNaN(Number(model.cost.cacheRead)) ? { cacheRead: Number(model.cost.cacheRead) } : {}),
              ...(model.cost.cacheWrite !== undefined && !Number.isNaN(Number(model.cost.cacheWrite)) ? { cacheWrite: Number(model.cost.cacheWrite) } : {}),
            }
          : undefined,
        compat: model.compat?.trim()
          ? (() => { try { const p = JSON.parse(model.compat!.trim()); return p; } catch { return undefined; } })()
          : undefined,
        thinkingLevelMap: model.thinkingLevelMap?.trim()
          ? (() => { try { const p = JSON.parse(model.thinkingLevelMap!.trim()); return p; } catch { return undefined; } })()
          : undefined,
      })),
    };
  }, [providerKey, providerBaseUrl, providerApiKey, providerAuthHeader, supportsDeveloperRole, supportsReasoningEffort, providerApi, providerHeaders, providerCompatJson, providerModels]);

  const validateProviderPayload = useCallback((payload: { providerKey: string; baseUrl: string; models: Array<{ id: string }> }) => {
    if (!payload.providerKey) return '请填写 providerKey';
    if (!payload.baseUrl) return '请填写 baseUrl';
    if (payload.models.length === 0) return '请至少添加一个模型';
    if (payload.models.some((model) => !model.id)) return '请填写所有模型的 id';
    return null;
  }, []);

  const handleTestProvider = useCallback(async () => {
    if (!providerKey.trim()) {
      setProviderError('请填写 providerKey');
      return;
    }
    if (!providerBaseUrl.trim()) {
      setProviderError('请填写 baseUrl');
      return;
    }
    setProviderError(null);
    setProviderTestResult(null);
    try {
      const result = await testProviderMut.mutateAsync({
        providerKey: providerKey.trim(),
        baseUrl: providerBaseUrl.trim(),
        apiKey: providerApiKey,
        authHeader: providerAuthHeader,
      });
      if (!result.ok) {
        setProviderError(result.error ?? '拉取模型列表失败');
        return;
      }
      const models = result.models ?? [];
      setProviderModels(models.map((m) => ({ ...createEmptyProviderModel(), id: m.id, name: m.name ?? '' })));
      setModelJsonErrors({});
      setThinkingCustomModes({});
      setContextCustomModes({});
      setProviderTestResult(models.length > 0 ? `发现 ${models.length} 个模型` : '测试成功，未发现模型');
    } catch (error) {
      setProviderError(error instanceof Error ? error.message : '拉取模型列表失败');
    }
  }, [providerKey, providerBaseUrl, providerApiKey, providerAuthHeader, testProviderMut]);

  const handleSaveProvider = useCallback(async () => {
    const hasJsonError =
      providerHeadersJsonError ||
      providerCompatJsonError ||
      Object.values(modelJsonErrors).some((errors) => errors?.compat || errors?.thinking);
    if (hasJsonError) {
      setProviderError('存在 JSON 格式错误，请修正后再保存');
      return;
    }
    const payload = buildProviderPayload();
    const error = validateProviderPayload(payload);
    if (error) {
      setProviderError(error);
      return;
    }
    setProviderError(null);
    try {
      await createProviderMut.mutateAsync(payload);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: ['models', 'status'] }),
      ]);
      handleClose();
    } catch (saveError) {
      setProviderError(saveError instanceof Error ? saveError.message : '保存失败');
    }
  }, [buildProviderPayload, validateProviderPayload, createProviderMut, queryClient, handleClose, providerHeadersJsonError, providerCompatJsonError, modelJsonErrors]);

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="添加模型" icon={<PlusCircle className="w-4 h-4 text-blue-600 dark:text-blue-400" />} maxWidthClassName="max-w-3xl">
      <div className="space-y-4">
        {/* Tabs */}
        <div className="flex border-b border-slate-200 dark:border-slate-700 -mx-1">
          <button
            onClick={() => setProviderTab('native')}
            className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${
              providerTab === 'native'
                ? 'border-blue-600 text-blue-700 dark:text-blue-400'
                : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
          >
            平台密钥
          </button>
          <button
            onClick={() => setProviderTab('custom')}
            className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition cursor-pointer ${
              providerTab === 'custom'
                ? 'border-blue-600 text-blue-700 dark:text-blue-400'
                : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
          >
            自定义提供商
          </button>
        </div>

        {/* Tab content: Native */}
        {providerTab === 'native' && (
          <div className="space-y-4">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              选择平台并输入 API Key，密钥将写入 Pi 原生凭据存储 <code className="text-[10px] bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded">~/.pi/agent/auth.json</code>，用于启用内置模型平台。
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">平台</label>
                <Select
                  value={nativeProvider}
                  onChange={(v) => setNativeProvider(v)}
                  options={(nativeProvidersQuery.data?.providers ?? []).map((p: any) => ({
                    value: p.provider,
                    label: `${p.label}${p.hasAuth ? ' (已配置)' : ''}`,
                  }))}
                  placeholder="选择平台"
                  searchable
                  className="w-full"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">API Key</label>
                <input
                  value={nativeApiKey}
                  onChange={(e) => setNativeApiKey(e.target.value)}
                  type="password"
                  placeholder="输入 API Key..."
                  className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-3 border-t border-slate-150 dark:border-slate-800">
              <button onClick={handleClose} className="px-3 py-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer">取消</button>
              <button
                onClick={async () => {
                  if (!nativeApiKey.trim()) return;
                  try {
                    await setNativeApiKeyMut.mutateAsync({ provider: nativeProvider, apiKey: nativeApiKey.trim() });
                    setNativeApiKey('');
                    handleClose();
                  } catch {}
                }}
                disabled={setNativeApiKeyMut.isPending || !nativeApiKey.trim()}
                className="px-4 py-1.5 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer disabled:opacity-50"
              >
                {setNativeApiKeyMut.isPending ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        )}

        {/* Tab content: Custom */}
        {providerTab === 'custom' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">providerKey</label>
                <input value={providerKey} onChange={(e) => setProviderKey(e.target.value)} placeholder="例如 custom-openai" className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950" />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">baseUrl</label>
                <input value={providerBaseUrl} onChange={(e) => setProviderBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950" />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">api</label>
                <select value={providerApi} onChange={(e) => setProviderApi(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950">
                  <option value="">openai-completions（默认）</option>
                  <option value="openai-completions">openai-completions</option>
                  <option value="openai-responses">openai-responses</option>
                  <option value="anthropic-messages">anthropic-messages</option>
                  <option value="google-generative-ai">google-generative-ai</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">apiKey</label>
                <input value={providerApiKey} onChange={(e) => setProviderApiKey(e.target.value)} type="password" placeholder="sk-..." className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950" />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300"><input type="checkbox" checked={providerAuthHeader} onChange={(e) => setProviderAuthHeader(e.target.checked)} /> authHeader</label>
              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300"><input type="checkbox" checked={supportsDeveloperRole} onChange={(e) => setSupportsDeveloperRole(e.target.checked)} /> compat.supportsDeveloperRole</label>
              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300"><input type="checkbox" checked={supportsReasoningEffort} onChange={(e) => setSupportsReasoningEffort(e.target.checked)} /> compat.supportsReasoningEffort</label>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">headers（JSON，可选）</label>
                <textarea value={providerHeaders} onChange={(e) => handleProviderHeadersChange(e.target.value)} placeholder='{
  "x-custom-header": "value"
}' rows={3} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 font-mono" />
                {providerHeadersJsonError && <div className="text-[10px] text-red-500 dark:text-red-400 mt-1">JSON 格式错误</div>}
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">compat 额外字段（JSON，可选）</label>
                <textarea value={providerCompatJson} onChange={(e) => handleProviderCompatChange(e.target.value)} placeholder='{
  "supportsUsageInStreaming": false,
  "maxTokensField": "max_tokens",
  "thinkingFormat": "deepseek"
}' rows={3} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 bg-slate-50 dark:bg-slate-950 font-mono" />
                {providerCompatJsonError && <div className="text-[10px] text-red-500 dark:text-red-400 mt-1">JSON 格式错误</div>}
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">模型列表</div>
                <div className="text-[10px] text-slate-400 dark:text-slate-500">点击「拉取模型列表」自动获取模型</div>
              </div>
              {providerModels.map((model, index) => (
                <div key={index} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-3 bg-slate-50 dark:bg-slate-950/40">
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 shrink-0">模型 {index + 1}</span>
                      {model.id.trim() ? (
                        <>
                          <code className="text-xs font-mono font-bold text-slate-800 dark:text-slate-100 truncate">{model.id}</code>
                          {model.name?.trim() ? <span className="text-xs text-slate-400 dark:text-slate-500 truncate">{model.name}</span> : null}
                        </>
                      ) : (
                        <span className="text-xs text-slate-400 dark:text-slate-500">（未获取到 id）</span>
                      )}
                    </div>
                    <button onClick={() => handleRemoveProviderModel(index)} disabled={providerModels.length === 1} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 cursor-pointer shrink-0"><Trash2 className="w-4 h-4" /></button>
                  </div>

                  <div>
                    <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">能力</div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div>
                        <select value={model.api ?? ''} onChange={(e) => updateProviderModel(index, { api: e.target.value })} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950">
                          <option value="">api（继承提供商）</option>
                          <option value="openai-completions">openai-completions</option>
                          <option value="openai-responses">openai-responses</option>
                          <option value="anthropic-messages">anthropic-messages</option>
                          <option value="google-generative-ai">google-generative-ai</option>
                        </select>
                      </div>
                      <div className="flex flex-wrap gap-4 pt-1">
                        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={model.reasoning} onChange={(e) => updateProviderModel(index, { reasoning: e.target.checked })} /> reasoning</label>
                        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={model.inputImage} onChange={(e) => updateProviderModel(index, { inputImage: e.target.checked })} /> inputImage</label>
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">input（可选）</label>
                        <div className="flex flex-wrap gap-4">
                          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={model.input?.includes('text') ?? false} onChange={(e) => {
                            const current = model.input ?? [];
                            const next = e.target.checked ? [...current, 'text'] : current.filter((t) => t !== 'text');
                            updateProviderModel(index, { input: next.length > 0 ? next : undefined });
                          }} /> text</label>
                          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={model.input?.includes('image') ?? false} onChange={(e) => {
                            const current = model.input ?? [];
                            const next = e.target.checked ? [...current, 'image'] : current.filter((t) => t !== 'image');
                            updateProviderModel(index, { input: next.length > 0 ? next : undefined });
                          }} /> image</label>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">参数</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <Select
                          value={getContextPresetValue(model.contextWindow)}
                          onChange={(v) => handleContextPresetChange(index, v)}
                          options={CONTEXT_PRESET_OPTIONS}
                          placeholder="contextWindow（可选）"
                          className="w-full"
                        />
                        {(contextCustomModes[index] || getContextPresetValue(model.contextWindow) === 'custom') && (
                          <input
                            value={model.contextWindow ?? ''}
                            onChange={(e) => handleContextWindowChange(index, e.target.value)}
                            type="number"
                            placeholder="自定义 contextWindow"
                            className="w-full px-3 py-2 mt-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                          />
                        )}
                      </div>
                      <input value={model.maxTokens ?? ''} onChange={(e) => updateProviderModel(index, { maxTokens: e.target.value ? Number(e.target.value) : undefined })} type="number" placeholder="maxTokens（可选）" className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950" />
                    </div>
                  </div>

                  <div>
                    <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">价格</div>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                      <input value={model.cost?.input ?? ''} onChange={(e) => updateProviderModel(index, { cost: { ...model.cost, input: e.target.value ? Number(e.target.value) : undefined } })} type="number" step="0.01" min="0" placeholder="cost.input" className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950" />
                      <input value={model.cost?.output ?? ''} onChange={(e) => updateProviderModel(index, { cost: { ...model.cost, output: e.target.value ? Number(e.target.value) : undefined } })} type="number" step="0.01" min="0" placeholder="cost.output" className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950" />
                      <input value={model.cost?.cacheRead ?? ''} onChange={(e) => updateProviderModel(index, { cost: { ...model.cost, cacheRead: e.target.value ? Number(e.target.value) : undefined } })} type="number" step="0.01" min="0" placeholder="cost.cacheRead" className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950" />
                      <input value={model.cost?.cacheWrite ?? ''} onChange={(e) => updateProviderModel(index, { cost: { ...model.cost, cacheWrite: e.target.value ? Number(e.target.value) : undefined } })} type="number" step="0.01" min="0" placeholder="cost.cacheWrite" className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950" />
                    </div>
                  </div>

                  <div>
                    <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">高级</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">compat（可选）</label>
                        <textarea value={model.compat ?? ''} onChange={(e) => handleModelCompatChange(index, e.target.value)} placeholder='例：{ &quot;forceAdaptiveThinking&quot;: true, &quot;thinkingFormat&quot;: &quot;deepseek&quot; }' rows={2} className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950 font-mono" />
                        {modelJsonErrors[index]?.compat && <div className="text-[10px] text-red-500 dark:text-red-400 mt-1">JSON 格式错误</div>}
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">thinkingLevelMap（可选）</label>
                        <Select
                          value={getThinkingPresetValue(model.thinkingLevelMap)}
                          onChange={(v) => handleThinkingPresetChange(index, v)}
                          options={THINKING_PRESET_OPTIONS}
                          placeholder="选择预设"
                          className="w-full"
                        />
                        {(thinkingCustomModes[index] || getThinkingPresetValue(model.thinkingLevelMap) === 'custom') && (
                          <>
                            <textarea value={model.thinkingLevelMap ?? ''} onChange={(e) => handleModelThinkingChange(index, e.target.value)} placeholder='例：{ &quot;off&quot;: null, &quot;medium&quot;: &quot;medium&quot;, &quot;high&quot;: &quot;high&quot; }' rows={2} className="w-full mt-2 px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950 font-mono" />
                            {modelJsonErrors[index]?.thinking && <div className="text-[10px] text-red-500 dark:text-red-400 mt-1">JSON 格式错误</div>}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {providerError && <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-lg px-3 py-2">{providerError}</div>}
            {providerTestResult && <div className="text-xs text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900 rounded-lg px-3 py-2">{providerTestResult}</div>}

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-150 dark:border-slate-800">
              <button onClick={handleClose} className="px-3 py-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer">取消</button>
              <button onClick={handleTestProvider} disabled={testProviderMut.isPending} className="px-4 py-1.5 text-xs font-semibold border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer disabled:opacity-50">{testProviderMut.isPending ? '拉取中…' : '拉取模型列表'}</button>
              <button onClick={handleSaveProvider} disabled={createProviderMut.isPending} className="px-4 py-1.5 text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 rounded-lg shadow-2xs transition cursor-pointer disabled:opacity-50">{createProviderMut.isPending ? '保存中…' : '保存'}</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
