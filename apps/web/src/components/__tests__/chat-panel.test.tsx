import { describe, expect, test, mock, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { ChatPanel } from '../chat-panel';

describe('ChatPanel', () => {
  afterEach(() => cleanup());

  test('shows fallback message when no messages', () => {
    render(<ChatPanel />);
    expect(screen.getByText(/当前 session 暂时还没有消息/)).toBeTruthy();
  });

  test('shows disabled message when disabled', () => {
    render(<ChatPanel disabled />);
    expect(screen.getByText(/先在左侧选择一个 session/)).toBeTruthy();
  });

  test('shows session title in header', () => {
    render(<ChatPanel sessionTitle="My Chat" />);
    expect(screen.getByText('Chat · My Chat')).toBeTruthy();
  });

  test('renders stop button in armed state', () => {
    render(<ChatPanel stopArmed stopDisabled={false} />);
    expect(screen.getByText('按 Esc 执行停止')).toBeTruthy();
  });

  test('renders messages', () => {
    const messages = [
      { id: '1', role: 'user', message_kind: 'normal', source_session_id: null, content_text: 'Hello', created_at: '2026-01-01T00:00:00Z' },
      { id: '2', role: 'assistant', message_kind: 'normal', source_session_id: null, content_text: 'Hi there', created_at: '2026-01-01T00:00:01Z' },
    ] as any;

    render(<ChatPanel messages={messages} />);
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByText('Hi there')).toBeTruthy();
  });

  test('shows load more button when canLoadMore', () => {
    render(<ChatPanel canLoadMore />);
    expect(screen.getByText('加载更早消息')).toBeTruthy();
  });
});
