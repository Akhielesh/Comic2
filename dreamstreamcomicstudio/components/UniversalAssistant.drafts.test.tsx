import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ query: vi.fn(), profile: vi.fn(async () => null), user: { id: 'alice' } }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: api.user }) }));
vi.mock('../services/geminiService', () => ({ queryUniversalAssistant: api.query }));
vi.mock('../services/db', () => ({ getUsageLimits: vi.fn(async () => null), getUserProfile: api.profile, loadArtifactsForProject: vi.fn(async () => []) }));
vi.mock('../services/assistantContext', () => ({ buildProjectSnapshot: vi.fn(), summarizeAllProjects: vi.fn(async () => []), summarizeProject: vi.fn(async () => null) }));
vi.mock('../services/telemetry', () => ({ captureError: vi.fn(), captureEvent: vi.fn() }));
vi.mock('../services/feedback', () => ({ detectSentiment: vi.fn(() => null), submitFeedback: vi.fn() }));
import { UniversalAssistant } from './UniversalAssistant';
import { setComposerDraftAccount } from '../services/composerDrafts';
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); setComposerDraftAccount(null); sessionStorage.clear(); setComposerDraftAccount('alice'); api.query.mockReset(); api.profile.mockReset().mockResolvedValue(null); api.user = { id: 'alice' }; });
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Open assistant' }));
const box = () => screen.getByPlaceholderText('Ask anything about DreamStream…');
it('floating assistant preserves failed input after close/navigation/remount', async () => {
 api.query.mockRejectedValue(new Error('offline'));
 const view=render(<UniversalAssistant currentView="gallery" projects={[]} />);open();
 fireEvent.change(box(),{target:{value:'Please help with my comic'}});fireEvent.keyDown(box(),{key:'Enter'});
 await waitFor(()=>expect(api.query).toHaveBeenCalledTimes(1));await act(async()=>{});
 expect(box()).toHaveValue('Please help with my comic');view.unmount();
 render(<UniversalAssistant currentView="dashboard" projects={[]} />);open();expect(box()).toHaveValue('Please help with my comic');
});
it('floating assistant completion preserves typing made while the reply was pending', async () => {
 let finish!:(value: {text:string})=>void;api.query.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 render(<UniversalAssistant currentView="gallery" projects={[]} />);open();
 fireEvent.change(box(),{target:{value:'First question'}});fireEvent.keyDown(box(),{key:'Enter'});
 await waitFor(()=>expect(api.query).toHaveBeenCalledTimes(1));
 fireEvent.change(box(),{target:{value:'My next question'}});await act(async()=>finish({text:'Answer'}));
 expect(box()).toHaveValue('My next question');
});

it('does not send an old account draft when account changes during context loading', async () => {
 let finish!: (value: null) => void;
 api.profile.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
 const view = render(<UniversalAssistant currentView="gallery" projects={[]} />);open();
 fireEvent.change(box(), { target: { value: 'Alice private draft' } });fireEvent.keyDown(box(), { key: 'Enter' });
 await waitFor(() => expect(api.profile).toHaveBeenCalledTimes(1));
 api.user = { id: 'bob' };act(() => setComposerDraftAccount('bob'));
 view.rerender(<UniversalAssistant currentView="gallery" projects={[]} />);
 fireEvent.change(box(), { target: { value: 'Bob current draft' } });
 await act(async () => finish(null));
 expect(api.query).not.toHaveBeenCalled();
 expect(box()).toHaveValue('Bob current draft');
});
