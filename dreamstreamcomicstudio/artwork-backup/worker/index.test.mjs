// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import worker, { backupBatch } from './index.mjs';

const publicBucket='comic-assets', privateBucket='comic-private';
const base='https://bdjfmxfmhqhzvgrhbbzm.supabase.co';
const id='a1111111-2222-4444-8888-999999999999';
const encryptedName='example/story panel.png';
const updatedAt='2026-01-01T01:00:00Z';
const marker={id,bucket:publicBucket,name:encryptedName,version:'one',size:4,etag:'tag',updatedAt,signedUrl:base+'/storage/v1/object/sign/comic-assets/demo?token=short-lived'};
const fromText=s=>new TextEncoder().encode(s);
class FakeR2 {
  memory=new Map();
  writes=0;
  corrupt=false;
  async head(key) {
    const row=this.memory.get(key);
    return row?{size:row.bytes.length,etag:row.etag}:null;
  }
  async get(key) {
    const row=this.memory.get(key);
    if (!row) return null;
    const bytes=this.corrupt && key.startsWith('art/') ? fromText('oops'):row.bytes;
    return {size:bytes.length,etag:row.etag,body:new Response(bytes).body,json:async()=>JSON.parse(new TextDecoder().decode(bytes))};
  }
  async put(key,value,opts) {
    const found=this.memory.get(key);
    const condition=opts?.onlyIf;
    if (condition?.etagMatches && condition.etagMatches!==found?.etag || condition?.etagDoesNotMatch==='*' && found) return null;
    const bytes=new Uint8Array(await new Response(value).arrayBuffer());
    this.memory.set(key,{bytes,etag:String(++this.writes)});
    return {};
  }
  async delete(key) { this.memory.delete(key); }
}
let state,items,privateItems,download,clock;
beforeEach(()=>{
  vi.stubGlobal('crypto',webcrypto);
  state={BACKUP:new FakeR2(),TASKS:{send:vi.fn()},BACKUP_TOKEN:'test-reader',SOURCE_ANON_KEY:'test-anon'};
  items=[marker];
  privateItems=[];
  download=vi.fn(()=>new Response(fromText('abcd'),{headers:{etag:'"tag"','content-length':'4'}}));
  vi.stubGlobal('fetch',vi.fn(async (url,opts)=>{
    if(!String(url).includes('/functions/'))return download(url,opts);
    const request=JSON.parse(opts.body);
    expect(opts.headers['X-Backup-Token']).toBe('test-reader');
    return Response.json({items:request.bucket===publicBucket ? items:privateItems});
  }));
  clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-01-02T00:00:00Z'));
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('private versioned archive',()=>{
  it('archives and verifies bytes, restores a temporary copy, hides paths from status, and retains files after source deletion',async()=>{
    await backupBatch(state);
    await backupBatch(state);
    const checked=await (await state.BACKUP.get('control/status.json')).json();
    expect(checked.counts[publicBucket]).toEqual({seen:1,copied:1,reused:0,bytes:4});
    expect(checked.counts[privateBucket].seen).toBe(0);
    expect(checked.restore).toMatchObject({verified:true,bytes:4});
    expect(JSON.stringify(checked)).not.toContain(encryptedName);
    const keys=[...state.BACKUP.memory.keys()];
    expect(keys.some(k=>k.startsWith('verification/'))).toBe(false);
    const manifest=await (await state.BACKUP.get(keys.find(k=>k.startsWith('manifests/')))).json();
    expect(manifest.name).toBe(encryptedName);
    expect(manifest.sha256).toHaveLength(64);
    expect(JSON.stringify(manifest)).not.toContain('short-lived');
    await backupBatch(state);
    expect(download).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(Date.parse('2026-01-02T07:00:00Z'));
    items=[];
    await backupBatch(state);
    await backupBatch(state);
    expect(await state.BACKUP.head(manifest.archive)).toMatchObject({size:4});
  });

  it('reuses unchanged copies, creates new independent source versions, and preserves a previous revision',async()=>{
    await backupBatch(state); await backupBatch(state);
    clock.mockReturnValue(Date.parse('2026-01-02T07:00:00Z'));
    await backupBatch(state); await backupBatch(state);
    expect((await (await state.BACKUP.get('control/status.json')).json()).counts[publicBucket].reused).toBe(1);
    expect(download).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(Date.parse('2026-01-02T14:00:00Z'));
    items=[{...marker, version:'two',etag:'next'}];
    download.mockImplementation(()=>new Response(fromText('efgh'),{headers:{etag:'next'}}));
    await backupBatch(state);
    expect([...state.BACKUP.memory.keys()].filter(k=>k.startsWith('art/'))).toHaveLength(2);
  });

  it('does not advance the cursor for corrupt read-back and logs only a fixed error code',async()=>{
    state.BACKUP.corrupt=true;
    const retryAll=vi.fn();
    await worker.queue({ackAll:vi.fn(),retryAll},state);
    expect(retryAll).toHaveBeenCalled();
    expect(await state.BACKUP.get('control/state.json')).toBeNull();
    const error=await (await state.BACKUP.get('control/last-error.json')).json();
    expect(error.code).toBe('integrity');
    expect(Object.keys(error).sort()).toEqual(['at','code']);
    expect([...state.BACKUP.memory.keys()].some(k=>k.startsWith('manifests/'))).toBe(false);
  });

  it('can archive a synthetic private reference into the private archive when the source bucket has an object',async()=>{
    items=[];
    privateItems=[{...marker,bucket:privateBucket,signedUrl:base+'/storage/v1/object/sign/comic-private/test?token=short-lived'}];
    await backupBatch(state); await backupBatch(state);
    const result=await (await state.BACKUP.get('control/status.json')).json();
    expect(result.counts[privateBucket]).toEqual({seen:1,copied:1,reused:0,bytes:4});
    expect(result.restore.verified).toBe(true);
    expect([...state.BACKUP.memory.keys()].some(k=>k.startsWith('art/comic-private/'))).toBe(true);
  });

  it('streams larger originals through both verification and a private restore roundtrip',async()=>{
    class DigestSink extends WritableStream {
      constructor() {
        const hash=createHash('sha256');
        let finish;
        const digest=new Promise(resolve=>{finish=resolve;});
        super({write:bytes=>{hash.update(bytes);},close:()=>finish(hash.digest())});
        this.digest=digest;
      }
    }
    vi.stubGlobal('crypto',{subtle:webcrypto.subtle,getRandomValues:values=>webcrypto.getRandomValues(values),randomUUID:()=>webcrypto.randomUUID(),DigestStream:DigestSink});
    vi.stubGlobal('FixedLengthStream',class extends TransformStream { constructor() { super(); } });
    const bytes=new Uint8Array(4*1024*1024+17);
    bytes[bytes.length-1]=17;
    items=[{...marker,size:bytes.length}];
    download.mockImplementation(()=>new Response(bytes,{headers:{etag:'tag'}}));
    await backupBatch(state); await backupBatch(state);
    expect((await (await state.BACKUP.get('control/status.json')).json()).restore).toMatchObject({verified:true,bytes:bytes.length});
  });

  it('rechecks a missing source ETag before sealing a version and retries if the source changed during capture',async()=>{
    items=[{...marker,etag:null}];
    download.mockImplementation(()=>{items=[{...items[0],version:'newer'}];return new Response(fromText('abcd'));});
    await expect(backupBatch(state)).rejects.toThrow('source_changed');
    expect(await state.BACKUP.get('control/state.json')).toBeNull();
    expect([...state.BACKUP.memory.keys()].some(k=>k.startsWith('manifests/'))).toBe(false);
  });

  it('refuses cross-origin signed links, leaves source untouched, and has no HTTP control route',async()=>{
    items=[{...marker,signedUrl:'https://example.test/private'}];
    await expect(backupBatch(state)).rejects.toThrow('origin');
    expect(download).not.toHaveBeenCalled();
    expect((await worker.fetch(new Request('https://example.test/run'))).status).toBe(404);
    expect(state.TASKS.send).not.toHaveBeenCalled();
  });
});
