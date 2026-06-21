import { describe, expect, test, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { SessionInfoPanel } from '../session-info-panel';

describe('SessionInfoPanel', () => {
  afterEach(() => cleanup());

  test('renders without crashing with no data', () => {
    const { container } = render(<SessionInfoPanel />);
    expect(container.querySelector('h3')).toBeTruthy();
  });

  test('renders session title in overview', () => {
    const info = {
      session: { id: 's1', title: 'My Test Session', project_id: 'p1', parent_session_id: null,
        root_session_id: 's1', created_by: 'x', created_at: '2026-01-01T00:00:00Z', archived_at: null,
        pi_session_id: 'pi_a', pi_session_locator_json: '{}', current_model: null, status: 'active', runtime_status: 'idle' },
      project: { id: 'p1', name: 'Demo' },
      lineage: { parent_session: null, root_session: { id: 's1', title: 'My Test Session' }, depth: 0 },
      role_template: { key: 'planner', version: '1', name: 'Planner' },
      prompts: { role_base_prompt_snapshot: '', user_supplied_prompt: '', parent_supplied_prompt: '', compiled_prompt: '' },
      sync: { sync_status: 'idle', last_synced_at: null, last_pi_message_id: null, last_error: null, retry_count: 0 },
      recent_events: [],
    } as any;
    render(<SessionInfoPanel info={info} />);
    const titleElements = screen.getAllByText('My Test Session');
    expect(titleElements.length).toBeGreaterThanOrEqual(1);
  });

  test('title metric is clickable when onTitleChanged is provided', () => {
    const onTitleChanged = async () => {};
    const info = {
      session: { id: 's1', title: 'Click Me', project_id: 'p1', parent_session_id: null,
        root_session_id: 's1', created_by: 'x', created_at: '2026-01-01T00:00:00Z', archived_at: null,
        pi_session_id: 'pi_a', pi_session_locator_json: '{}', current_model: null, status: 'active', runtime_status: 'idle' },
      project: { id: 'p1', name: 'Demo' },
      lineage: { parent_session: null, root_session: { id: 's1', title: 'Click Me' }, depth: 0 },
      role_template: { key: 'planner', version: '1', name: 'Planner' },
      prompts: { role_base_prompt_snapshot: '', user_supplied_prompt: '', parent_supplied_prompt: '', compiled_prompt: '' },
      sync: { sync_status: 'idle', last_synced_at: null, last_pi_message_id: null, last_error: null, retry_count: 0 },
      recent_events: [],
    } as any;
    const { container } = render(<SessionInfoPanel info={info} onTitleChanged={onTitleChanged} />);
    const buttons = container.querySelectorAll('button[title="点击编辑标题"]');
    expect(buttons.length).toBe(1);
  });
});
