import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createPiClient } from '@piplus/pi-client';
import type { PiModelInfo } from '@piplus/pi-client';
import { sessions } from '@piplus/db/schema';

function getPiplusModelsFilePath() {
  const configDir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'piplus')
    : path.join(process.env.HOME || homedir(), '.config', 'piplus');
  return path.join(configDir, 'piplus-models.json');
}

function getPiModelsFilePath() {
  return path.join(process.env.HOME || homedir(), '.pi', 'agent', 'models.json');
}

async function readModelCapabilitiesFromFile(filePath: string, provider: string, id: string) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      providers?: Record<string, { models?: Array<{ id?: string; input?: string[] }> }>;
    };
    const models = parsed.providers?.[provider]?.models;
    const matched = models?.find((candidate) => candidate.id === id);
    return matched?.input;
  } catch {
    return undefined;
  }
}

async function readModelCapabilities(provider: string, id: string) {
  const piplusInput = await readModelCapabilitiesFromFile(getPiplusModelsFilePath(), provider, id);
  if (piplusInput) return piplusInput;
  return readModelCapabilitiesFromFile(getPiModelsFilePath(), provider, id);
}

export async function resolveSessionModelWithCapabilities(piClient: ReturnType<typeof createPiClient>, session: typeof sessions.$inferSelect) {
  const runtimeModel = await piClient.getCurrentModel(session.id);
  const model = runtimeModel ?? (session.currentModelProvider && session.currentModelId
    ? { provider: session.currentModelProvider, id: session.currentModelId, label: session.currentModelId }
    : null);
  if (!model) return null;

  const availableModels = await piClient.listAvailableModels();
  const matched = availableModels.find((candidate: any) => candidate.provider === model.provider && candidate.id === model.id) as (PiModelInfo & { input?: string[] }) | undefined;
  const input = matched?.input ?? await readModelCapabilities(model.provider, model.id);
  return input ? { ...model, input } : (matched ?? model);
}

export function modelSupportsImageInput(model: (PiModelInfo & { input?: string[] }) | null) {
  return Array.isArray(model?.input) && model!.input.includes('image');
}
