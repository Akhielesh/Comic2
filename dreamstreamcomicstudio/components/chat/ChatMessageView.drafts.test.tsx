import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ChatMessageView } from './ChatMessageView';
import { setComposerDraftAccount } from '../../services/composerDrafts';
const turn = { id:'message', role:'user' as const, content:'Original question', createdAt:1 };
beforeEach(()=>{setComposerDraftAccount(null);sessionStorage.clear();setComposerDraftAccount('alice');});
it('message-edit bubbles reopen their unsent draft after navigation; failed sends preserve it', async()=>{
 const onEdit=vi.fn(async()=>false);const props={turn,sessionId:'chat',accountId:'alice',onEdit};
 const view=render(<ChatMessageView {...props}/>);fireEvent.click(screen.getByTitle('Edit & resend'));
 fireEvent.change(screen.getByRole('textbox'),{target:{value:'Unfinished revision'}});view.unmount();
 render(<ChatMessageView {...props}/>);fireEvent.click(screen.getByTitle('Edit & resend'));expect(screen.getByRole('textbox')).toHaveValue('Unfinished revision');
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Save & send'})));expect(screen.getByRole('textbox')).toHaveValue('Unfinished revision');
});
