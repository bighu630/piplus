import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { ChatPanel } from '../chat-panel';

describe('ChatPanel model picker', () => {
  test('disables model picker when session is not idle', () => {
    render(
      <ChatPanel
        messages={[]}
        sessionTitle="项目A · 负责人"
        models={[
          { provider: 'deepseek', id: 'v4-flash', label: 'DeepSeek V4 Flash' },
        ]}
        modelLabel="DeepSeek V4 Flash"
        modelDisabled={true}
      />,
    );
    const button = screen.getByRole('button', { name: /DeepSeek V4 Flash/i });
    expect(button.disabled).toBe(true);
  });
});
