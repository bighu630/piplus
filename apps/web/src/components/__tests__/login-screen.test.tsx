import { describe, expect, test, mock, afterEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { LoginScreen } from '../login-screen';

describe('LoginScreen', () => {
  afterEach(() => cleanup());

  test('renders email and password fields with defaults', () => {
    const onSubmit = mock(() => {});
    render(<LoginScreen onSubmit={onSubmit} />);
    const inputs = screen.getAllByDisplayValue(/seed/);
    expect(inputs.length).toBeGreaterThanOrEqual(1);
  });

  test('calls onSubmit with email and password', () => {
    const calls: string[][] = [];
    const onSubmit = async (email: string, password: string) => { calls.push([email, password]); };
    render(<LoginScreen onSubmit={onSubmit} />);

    const btn = screen.getByText('登录');
    fireEvent.click(btn);
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toBe('seed@local');
    expect(calls[0]?.[1]).toBe('seed123');
  });

  test('shows error message when error prop is set', () => {
    const onSubmit = mock(() => {});
    render(<LoginScreen error="测试错误信息" onSubmit={onSubmit} />);
    expect(screen.getByText('测试错误信息')).toBeTruthy();
  });
});
