// @vitest-environment node
import {createHash} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {createBackupSource} from './index';
const token = 'local-fixture-read-token';
const digest = createHash('sha256').update(token).digest('hex');
const host = 'https://bdjfmxfmhqhzvgrhbbzm.supabase.co';
const make = (body: unknown, key = token, method = 'POST') => new Request('https://edge.invalid/source', { method, headers: {'Content-Type':'application/json','X-Backup-Token':key}, ...(method === 'POST' ? {body:JSON.stringify(body)} : {}) });
const bucket = 'comic-private';
const body = {bucket,afterId:null,limit:2};
const rows = [
  {id:'00000000-0000-4000-8000-000000000001',bucket,name:'folder/name #1?.png',version:'v1',size:10,etag:'original',updatedAt:'2026-01-01T00:00:00Z'},
  {id:'00000000-0000-4000-8000-000000000002',bucket,name:'folder/絵 2.png',version:null,size:null,etag:null,updatedAt:'2026-01-03T00:00:00Z'}
];
const signed = rows.map(row => ({path:row.name,signedURL:'/object/sign/'+bucket+'/'+row.name+'?token=fixture.jwt.sig',error:null}));
const response = (x:unknown) => Response.json(x);

describe('scoped artwork backup source', () => {
  it('rejects unconfigured digests, unauthenticated public gateway requests, unrelated buckets and malformed cursors before storage',async () => {
    const secret=vi.fn(), fetcher=vi.fn();
    const handle=createBackupSource({digest,getServiceKey:secret,fetcher});
    expect((await createBackupSource({digest:'__BACKUP_TOKEN_SHA256__',getServiceKey:secret,fetcher})(make(body))).status).toBe(401);
    expect((await handle(make(body,'else'))).status).toBe(401);
    expect((await handle(make(body,token,'GET'))).status).toBe(405);
    for(const value of [{...body,bucket:'avatars'},{...body,limit:51},{...body,limit:0},{...body,limit:1.2},{...body,afterId:'something'},{bucket,limit:2}]) expect((await handle(make(value))).status).toBe(400);
    expect(secret).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns the keyset, preserves nullable metadata, signs only the returned objects, handles reordered results and pins encoded URLs',async () => {
    const fetcher=vi.fn().mockResolvedValueOnce(response(rows)).mockResolvedValueOnce(response([...signed].reverse()));
    const result=await createBackupSource({digest,getServiceKey:()=> 'test-admin-key',fetcher})(make(body));
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    const {items}=await result.json();
    expect(items.map((i:typeof rows[number])=>i.id)).toEqual(rows.map(r=>r.id));
    expect(items[0].signedUrl).toBe(host+'/storage/v1/object/sign/comic-private/folder/name%20%231%3F.png?token=fixture.jwt.sig');
    expect(items[1]).toMatchObject({version:null,etag:null,size:null});
    expect(fetcher.mock.calls.map(([url])=>url)).toEqual([host+'/rest/v1/rpc/comic_artwork_backup_manifest',host+'/storage/v1/object/sign/comic-private']);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({p_bucket:bucket,p_after:null,p_limit:2});
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({expiresIn:600,paths:rows.map(r=>r.name)});
    expect(JSON.stringify(items)).not.toContain('test-admin-key');
  });
  it('stops on the empty tail without signing',async () => {
    const fetcher=vi.fn().mockResolvedValue(response([]));
    const result=await createBackupSource({digest,getServiceKey:()=> 'test-admin-key',fetcher})(make({...body,afterId:rows[1].id}));
    expect(await result.json()).toEqual({items:[]});expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects wrong buckets, out-of-order pages, wrong object signatures, external origins and error bodies without leaking identifiers',async () => {
    for(const [list,links] of [
      [[{...rows[0],bucket:'avatars'}],signed],[[rows[1],rows[0]],signed],
      [rows,[signed[0],{...signed[1],signedURL:'https://untrusted.invalid/object/sign/'+bucket+'/'+rows[1].name+'?token=secret'}]],
      [rows,[signed[0],{...signed[1],signedURL:signed[0].signedURL}]],
      [rows,[signed[0],{path:rows[1].name,error:'private identifier in error response'}]]
    ]) {
      const fetcher=vi.fn().mockResolvedValueOnce(response(list)).mockResolvedValueOnce(response(links));
      const result=await createBackupSource({digest,getServiceKey:()=> 'test-admin-key',fetcher})(make(body));
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({error:'Backup source unavailable'});
    }
  });
});
