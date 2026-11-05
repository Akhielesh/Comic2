import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatRail } from './rails';

describe('ChatRail composer · IME-safe Enter', () => {
  it('the Enter that confirms an IME candidate picks the word; only a plain Enter sends', () => {
    const onSend = vi.fn();
    render(<ChatRail chat={[]} pinned={null} reactionsOn={false} onSend={onSend} onReact={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Chat message' });
    fireEvent.change(input, { target: { value: '你好' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true }); // Chrome / Firefox mid-composition
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 }); // Safari's composition-ending Enter
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue('你好');

    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('你好');
    expect(input).toHaveValue('');
  });
});
