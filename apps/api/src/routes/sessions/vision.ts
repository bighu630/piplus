import { createDb } from '@piplus/db/client';
import { messageInjections } from '@piplus/db/schema';
import { createPiClient } from '@piplus/pi-client';
import type { PiContentBlock, PiImageInput } from '@piplus/pi-client';
import { MERGED_USER_MESSAGE_SEPARATOR } from '@piplus/domain';
import { randomId, nextMessageTime, log, MAX_CHAT_IMAGE_ATTACHMENTS, ALLOWED_IMAGE_MIME_TYPES } from './shared';

/** 剥离顶层会话（planner/blank）首条消息时运行时注入的角色提示词前缀（见 @piplus/domain session/runtime.ts 的 merge 逻辑）。
 *  使用 lastIndexOf 取最后出现处，保证内容本身含分隔串时也只剥离一次注入前缀 */
export function stripMergedPromptPrefix(text: string): string {
  const idx = text.lastIndexOf(MERGED_USER_MESSAGE_SEPARATOR);
  if (idx === -1) return text;
  return text.slice(idx + MERGED_USER_MESSAGE_SEPARATOR.length);
}

type ChatImageAttachmentInput = {
  type?: string;
  mime_type?: string;
  data_base64?: string;
  filename?: string | null;
};

export function normalizeImageAttachments(raw: unknown) {
  if (raw == null) return [] as ChatImageAttachmentInput[];
  if (!Array.isArray(raw)) throw new Error('invalid_attachments');
  return raw as ChatImageAttachmentInput[];
}

export function parseImageAttachments(raw: unknown) {
  const attachments = normalizeImageAttachments(raw);
  if (attachments.length > MAX_CHAT_IMAGE_ATTACHMENTS) {
    return { error: { code: 'TOO_MANY_ATTACHMENTS', message: `At most ${MAX_CHAT_IMAGE_ATTACHMENTS} images are allowed` }, status: 400 as const };
  }

  const images: PiImageInput[] = [];
  const blocks: PiContentBlock[] = [];
  for (const attachment of attachments) {
    if (attachment?.type !== 'image') {
      return { error: { code: 'INVALID_ATTACHMENT_TYPE', message: 'Only image attachments are supported' }, status: 400 as const };
    }

    const mimeType = String(attachment.mime_type ?? '').trim().toLowerCase();
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
      return { error: { code: 'UNSUPPORTED_IMAGE_MIME_TYPE', message: 'Unsupported image MIME type' }, status: 400 as const };
    }

    const data = String(attachment.data_base64 ?? '').trim();
    if (!data) {
      return { error: { code: 'INVALID_IMAGE_DATA', message: 'Image data is required' }, status: 400 as const };
    }

    try {
      const buffer = Buffer.from(data, 'base64');
      if (!buffer.byteLength || buffer.toString('base64') !== data.replace(/\s+/g, '')) {
        return { error: { code: 'INVALID_IMAGE_DATA', message: 'Image data must be valid base64' }, status: 400 as const };
      }
    } catch {
      return { error: { code: 'INVALID_IMAGE_DATA', message: 'Image data must be valid base64' }, status: 400 as const };
    }

    const filename = typeof attachment.filename === 'string' && attachment.filename.trim() ? attachment.filename.trim() : null;
    images.push({ dataBase64: data, mimeType, mediaType: mimeType, filename: filename ?? undefined });
    blocks.push({ type: 'image', mimeType, mediaType: mimeType, filename, uri: null, dataBase64: data });
  }

  return { images, blocks };
}

// ---------- vision relay（实验性：多模态模型识别图片后转发给文本模型） ----------

const VISION_SYSTEM_PROMPT = [
  '你是一个图片识别助手。请结合用户的提示词，尽可能详细、准确地描述图片中的内容，',
  '包括所有可见的文本（逐字转写代码、界面文字、报错信息）、图表、界面元素、布局与关键细节。',
  '你的描述将代替图片交给另一个文本模型继续处理，请确保信息完整、不遗漏重要内容。',
  '只输出描述内容本身，不要客套话。',
].join('');

const VISION_RELAY_TIMEOUT_MS = 90_000;

/** 解析 'provider/id' 形式的模型引用；'a/b/c' → provider 'a'、id 'b/c'；非法引用返回 null。 */
export function parseModelRef(raw: string | null): { provider: string; id: string } | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slashIndex), id: trimmed.slice(slashIndex + 1) };
}

function modelRefLabel(ref: { provider: string; id: string } | null): string {
  return ref ? `${ref.provider}/${ref.id}` : '未配置';
}

type VisionPiClient = Pick<ReturnType<typeof createPiClient>, 'completeModel'>;

/** 用单个多模态模型识别图片；失败抛错（超时/网络/空响应均视为失败）。signal 由 describeImagesWithFallback 传入，共享总超时预算。 */
async function describeImagesWithModel(
  piClient: VisionPiClient,
  ref: { provider: string; id: string },
  content: string,
  images: PiImageInput[],
  signal: AbortSignal,
): Promise<string> {
  const result = await piClient.completeModel({
    provider: ref.provider,
    id: ref.id,
    systemPrompt: VISION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: content || '（无文本提示，请直接描述图片内容）', images }],
    signal,
  });
  // 把模型返回的错误明细计入抛错信息，便于日志排查
  if (result.stopReason === 'error' && result.errorMessage) {
    throw new Error(`模型调用失败：${result.errorMessage}`);
  }
  const text = result.text.trim();
  if (!text) throw new Error('多模态模型返回了空响应');
  return text;
}

/** 主 → 备回退调用（共享 VISION_RELAY_TIMEOUT_MS 总超时预算）；全部失败返回 { ok: false, error }。 */
export async function describeImagesWithFallback(
  piClient: VisionPiClient,
  primary: { provider: string; id: string },
  fallback: { provider: string; id: string } | null,
  content: string,
  images: PiImageInput[],
): Promise<{ ok: true; description: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VISION_RELAY_TIMEOUT_MS);
  try {
    for (const ref of fallback ? [primary, fallback] : [primary]) {
      try {
        const description = await describeImagesWithModel(piClient, ref, content, images, controller.signal);
        return { ok: true, description };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.info('vision relay model failed', { model: modelRefLabel(ref), reason });
      }
    }
    return { ok: false, error: '主备多模态模型均不可用' };
  } finally {
    clearTimeout(timeout);
  }
}

/** 图片描述与用户文本合并（描述追加在文本后；纯图片消息仅描述）。 */
/** 图片描述合并进用户消息时的标记前缀（GET /chat/messages 据此识别并替换回原始消息）。 */
export const VISION_MERGED_MARKER = '[图片内容识别]';

export function buildVisionMergedContent(content: string, description: string): string {
  const desc = `${VISION_MERGED_MARKER}\n${description}`;
  return content ? `${content}\n\n${desc}` : desc;
}

/** 解析落库的 contentBlocksJson（PiContentBlock[]）；非法/空返回 null。 */
export function parseStoredContentBlocks(json: string | null): PiContentBlock[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as PiContentBlock[]) : null;
  } catch {
    return null;
  }
}

/** 主备都失败：插入 error 历史消息（用户可见），返回用户友好的错误文案。 */
export async function insertVisionFailureMessage(
  db: ReturnType<typeof createDb>,
  sessionId: string,
  primary: { provider: string; id: string },
  fallback: { provider: string; id: string } | null,
  reason: string,
) {
  const messageId = randomId('message');
  const now = nextMessageTime();
  await db.insert(messageInjections).values({
    id: messageId,
    sessionId,
    messageKind: 'error',
    role: 'assistant',
    contentText: `图片识别失败，消息未发送。多模态识别模型（主：${modelRefLabel(primary)}，备：${modelRefLabel(fallback)}）${reason}。你可以稍后重试，或切换到支持图片的模型直接发送。`,
    contentBlocksJson: null,
    createdAt: now,
  } as any);
  log.info('vision relay failed, inserted error message', { sessionId, messageId });
}
