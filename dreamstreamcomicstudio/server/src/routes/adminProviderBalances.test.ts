// @vitest-environment node
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll,beforeAll,beforeEach,expect,it,vi } from 'vitest';

const access = vi.hoisted(() => ({admin:false}));
vi.mock('../services/rbac.js', async original => ({ ...(await original<typeof import('../services/rbac.js')>()),
  resolveAccessProfile:async()=>({isAdmin:access.admin,isModerator:true,roles:access.admin?['admin']:['moderator']}) }));
const report=vi.hoisted(()=>({provider:'deepseek',status:'reported',checkedAt:123,accountBalances:[{currency:'CNY',remaining:3}],keyQuotaUsd:null}));
const io=vi.hoisted(()=>({platformBalanceHistory:vi.fn(),refreshProviderBalance:vi.fn()}));
vi.mock('../services/accountProviderUsage.js',async original=>({...(await original<typeof import('../services/accountProviderUsage.js')>()),...io}));
const { adminRouter }=await import('./admin.js');

let server:Server,url:string;
beforeAll(async()=>{
  const app=express();
  app.use((req,_res,next)=>{req.user={id:'signed-in'};next();});
  app.use('/api/admin',adminRouter);
  server=app.listen(0);
  await new Promise(resolve=>server.once('listening',resolve));
  url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/provider-balances`;
});
beforeEach(()=>{access.admin=false;vi.clearAllMocks();vi.stubEnv('DEEPSEEK_API_KEY','only-platform-key');});
afterAll(async()=>{vi.unstubAllEnvs();await new Promise(resolve=>server.close(resolve));});

it('restricts both platform balance routes to administrators, including when a moderator supplies their own key',async()=>{
  expect((await fetch(url)).status).toBe(403);
  expect((await fetch(url+'/deepseek',{method:'POST',headers:{'X-DeepSeek-Key':'personal'}})).status).toBe(403);
  expect(io.platformBalanceHistory).not.toHaveBeenCalled();
  expect(io.refreshProviderBalance).not.toHaveBeenCalled();
});

it('uses only the server platform credential on refresh and only persisted observations on dashboard load',async()=>{
  access.admin=true;
  io.platformBalanceHistory.mockResolvedValue({balanceReports:[],available:true});
  io.refreshProviderBalance.mockResolvedValue({report,saved:true});
  expect((await fetch(url)).headers.get('cache-control')).toBe('no-store');
  expect(io.refreshProviderBalance).not.toHaveBeenCalled();
  const response=await fetch(url+'/deepseek',{method:'POST',headers:{'X-DeepSeek-Key':'personal'}});
  expect(await response.json()).toEqual({report,saved:true});
  expect(io.refreshProviderBalance).toHaveBeenCalledWith({ownerId:null,provider:'deepseek',key:'only-platform-key'});
});
