import { describe, expect, test } from 'bun:test';
import { formatBashCommand } from './format-bash-command';

describe('formatBashCommand', () => {
  test('&& 链断行并缩进（操作符置于行首）', () => {
    expect(formatBashCommand('cd /app && npm run build && echo done')).toBe(
      ['cd /app', '  && npm run build', '  && echo done'].join('\n'),
    );
  });

  test('管道 | 断行；|| 与 | 正确区分', () => {
    expect(formatBashCommand('cat file | grep foo | wc -l')).toBe(
      ['cat file', '  | grep foo', '  | wc -l'].join('\n'),
    );
    expect(formatBashCommand('a || b | c')).toBe(['a', '  || b', '  | c'].join('\n'));
  });

  test('分号断行（含 ;; 分支写法）', () => {
    expect(formatBashCommand('echo a; echo b')).toBe(['echo a', '  ; echo b'].join('\n'));
    expect(formatBashCommand('case x in a) y ;; esac')).toBe(['case x in a) y', '  ; esac'].join('\n'));
  });

  test('引号内的分隔符不处理', () => {
    expect(formatBashCommand('echo "a && b | c; d"')).toBe('echo "a && b | c; d"');
    expect(formatBashCommand("echo 'x && y'")).toBe("echo 'x && y'");
    expect(formatBashCommand('echo `a && b`')).toBe('echo `a && b`');
    expect(formatBashCommand('echo "esc \\" && still inside"')).toBe('echo "esc \\" && still inside"');
  });

  test('单个 & （后台任务）不作为分隔符', () => {
    expect(formatBashCommand('sleep 1 & echo hi')).toBe('sleep 1 & echo hi');
  });

  test('保留原始多行结构', () => {
    expect(formatBashCommand('line1\nline2')).toBe('line1\nline2');
    expect(formatBashCommand('echo a\necho b && echo c')).toBe(
      ['echo a', 'echo b', '  && echo c'].join('\n'),
    );
  });

  test('空命令与纯空白', () => {
    expect(formatBashCommand('')).toBe('');
    expect(formatBashCommand('   ')).toBe('');
  });

  test('折叠多余空行', () => {
    expect(formatBashCommand('\n\necho hi\n\n')).toBe('echo hi');
  });

  test('保留原有行首缩进（多行脚本结构）', () => {
    expect(formatBashCommand('  echo a && echo b')).toBe(['  echo a', '  && echo b'].join('\n'));
  });
});
