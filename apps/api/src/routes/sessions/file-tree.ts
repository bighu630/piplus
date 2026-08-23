import { readdir } from 'node:fs/promises';
import path from 'node:path';

export const MAX_FILE_TREE_DEPTH = 6;
export const MAX_FILE_CONTENT_BYTES = 1024 * 1024;
export const MAX_FILE_WRITE_BYTES = 1024 * 1024;

export const TEXT_FILE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.css', '.scss', '.sass', '.less', '.html', '.htm', '.mdx', '.jsonc', '.postcss',
  '.yml', '.yaml', '.xml', '.svg', '.sh', '.bash', '.zsh', '.env', '.toml', '.ini', '.conf', '.config', '.sql', '.py', '.rb', '.pyi', '.kts', '.scala', '.zig', '.dart', '.lua', '.r', '.jl', '.ex', '.exs', '.erl', '.hrl', '.clj', '.cljs', '.graphql', '.gql', '.proto',
  '.rs', '.go', '.java', '.kt', '.swift', '.php', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.vue', '.svelte', '.astro', '.sol', '.vy', '.move', '.cairo', '.abi',
  '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.prettierignore', '.prettierrc', '.eslintrc', '.eslintignore', '.dockerignore', '.env.example', '.nvmrc', '.babelrc',
  '.fish', '.ps1', '.bat', '.cmd',
]);
export const IGNORED_ENTRY_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.turbo', 'coverage']);

export function isTextFilePath(filePath: string) {
  const baseName = path.basename(filePath).toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_FILE_EXTENSIONS.has(baseName) || TEXT_FILE_EXTENSIONS.has(ext) || !path.basename(filePath).includes('.');
}

export function looksLikeBinary(buffer: Buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;

  let suspiciousBytes = 0;
  for (const byte of sample) {
    const isPrintableAscii = byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126);
    const isCommonUtf8LeadOrContinuation = byte >= 128;
    if (!isPrintableAscii && !isCommonUtf8LeadOrContinuation) {
      suspiciousBytes += 1;
    }
  }

  return sample.length > 0 && suspiciousBytes / sample.length > 0.1;
}

// 注意：此模块级 buildFileTree 在原文件中已被 registerSessionRoutes 内的同名函数遮蔽（未被调用），
// 按纯重构要求逐字保留。
export async function buildFileTree(rootPath: string, relativePath = '', depth = 0): Promise<Array<{ name: string; path: string; kind: 'file' | 'directory'; children?: any[] }>> {
  if (depth > MAX_FILE_TREE_DEPTH) return [];
  const absoluteDir = relativePath ? path.join(rootPath, relativePath) : rootPath;
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const visible = entries
    .filter((entry) => !IGNORED_ENTRY_NAMES.has(entry.name) && !entry.name.startsWith('.DS_Store'))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  const nodes = await Promise.all(visible.map(async (entry) => {
    const entryRelativePath = relativePath ? path.posix.join(relativePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      return {
        name: entry.name,
        path: entryRelativePath,
        kind: 'directory' as const,
        children: await buildFileTree(rootPath, entryRelativePath, depth + 1),
      };
    }
    return {
      name: entry.name,
      path: entryRelativePath,
      kind: 'file' as const,
    };
  }));

  return nodes;
}
