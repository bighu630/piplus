/**
 * bash 命令的展示格式化：在顶层分隔符（`&&` / `||` / `|` / `;`）处断行并缩进，
 * 让长命令在卡片里更易读。
 *
 * - 引号（' " `）与反斜杠转义内的分隔符不处理，避免破坏语义
 * - 单个 `&`（后台任务）不作为分隔符
 * - 只做展示，**不添加续行符**：格式化结果不保证可直接粘贴执行；需要执行请复制原始命令
 *
 * 已知展示限制（仅影响可读性；复制始终使用原始命令）：
 * - 命令替换 `$(...)`、`case` 模式列表中的 `|`、heredoc 正文、`#` 注释内的分隔符也会被断行
 * - 未闭合引号：保守处理（不进入引号外的断行逻辑）
 */
export function formatBashCommand(command: string): string {
  const INDENT = '  ';
  const lines: string[] = [];
  let current = '';
  let inSingle = false;
  let inAnsiSingle = false; // $'...'（ANSI-C quoting：内部反斜杠参与转义）
  let inDouble = false;
  let inBacktick = false;
  let escaped = false;

  const breakLine = (operator: string) => {
    const head = current.trimEnd();
    if (head !== '') lines.push(head);
    current = INDENT + operator;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    // 转义：普通单引号内是字面量；$'...'、双引号、反引号与裸命令中参与转义
    if (ch === '\\' && (inAnsiSingle || !inSingle)) {
      current += ch;
      escaped = true;
      continue;
    }

    // $'...' 起始（ANSI-C quoting）
    if (!inSingle && !inDouble && !inBacktick && !inAnsiSingle && ch === '$' && command[i + 1] === "'") {
      inAnsiSingle = true;
      current += "$'";
      i++;
      continue;
    }
    if (inAnsiSingle) {
      if (ch === "'") inAnsiSingle = false;
      current += ch;
      continue;
    }

    if (!inDouble && !inBacktick && ch === "'") {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (!inSingle && !inBacktick && ch === '"') {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble && ch === '`') {
      inBacktick = !inBacktick;
      current += ch;
      continue;
    }

    // 引号内的内容原样保留（含换行）
    if (inSingle || inDouble || inBacktick) {
      current += ch;
      continue;
    }

    if (ch === '&' && command[i + 1] === '&') {
      breakLine('&&');
      i++;
      continue;
    }
    if (ch === '|' && command[i + 1] === '|') {
      breakLine('||');
      i++;
      continue;
    }
    if (ch === '|') {
      breakLine('|');
      continue;
    }
    if (ch === ';') {
      // case 终止符（`;;` / `;&` / `;;&`）整体保留，避免展示时被改写
      let operator = ';';
      while (command[i + 1] === ';') {
        operator += ';';
        i++;
      }
      if (command[i + 1] === '&') {
        operator += '&';
        i++;
      }
      breakLine(operator);
      continue;
    }

    if (ch === '\n') {
      // 原始换行：保留（去掉行尾空白）
      lines.push(current.trimEnd());
      current = '';
      continue;
    }

    current += ch;
  }

  const tail = current.trimEnd();
  if (tail !== '') lines.push(tail);

  // 折叠首尾与连续空行
  const cleaned: string[] = [];
  for (const line of lines) {
    if (line === '' && (cleaned.length === 0 || cleaned[cleaned.length - 1] === '')) continue;
    cleaned.push(line);
  }
  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') cleaned.pop();
  return cleaned.join('\n');
}
