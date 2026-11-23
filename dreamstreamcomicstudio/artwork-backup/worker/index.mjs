// Only Cron and the single-concurrency private queue invoke the scanner.
const SOURCE_ORIGIN = 'https://bdjfmxfmhqhzvgrhbbzm.supabase.co';
const BUCKETS = ['comic-assets', 'comic-private'];
const BATCH = 30;
const SIX_HOURS = 6 * 60 * 60_000;
const STATE = 'control/state.json';
const STATUS = 'control/status.json';
const CHECKSUM = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2,'0')).join('');
const sha = async value => hex(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
const normalizedEtag = value => typeof value === 'string' ? value.replace(/^W\//,'').replace(/^"|"$/g,'').toLowerCase() : '';
const jsonOptions = { httpMetadata: {contentType:'application/json',cacheControl:'no-store'} };
class BackupError extends Error { constructor(code) { super(code); this.name='BackupError'; } }
const ERRORS = new Set(['manifest','manifest_shape','origin','source_read','source_changed','size','archive','integrity','verification','checkpoint','manifest_transport','source_transport','source_buffer','digest','r2_write','r2_read','manifest_write','control_write','manifest_fetch','manifest_json','source_http','upstream_request','upstream_timeout']);

async function stage(code, action) {
  try { return await action(); }
  catch (err) { throw err instanceof BackupError ? err : new BackupError(code); }
}

async function checksum(body) {
  const sink = new crypto.DigestStream('SHA-256');
  await body.pipeTo(sink);
  return hex(await sink.digest);
}

// An R2 body must have a known length. Backpressure lets large originals stream
// within the Worker memory limit. Both paths consume the same source bytes.
async function storeAndHash(r2, key, body, size, contentType) {
  const fixed = new FixedLengthStream(size);
  const digest = new crypto.DigestStream('SHA-256');
  const reader=body.getReader(), output=fixed.writable.getWriter(), hasher=digest.getWriter();
  const copy = async () => {
    for (;;) {
      const part=await reader.read();
      if (part.done) break;
      // Wait for both destinations before reading the next chunk. ReadableStream.tee()
      // could otherwise buffer an entire large object behind the slower R2 writer.
      await Promise.all([output.write(part.value),hasher.write(part.value)]);
    }
    await Promise.all([output.close(),hasher.close()]);
  };
  try {
    await Promise.all([copy(),r2.put(key,fixed.readable,{httpMetadata:{contentType}})]);
    return hex(await digest.digest);
  } catch (error) {
    await Promise.allSettled([reader.cancel(),output.abort(),hasher.abort()]);
    throw error;
  }
}

function sourceAddress(item) {
  let target;
  try { target=new URL(item.signedUrl); } catch { throw new BackupError('origin'); }
  if (target.origin!==SOURCE_ORIGIN || target.username || target.password || !target.pathname.startsWith('/storage/v1/object/sign/'+item.bucket+'/')) {
    throw new BackupError('origin');
  }
  return target.href;
}

async function boundedBuffer(body,expected) {
  const out=new Uint8Array(expected);
  const reader=body.getReader();
  let length=0;
  for (;;) {
    const part=await reader.read();
    if (part.done) break;
    if (length+part.value.length>expected) { await reader.cancel(); throw new BackupError('size'); }
    out.set(part.value,length);
    length+=part.value.length;
  }
  if (length!==expected) throw new BackupError('size');
  return out;
}
async function hashArchive(obj) {
  if (obj.size>4*1024*1024) return checksum(obj.body);
  return hex(await crypto.subtle.digest('SHA-256',await boundedBuffer(obj.body,obj.size)));
}

async function sourceFetch(url, options, timeoutMs) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try { return await fetch(url,{...options,redirect:'manual',signal:controller.signal}); }
  catch { throw new BackupError(controller.signal.aborted?'upstream_timeout':'upstream_request'); }
  finally { clearTimeout(timer); }
}

async function getPage(env, bucket, afterId, limit=BATCH) {
  const response = await sourceFetch(SOURCE_ORIGIN+'/functions/v1/comic-artwork-backup-source', {
    method:'POST',
    headers:{'content-type':'application/json',Authorization:'Bearer '+env.SOURCE_ANON_KEY,'X-Backup-Token':env.BACKUP_TOKEN},
    body:JSON.stringify({bucket,afterId,limit})
  },25_000);
  if (!response.ok) throw new BackupError('manifest');
  const data=await stage('manifest_json',()=>response.json());
  if (!Array.isArray(data.items) || data.items.length>limit) throw new BackupError('manifest_shape');
  let prev=afterId??'';
  for (const item of data.items) {
    if (!item || item.bucket!==bucket || !/^[0-9a-f-]{36}$/.test(item.id) || item.id<=prev || typeof item.name!=='string' || !item.name || typeof item.updatedAt!=='string') throw new BackupError('manifest_shape');
    prev=item.id;
  }
  return data.items;
}

async function verifySourceRevision(env,item) {
  const id=BigInt('0x'+item.id.replaceAll('-',''));
  const priorId=id===0n ? null : (id-1n).toString(16).padStart(32,'0').replace(/^(........)(....)(....)(....)(............)$/,'$1-$2-$3-$4-$5');
  const [observed]=await getPage(env,item.bucket,priorId,1);
  if (!observed || observed.id!==item.id || observed.version!==item.version || observed.updatedAt!==item.updatedAt ||
    observed.name!==item.name || observed.size!==item.size || observed.etag!==item.etag) throw new BackupError('source_changed');
}

async function copyObject(env,item) {
  const r2=env.BACKUP;
  const identity = await stage('digest',()=>sha(JSON.stringify([item.bucket,item.id,item.name,item.version,item.updatedAt,item.etag,item.size])));
  const relative=item.bucket+'/'+item.id+'/'+identity;
  const archive='art/'+relative;
  const manifest='manifests/'+relative+'.json';
  const recorded=await stage('r2_read',()=>r2.get(manifest));
  if (recorded) {
    const previous=await recorded.json();
    const data=await r2.head(archive);
    const storedHash=data?.checksums?.sha256;
    if (data && data.size===previous.size && CHECKSUM.test(previous.sha256) && (!storedHash || hex(storedHash)===previous.sha256)) {
      return {archive,sha256:previous.sha256,size:previous.size,copied:false};
    }
  }
  const response=await stage('source_transport',()=>sourceFetch(sourceAddress(item),{},100_000));
  if (!response.ok || !response.body) throw new BackupError('source_read');
  const headerSize=response.headers.get('content-length');
  const size=item.size ?? (headerSize===null ? NaN : Number(headerSize));
  if (!Number.isSafeInteger(size) || size<0 || size>5_000_000_000) throw new BackupError('size');
  const actualTag=normalizedEtag(response.headers.get('etag'));
  const expectedTag=normalizedEtag(item.etag);
  if (expectedTag && actualTag && expectedTag!==actualTag) throw new BackupError('source_changed');
  const contentType=(response.headers.get('content-type')||'application/octet-stream').slice(0,200);
  let sourceHash;
  if (size<=4*1024*1024) {
    // Fixed-size, bounded reads allow R2 to verify its SHA-256 checksum during upload.
    const bytes=await stage('source_buffer',()=>boundedBuffer(response.body,size));
    const digest=await stage('digest',()=>crypto.subtle.digest('SHA-256',bytes));
    await stage('r2_write',()=>r2.put(archive,bytes,{sha256:digest,httpMetadata:{contentType}}));
    sourceHash=hex(digest);
  } else {
    sourceHash=await stage('r2_write',()=>storeAndHash(r2,archive,response.body,size,contentType));
  }
  const stored=await stage('r2_read',()=>r2.get(archive));
  if (!stored || stored.size!==size || await stage('integrity',()=>hashArchive(stored))!==sourceHash) throw new BackupError('integrity');
  if (!expectedTag || !actualTag) await verifySourceRevision(env,item);
  // The source name stays in the private manifest. Signed URLs and credentials never do.
  const entry={schema:1,bucket:item.bucket,id:item.id,name:item.name,version:item.version??null,updatedAt:item.updatedAt,
    etag:item.etag??null,size,sha256:sourceHash,archive,contentType,copiedAt:new Date().toISOString()};
  await stage('manifest_write',()=>r2.put(manifest,JSON.stringify(entry),jsonOptions));
  return {archive,sha256:sourceHash,size,copied:true};
}

async function verifyRestore(r2, sample) {
  if (!sample) return {verified:false,reason:'empty'};
  const original=await r2.get(sample.archive);
  if (!original || original.size!==sample.size) throw new BackupError('verification');
  const key='verification/'+crypto.randomUUID();
  try {
    let hash;
    if (original.size<=4*1024*1024) {
      const buffer=await boundedBuffer(original.body,original.size);
      const digest=await crypto.subtle.digest('SHA-256',buffer);
      await r2.put(key,buffer,{sha256:digest});
      hash=hex(digest);
    } else hash=await storeAndHash(r2,key,original.body,original.size,'application/octet-stream');
    const restored=await r2.get(key);
    if (hash!==sample.sha256 || !restored || restored.size!==sample.size || await hashArchive(restored)!==hash) throw new BackupError('verification');
    return {verified:true,bytes:restored.size,at:new Date().toISOString()};
  } finally { await r2.delete(key); }
}

function freshState() {
  return {schema:1,startedAt:Date.now(),completedAt:null,bucketIndex:0,afterId:null,sample:null,
    counts:Object.fromEntries(BUCKETS.map(b=>[b,{seen:0,copied:0,reused:0,bytes:0}]))};
}

export async function backupBatch(env) {
  const r2=env.BACKUP;
  const prior=await r2.get(STATE);
  let state=prior ? await prior.json() : freshState();
  if (state.completedAt) {
    if (Date.now()-state.completedAt < SIX_HOURS-5*60_000) return;
    state=freshState();
  }
  const bucket=BUCKETS[state.bucketIndex];
  const items=await stage('manifest_transport',()=>getPage(env,bucket,state.afterId));
  const counts=state.counts[bucket];
  // Bound concurrent source downloads/R2 streams; checkpoint advances only after
  // the entire page is verified. Replays reuse immutable version objects.
  for (let i=0;i<items.length;i+=3) {
    const group=await Promise.allSettled(items.slice(i,i+3).map(item=>copyObject(env,item)));
    for (const result of group) {
      if (result.status!=='fulfilled') throw result.reason;
      const file=result.value;
      counts.seen++;
      counts[file.copied?'copied':'reused']++;
      counts.bytes+=file.size;
      // Reservoir sampling gives every verified source record a chance at the
      // independent restore drill, including on scans where all bytes were reused.
      const random=crypto.getRandomValues(new Uint32Array(1))[0]/2**32;
      if (!state.sample || random < 1/(state.counts[BUCKETS[0]].seen+state.counts[BUCKETS[1]].seen)) {
        state.sample={archive:file.archive,sha256:file.sha256,size:file.size};
      }
    }
  }
  if (items.length<BATCH) { state.bucketIndex++; state.afterId=null; }
  else state.afterId=items.at(-1).id;
  if (state.bucketIndex===BUCKETS.length) {
    const restore=await verifyRestore(r2,state.sample);
    state.completedAt=Date.now();
    state.restore=restore;
    state.sample=null;
  }
  const condition=prior?{etagMatches:prior.etag}:{etagDoesNotMatch:'*'};
  const saved=await stage('control_write',()=>r2.put(STATE,JSON.stringify(state),{...jsonOptions,onlyIf:condition}));
  if (!saved) throw new BackupError('checkpoint');
  const status={schema:1,startedAt:state.startedAt,completedAt:state.completedAt,checkedAt:Date.now(),counts:state.counts,restore:state.restore??null};
  await r2.put(STATUS,JSON.stringify(status),jsonOptions);
  if (!state.completedAt) await env.TASKS.send({scan:true});
  else console.log(JSON.stringify({event:'artwork_backup_complete',counts:state.counts,restore:state.restore.verified}));
}

export default {
  async scheduled(_event, env) { await env.TASKS.send({scan:true}); },
  async queue(batch, env) {
    try { await backupBatch(env); batch.ackAll(); }
    catch (error) {
      const code=error instanceof BackupError && ERRORS.has(error.message) ? error.message : 'archive';
      console.warn(JSON.stringify({event:'artwork_backup_retry',code}));
      await env.BACKUP.put('control/last-error.json',JSON.stringify({code,at:Date.now()}),jsonOptions);
      batch.retryAll({delaySeconds:60});
    }
  },
  // No routing, source reads, or restore interface through HTTP.
  fetch() { return new Response(null,{status:404}); }
};
