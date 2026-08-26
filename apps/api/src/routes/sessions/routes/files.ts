import type { Hono } from 'hono';
import { readdir, readFile, stat, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { IMAGE_MIME_MAP, MAX_IMAGE_SIZE_BYTES } from '../shared';
import { MAX_FILE_CONTENT_BYTES, MAX_FILE_WRITE_BYTES, IGNORED_ENTRY_NAMES, isTextFilePath, looksLikeBinary } from '../file-tree';
import { resolveProjectDir, resolveSafeFilePath } from '../project-fs';

async function buildFileTree(
  rootDir: string,
  currentDir = rootDir,
): Promise<Array<{ name: string; path: string; kind: 'file' | 'directory'; children?: any[] }>> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const visibleEntries = entries
    .filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules')
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return Promise.all(visibleEntries.map(async (entry) => {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      return {
        name: entry.name,
        path: relativePath,
        kind: 'directory' as const,
        children: await buildFileTree(rootDir, absolutePath),
      };
    }
    return {
      name: entry.name,
      path: relativePath,
      kind: 'file' as const,
    };
  }));
}

export function registerFilesRoutes(app: Hono) {
  app.get('/api/v1/sessions/:sessionId/files/tree', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    const tree = await buildFileTree(cwd);
    return c.json({ session_id: sessionId, root_path: cwd, tree });
  });

  app.get('/api/v1/sessions/:sessionId/files/content', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const relativePath = String(c.req.query('path') ?? '').trim();
    if (!relativePath) {
      return c.json({ error: { code: 'INVALID_PATH', message: 'File path is required' } }, 400);
    }

    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;
    const absolutePath = path.resolve(cwd, relativePath);
    const relativeToRoot = path.relative(cwd, absolutePath);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      return c.json({ error: { code: 'INVALID_PATH', message: 'Path is outside project root' } }, 400);
    }
    if (!isTextFilePath(absolutePath)) {
      return c.json({ error: { code: 'UNSUPPORTED_FILE', message: 'Only text file preview is supported' } }, 400);
    }

    const buffer = await readFile(absolutePath);
    if (looksLikeBinary(buffer)) {
      return c.json({ error: { code: 'UNSUPPORTED_FILE', message: 'Binary file preview is not supported' } }, 400);
    }

    const truncated = buffer.byteLength > MAX_FILE_CONTENT_BYTES;
    const content = buffer.subarray(0, MAX_FILE_CONTENT_BYTES).toString('utf8');
    return c.json({ session_id: sessionId, path: relativePath, content, truncated });
  });

  app.get('/api/v1/sessions/:sessionId/files/image', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const relativePath = String(c.req.query('path') ?? '').trim();
    if (!relativePath) {
      return c.json({ error: { code: 'INVALID_PATH', message: 'File path is required' } }, 400);
    }

    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    const absolutePath = resolveSafeFilePath(cwd, relativePath);
    if (!absolutePath) {
      return c.json({ error: { code: 'INVALID_PATH', message: 'Path is outside project root' } }, 400);
    }

    const ext = path.extname(absolutePath).toLowerCase();
    const mimeType = IMAGE_MIME_MAP[ext];
    if (!mimeType) {
      return c.json({ error: { code: 'UNSUPPORTED_IMAGE_TYPE', message: 'File type is not supported as image' } }, 400);
    }

    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch {
      return c.json({ error: { code: 'NOT_FOUND', message: 'File not found' } }, 404);
    }

    if (!fileStat.isFile()) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'File not found' } }, 404);
    }

    if (fileStat.size > MAX_IMAGE_SIZE_BYTES) {
      return c.json({ error: { code: 'FILE_TOO_LARGE', message: 'Image file exceeds maximum allowed size' } }, 413);
    }

    const buffer = await readFile(absolutePath);
    return c.newResponse(buffer, 200, {
      'Content-Type': mimeType,
      'Content-Length': String(buffer.byteLength),
      'Cache-Control': 'private, max-age=3600',
    });
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/files/content:
   *   put:
   *     summary: 保存文件内容
   *     tags: [Sessions, Files]
   *     security:
   *       - bearerAuth: []
   *     description: 将内容写入指定文件。仅支持文本文件，大小不超过 1MB。
   *     responses:
   *       200:
   *         description: 保存成功。
   *       400:
   *         description: 路径不合法、非文本文件、大小超限。
   *       404:
   *         description: 会话不存在或无访问权限。
   */
  app.put('/api/v1/sessions/:sessionId/files/content', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const body = await c.req.json().catch(() => ({}));
    const relativePath = String((body as { path?: string }).path ?? '').trim();
    const content = (body as { content?: string }).content ?? '';

    if (!relativePath) {
      return c.json({ error: { code: 'INVALID_PATH', message: 'File path is required' } }, 400);
    }

    if (typeof content !== 'string') {
      return c.json({ error: { code: 'INVALID_CONTENT', message: 'Content must be a string' } }, 400);
    }

    const contentBytes = Buffer.from(content, 'utf8');
    if (contentBytes.byteLength > MAX_FILE_WRITE_BYTES) {
      return c.json({ error: { code: 'CONTENT_TOO_LARGE', message: `Content exceeds maximum size of ${MAX_FILE_WRITE_BYTES} bytes` } }, 413);
    }

    // Auth & resolve project root
    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    // Path safety
    const absolutePath = resolveSafeFilePath(cwd, relativePath);
    if (!absolutePath) {
      return c.json({ error: { code: 'INVALID_PATH', message: 'Path is outside project root' } }, 400);
    }

    // Check for ignored directories
    const pathSegments = absolutePath.replace(cwd, '').split(/[/\\]/).filter(Boolean);
    const hasIgnoredSegment = pathSegments.some((seg) => IGNORED_ENTRY_NAMES.has(seg));
    if (hasIgnoredSegment) {
      return c.json({ error: { code: 'INVALID_PATH', message: 'Cannot write to ignored directories (.git, node_modules, etc.)' } }, 400);
    }

    // Must not be a directory
    const fileStat = await stat(absolutePath).catch(() => null);
    if (!fileStat) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'File not found' } }, 404);
    }
    if (fileStat.isDirectory()) {
      return c.json({ error: { code: 'IS_DIRECTORY', message: 'Cannot write to a directory' } }, 400);
    }

    // Only allow text file extensions
    if (!isTextFilePath(absolutePath)) {
      return c.json({ error: { code: 'UNSUPPORTED_FILE', message: 'Only text file editing is supported' } }, 400);
    }

    // Also check the written content doesn't look binary
    if (looksLikeBinary(contentBytes)) {
      return c.json({ error: { code: 'UNSUPPORTED_FILE', message: 'Binary content is not supported' } }, 400);
    }

    await writeFile(absolutePath, content, 'utf8');
    return c.json({ session_id: sessionId, path: relativePath, size: contentBytes.byteLength });
  });

  /**
   * DELETE /api/v1/sessions/{sessionId}/files/content
   * Deletes a file. Request body: { path: string }
   */
  app.delete('/api/v1/sessions/:sessionId/files/content', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const body = await c.req.json().catch(() => ({}));
    const relativePath = String((body as { path?: string }).path ?? '').trim();

    if (!relativePath) {
      return c.json({ error: { code: 'INVALID_PATH', message: 'File path is required' } }, 400);
    }

    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    const absolutePath = resolveSafeFilePath(cwd, relativePath);
    if (!absolutePath) {
      return c.json({ error: { code: 'INVALID_PATH', message: 'Path is outside project root' } }, 400);
    }

    const pathSegments = absolutePath.replace(cwd, '').split(/[/\\]/).filter(Boolean);
    const hasIgnoredSegment = pathSegments.some((seg) => IGNORED_ENTRY_NAMES.has(seg));
    if (hasIgnoredSegment) {
      return c.json({ error: { code: 'INVALID_PATH', message: 'Cannot delete from ignored directories (.git, node_modules, etc.)' } }, 400);
    }

    const fileStat = await stat(absolutePath).catch(() => null);
    if (!fileStat) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'File not found' } }, 404);
    }
    if (fileStat.isDirectory()) {
      return c.json({ error: { code: 'IS_DIRECTORY', message: 'Cannot delete a directory' } }, 400);
    }

    await unlink(absolutePath);
    return c.json({ session_id: sessionId, path: relativePath, result: 'deleted' });
  });
}
