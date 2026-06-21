import { describe, expect, test, mock, afterEach } from 'bun:test';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { LoginScreen } from '../login-screen';

describe('LoginScreen', () => {
  afterEach(() => cleanup());

  test('renders password field', () => {
    const onSubmit = mock(() => {});
    render(<LoginScreen onSubmit={onSubmit} />);
    const input = screen.getByDisplayValue('');
    expect(input.getAttribute('type')).toBe('password');
  });

  test('calls onSubmit with password', () => {
    let submitted = '';
    const onSubmit = async (password: string) => { submitted = password; };
    render(<LoginScreen onSubmit={onSubmit} />);

    const input = screen.getByDisplayValue('');
    fireEvent.change(input, { target: { value: 'test123' } });
    const btn = screen.getByText('登录');
    fireEvent.click(btn);
    expect(submitted).toBe('test123');
  });

  test('shows error message when error prop is set', () => {
    const onSubmit = mock(() => {});
    render(<LoginScreen error="测试错误信息" onSubmit={onSubmit} />);
    expect(screen.getByText('测试错误信息')).toBeTruthy();
  });
});
