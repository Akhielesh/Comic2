import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { InviteFriends } from './InviteFriends';
import { getMemberReferral } from '../services/memberReferrals';
const auth = vi.hoisted(() => ({ user: { id:'one' } }));
vi.mock('../contexts/AuthContext', () => ({useAuth:() => auth}));
vi.mock('../services/memberReferrals', () => ({getMemberReferral: vi.fn()}));
afterEach(() => { vi.resetAllMocks(); auth.user.id='one'; });
it('shows only the owner’s verified count and shareable link, and supports manual copy',async () => {
  vi.mocked(getMemberReferral).mockResolvedValue({url:'https://comics.dreamstreamstudio.ai/?ref=aa',verifiedSignups:2});
  render(<InviteFriends/>);
  const link = await screen.findByRole('textbox',{name:'Your referral link'});
  fireEvent.click(screen.getByRole('button',{name:'Copy link'}));
  expect(await screen.findByRole('status')).toHaveTextContent('Your link is selected');
  expect(link).toHaveFocus();
  expect(screen.getByText('Rewards coming soon')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:/send/i})).toBeNull();
});
it('clears the prior link on an account change and ignores a late response',async () => {
  let resolveOld!: (value:{url:string;verifiedSignups:number}) => void;
  vi.mocked(getMemberReferral).mockReturnValueOnce(new Promise(r => {resolveOld=r;}));
  vi.mocked(getMemberReferral).mockResolvedValueOnce({url:'new-owner',verifiedSignups:0});
  const view=render(<InviteFriends/>);
  auth.user.id='two';view.rerender(<InviteFriends/>);
  const link=await screen.findByRole('textbox');
  await act(async()=>resolveOld({url:'first-owner',verifiedSignups:10}));
  expect(link).toHaveValue('new-owner');
});
