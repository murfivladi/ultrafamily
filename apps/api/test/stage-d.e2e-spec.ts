import type { INestApplication } from '@nestjs/common';
import zlib from 'node:zlib';
import request from 'supertest';
import { MediaQueueService } from '../src/files/media-queue.service';
import { createTestApp, householdSpaces, login, type TestAccount } from './test-app';

let app: INestApplication;
let owner: TestAccount;
let adult: TestAccount;
let child: TestAccount;
let guest: TestAccount;
let ownerSpace = '';
let adultSpace = '';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function upload(
  account: TestAccount,
  spaceId: string,
  name: string,
  data: Buffer,
  extra: Record<string, unknown> = {},
  complete: Record<string, unknown> = {},
) {
  const session = await account.agent
    .post('/api/files/uploads')
    .set('x-csrf-token', account.csrfToken)
    .send({ spaceId, name, size: data.length, ...extra });
  if (session.status !== 201) return session;
  const body = session.body as { id: string; chunkBytes: number; totalChunks: number };
  for (let index = 0; index < body.totalChunks; index += 1) {
    await account.agent
      .put(`/api/files/uploads/${body.id}/chunks/${index}?spaceId=${spaceId}`)
      .set('x-csrf-token', account.csrfToken)
      .set('content-type', 'application/octet-stream')
      .send(data.subarray(index * body.chunkBytes, (index + 1) * body.chunkBytes))
      .expect(200);
  }
  return account.agent
    .post(`/api/files/uploads/${body.id}/complete`)
    .set('x-csrf-token', account.csrfToken)
    .send({ spaceId, ...complete });
}

async function drainQueue() {
  await app.get(MediaQueueService).runOnce(100);
}

function basic(token: string) {
  return `Basic ${Buffer.from(`family:${token}`).toString('base64')}`;
}

/** Minimal valid PDF with one text-layer stream. */
function pdfWithText(text: string): Buffer {
  const stream = zlib.deflateSync(Buffer.from(`BT /F1 12 Tf 72 712 Td (${text}) Tj ET`, 'latin1'));
  return Buffer.concat([
    Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Length ' + stream.length + ' /Filter /FlateDecode >>\nstream\n',
      'latin1',
    ),
    stream,
    Buffer.from('\nendstream\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1'),
  ]);
}

/** Stored (uncompressed) ZIP with the given entries. */
function zip(entries: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await login(app, 'owner@ultra.family');
  adult = await login(app, 'adult@ultra.family');
  child = await login(app, 'child@ultra.family');
  guest = await login(app, 'guest@ultra.family');
  ownerSpace = householdSpaces(owner).find((space) => space.name === 'Дом Палермо')!.id;
  adultSpace = householdSpaces(adult).find((space) => space.name === 'Дом Катании')!.id;
});

afterAll(async () => {
  await app?.close();
});

describe('Stage D files', () => {
  let folderId = '';
  let fileId = '';

  it('creates folders, uploads in chunks, versions and previews text', async () => {
    const folder = await owner.agent
      .post('/api/files/folders')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, name: 'Документы', parentId: null })
      .expect(201);
    folderId = (folder.body as { id: string }).id;

    const first = await upload(
      owner,
      ownerSpace,
      'notes.txt',
      Buffer.from('первая версия заметки'),
      {
        folderId,
      },
    );
    expect(first.status).toBe(201);
    fileId = (first.body as { id: string }).id;
    expect(first.body).toMatchObject({ kind: 'text', version: 1, scanStatus: 'unscanned' });

    const second = await upload(
      owner,
      ownerSpace,
      'notes.txt',
      Buffer.from('вторая версия заметки'),
      {
        folderId,
      },
    );
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ id: fileId, version: 2 });

    const versions = await owner.agent
      .get(`/api/files/${fileId}/versions?spaceId=${ownerSpace}`)
      .expect(200);
    expect((versions.body as unknown[]).length).toBe(2);

    const preview = await owner.agent
      .get(`/api/files/${fileId}/preview?spaceId=${ownerSpace}`)
      .expect(200);
    expect(preview.body).toMatchObject({ mode: 'text', text: 'вторая версия заметки' });

    const restored = await owner.agent
      .post(`/api/files/${fileId}/versions/restore`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, version: 1 })
      .expect(201);
    expect(restored.body).toMatchObject({ version: 3 });
    const content = await owner.agent
      .get(`/api/files/${fileId}/content?spaceId=${ownerSpace}`)
      .expect(200);
    expect(content.text).toBe('первая версия заметки');
    expect(content.headers['content-security-policy']).toContain('sandbox');

    const ranged = await owner.agent
      .get(`/api/files/${fileId}/content?spaceId=${ownerSpace}`)
      .set('range', 'bytes=0-5')
      .expect(206);
    expect(ranged.headers['content-range']).toMatch(/^bytes 0-5\//);

    const listing = await owner.agent
      .get(`/api/files?spaceId=${ownerSpace}&folderId=${folderId}`)
      .expect(200);
    expect(listing.body.breadcrumbs).toHaveLength(2);
    expect((listing.body.files as Array<{ id: string }>).map((file) => file.id)).toContain(fileId);
  });

  it('resumes chunk retries idempotently and rejects out-of-order chunks', async () => {
    const data = Buffer.alloc(10, 'a');
    const session = await owner.agent
      .post('/api/files/uploads')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, name: 'retry.txt', size: data.length })
      .expect(201);
    const id = (session.body as { id: string }).id;
    await owner.agent
      .put(`/api/files/uploads/${id}/chunks/1?spaceId=${ownerSpace}`)
      .set('x-csrf-token', owner.csrfToken)
      .set('content-type', 'application/octet-stream')
      .send(data)
      .expect(409);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await owner.agent
        .put(`/api/files/uploads/${id}/chunks/0?spaceId=${ownerSpace}`)
        .set('x-csrf-token', owner.csrfToken)
        .set('content-type', 'application/octet-stream')
        .send(data)
        .expect(200);
    }
    const status = await owner.agent
      .get(`/api/files/uploads/${id}?spaceId=${ownerSpace}`)
      .expect(200);
    expect(status.body).toMatchObject({ receivedBytes: 10, nextIndex: 1 });
    const done = await owner.agent
      .post(`/api/files/uploads/${id}/complete`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace })
      .expect(201);
    expect(done.body).toMatchObject({ sizeBytes: 10 });
  });

  it('blocks executables, renamed binaries and enforces quotas', async () => {
    const exe = await upload(owner, ownerSpace, 'setup.exe', Buffer.from('MZ....'));
    expect(exe.status).toBe(415);
    const disguised = await upload(
      owner,
      ownerSpace,
      'holiday.jpg',
      Buffer.from('MZ\x90\x00binary'),
    );
    expect(disguised.status).toBe(415);
    expect((disguised.body as { message?: string }).message).toMatch(/executable_content/);
    const fake = await upload(
      owner,
      ownerSpace,
      'photo.png',
      Buffer.from('just text, not an image'),
    );
    expect(fake.status).toBe(415);

    await owner.agent
      .put('/api/files/quota')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, quotaBytes: 1, userQuotaBytes: 1, trashRetentionDays: 30 })
      .expect(200);
    const tooBig = await owner.agent
      .post('/api/files/uploads')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, name: 'big.txt', size: 1024 });
    expect(tooBig.status).toBe(413);
    await owner.agent
      .put('/api/files/quota')
      .set('x-csrf-token', owner.csrfToken)
      .send({
        spaceId: ownerSpace,
        quotaBytes: 10 * 1024 ** 3,
        userQuotaBytes: 5 * 1024 ** 3,
        trashRetentionDays: 30,
      })
      .expect(200);
    const usage = await owner.agent.get(`/api/files/usage?spaceId=${ownerSpace}`).expect(200);
    expect(usage.body.usedBytes).toBeGreaterThan(0);
    expect(usage.body.disk.driver).toBe('local');

    // Children cannot use general file storage; adults cannot reach another household.
    await child.agent.get(`/api/files?spaceId=${ownerSpace}`).expect(403);
    await adult.agent.get(`/api/files?spaceId=${ownerSpace}`).expect(403);
    await adult.agent.get(`/api/files/${fileId}?spaceId=${adultSpace}`).expect(404);
    await guest.agent.get(`/api/files?spaceId=${ownerSpace}`).expect(403);
  });

  it('moves to trash, restores folders with their files and purges', async () => {
    await owner.agent
      .delete(`/api/files/folders/${folderId}?spaceId=${ownerSpace}`)
      .set('x-csrf-token', owner.csrfToken)
      .expect(200);
    await owner.agent.get(`/api/files/${fileId}?spaceId=${ownerSpace}`).expect(404);
    const trash = await owner.agent.get(`/api/files/trash?spaceId=${ownerSpace}`).expect(200);
    expect((trash.body.folders as Array<{ id: string }>).map((folder) => folder.id)).toContain(
      folderId,
    );
    // Files inside the trashed folder are restored with it, not listed twice.
    expect((trash.body.files as Array<{ id: string }>).map((file) => file.id)).not.toContain(
      fileId,
    );
    await owner.agent
      .post('/api/files/trash/restore')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, folderId })
      .expect(201);
    await owner.agent.get(`/api/files/${fileId}?spaceId=${ownerSpace}`).expect(200);

    const temp = await upload(owner, ownerSpace, 'temp.txt', Buffer.from('удалить навсегда'));
    const tempId = (temp.body as { id: string }).id;
    await owner.agent
      .delete(`/api/files/${tempId}?spaceId=${ownerSpace}`)
      .set('x-csrf-token', owner.csrfToken)
      .expect(200);
    await owner.agent
      .delete(`/api/files/${tempId}/purge?spaceId=${ownerSpace}`)
      .set('x-csrf-token', owner.csrfToken)
      .expect(200);
    await owner.agent
      .post('/api/files/trash/restore')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, fileId: tempId })
      .expect(404);

    const history = await owner.agent.get(`/api/files/activity?spaceId=${ownerSpace}`).expect(200);
    const actions = (history.body as Array<{ action: string }>).map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining(['file.upload', 'folder.trash', 'trash.restore', 'file.purge']),
    );
  });

  it('lists archives without extracting and flags dangerous entries', async () => {
    const archive = zip([
      ['readme.txt', 'hello'],
      ['../escape.txt', 'bad'],
      ['tools/run.exe', 'MZ'],
    ]);
    const uploaded = await upload(owner, ownerSpace, 'bundle.zip', archive);
    expect(uploaded.status).toBe(201);
    const listing = await owner.agent
      .get(`/api/files/${(uploaded.body as { id: string }).id}/archive?spaceId=${ownerSpace}`)
      .expect(200);
    expect(listing.body).toMatchObject({ format: 'zip', extracted: false });
    expect(listing.body.entries).toHaveLength(3);
    expect(listing.body.warnings).toEqual(expect.arrayContaining(['path_traversal', 'executable']));
  });

  it('extracts text from PDF and office files for search, and finds duplicates', async () => {
    const pdf = await upload(
      owner,
      ownerSpace,
      'contract.pdf',
      pdfWithText('Contratto affitto Mondello'),
    );
    expect(pdf.status).toBe(201);
    const docx = zip([
      ['[Content_Types].xml', '<Types/>'],
      [
        'word/document.xml',
        '<w:document><w:body><w:p><w:r><w:t>Pagella scolastica 2026</w:t></w:r></w:p></w:body></w:document>',
      ],
    ]);
    const office = await upload(owner, ownerSpace, 'pagella.docx', docx);
    expect(office.status).toBe(201);
    expect(office.body).toMatchObject({ kind: 'office', ocrStatus: 'pending' });
    await drainQueue();

    const result = await owner.agent.get(`/api/search?spaceId=${ownerSpace}&q=affitto`).expect(200);
    const hit = (result.body.results as Array<{ id: string; matchedIn: string[] }>).find(
      (entry) => entry.id === (pdf.body as { id: string }).id,
    );
    expect(hit?.matchedIn).toContain('ocr');
    const officeHit = await owner.agent
      .get(`/api/search?spaceId=${ownerSpace}&q=Pagella%20scolastica`)
      .expect(200);
    expect(
      (officeHit.body.results as Array<{ module: string }>).some(
        (entry) => entry.module === 'files',
      ),
    ).toBe(true);

    await upload(owner, ownerSpace, 'copy-a.txt', Buffer.from('одинаковое содержимое'));
    await upload(owner, ownerSpace, 'copy-b.txt', Buffer.from('одинаковое содержимое'));
    const duplicates = await owner.agent
      .get(`/api/files/duplicates?spaceId=${ownerSpace}`)
      .expect(200);
    expect(
      (duplicates.body as Array<{ files: unknown[] }>).some((group) => group.files.length >= 2),
    ).toBe(true);

    const processing = await owner.agent
      .get(`/api/files/processing?spaceId=${ownerSpace}`)
      .expect(200);
    expect(processing.body.engines.ocr.available).toBe(false);
  });

  it('keeps private files invisible to other members', async () => {
    const secret = await upload(owner, ownerSpace, 'private.txt', Buffer.from('личное'), {
      visibility: 'private',
    });
    const secretId = (secret.body as { id: string }).id;
    const admin = await login(app, 'owner@ultra.family');
    await admin.agent.get(`/api/files/${secretId}?spaceId=${ownerSpace}`).expect(200);
    // The child is a space member with photo access but this private text is not media.
    await child.agent.get(`/api/files/${secretId}/content?spaceId=${ownerSpace}`).expect(404);
  });
});

describe('Stage D WebDAV', () => {
  let token = '';

  it('authenticates with app tokens and supports PROPFIND/MKCOL/PUT/GET/MOVE/DELETE', async () => {
    const created = await owner.agent
      .post('/api/files/webdav/tokens')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, name: 'Laptop' })
      .expect(201);
    token = (created.body as { token: string }).token;
    const server = app.getHttpServer();
    const base = `/api/webdav/${ownerSpace}`;

    await request(server).propfind(`${base}/`).expect(401);
    await request(server).propfind(`${base}/`).set('authorization', basic('wrong')).expect(401);
    const root = await request(server)
      .propfind(`${base}/`)
      .set('authorization', basic(token))
      .set('depth', '1')
      .expect(207);
    expect(root.text).toContain('Семейный архив');

    await request(server).mkcol(`${base}/Sync`).set('authorization', basic(token)).expect(201);
    await request(server)
      .put(`${base}/Sync/hello.txt`)
      .set('authorization', basic(token))
      .set('content-type', 'text/plain')
      .send('hello from webdav')
      .expect(201);
    await request(server)
      .put(`${base}/Sync/hello.txt`)
      .set('authorization', basic(token))
      .set('content-type', 'text/plain')
      .send('updated from webdav')
      .expect(204);
    const got = await request(server)
      .get(`${base}/Sync/hello.txt`)
      .set('authorization', basic(token))
      .responseType('blob')
      .expect(200);
    expect(Buffer.from(got.body as Buffer).toString('utf8')).toBe('updated from webdav');

    await request(server)
      .move(`${base}/Sync/hello.txt`)
      .set('authorization', basic(token))
      .set('destination', `http://localhost${base}/Sync/renamed.txt`)
      .expect(201);
    const listing = await request(server)
      .propfind(`${base}/Sync/`)
      .set('authorization', basic(token))
      .set('depth', '1')
      .expect(207);
    expect(listing.text).toContain('renamed.txt');
    expect(listing.text).not.toContain('hello.txt');

    await request(server)
      .put(`${base}/Missing/file.txt`)
      .set('authorization', basic(token))
      .send('x')
      .expect(409);
    await request(server)
      .put(`${base}/Sync/evil.exe`)
      .set('authorization', basic(token))
      .send('MZ')
      .expect(415);
    await request(server)
      .delete(`${base}/Sync/renamed.txt`)
      .set('authorization', basic(token))
      .expect(204);

    // Tokens are bound to one space and stop working when revoked.
    await request(server)
      .propfind(`/api/webdav/${adultSpace}/`)
      .set('authorization', basic(token))
      .expect(401);
    await owner.agent
      .delete(
        `/api/files/webdav/tokens/${(created.body as { id: string }).id}?spaceId=${ownerSpace}`,
      )
      .set('x-csrf-token', owner.csrfToken)
      .expect(200);
    await request(server).propfind(`${base}/`).set('authorization', basic(token)).expect(401);
  });
});

describe('Stage D gallery and sharing', () => {
  let photoId = '';
  let albumId = '';

  it('uploads media, builds albums, timeline, comments, reactions, favorites and people tags', async () => {
    const uploaded = await upload(
      owner,
      ownerSpace,
      'beach.png',
      PNG,
      { module: 'photos' },
      { module: 'photos', onConflict: 'rename', takenAt: '2024-07-14T10:00:00Z' },
    );
    expect(uploaded.status).toBe(201);
    photoId = (uploaded.body as { id: string }).id;
    await drainQueue();

    const notMedia = await upload(
      owner,
      ownerSpace,
      'doc.txt',
      Buffer.from('text'),
      { module: 'photos' },
      {
        module: 'photos',
      },
    );
    expect(notMedia.status).toBe(415);

    const album = await owner.agent
      .post('/api/photos/albums')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, title: 'Пляж', fileIds: [photoId] })
      .expect(201);
    albumId = (album.body as { id: string }).id;
    expect(album.body).toMatchObject({ itemCount: 1, coverFileId: photoId });

    const timeline = await owner.agent
      .get(`/api/photos/timeline?spaceId=${ownerSpace}`)
      .expect(200);
    expect((timeline.body as Array<{ period: string }>).map((bucket) => bucket.period)).toContain(
      '2024-07',
    );

    // Children read the family gallery and take part (comments, reactions).
    await child.agent.get(`/api/photos?spaceId=${ownerSpace}`).expect(200);
    await child.agent
      .post(`/api/photos/${photoId}/comments`)
      .set('x-csrf-token', child.csrfToken)
      .send({ spaceId: ownerSpace, body: 'Красиво!' })
      .expect(201);
    await child.agent
      .post(`/api/photos/${photoId}/reactions`)
      .set('x-csrf-token', child.csrfToken)
      .send({ spaceId: ownerSpace, emoji: '❤️' })
      .expect(201);
    await child.agent.get(`/api/files/${photoId}/content?spaceId=${ownerSpace}`).expect(200);
    await child.agent
      .post('/api/photos/albums')
      .set('x-csrf-token', child.csrfToken)
      .send({ spaceId: ownerSpace, title: 'Нельзя' })
      .expect(403);

    await owner.agent
      .post(`/api/photos/${photoId}/favorite`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, on: true })
      .expect(201);
    const tagged = await owner.agent
      .post(`/api/photos/${photoId}/people`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, userId: child.userId, label: 'Малыш' })
      .expect(201);
    expect(tagged.body.people).toHaveLength(1);

    const favorites = await owner.agent
      .get(`/api/photos?spaceId=${ownerSpace}&favorites=1`)
      .expect(200);
    expect((favorites.body as Array<{ id: string }>).map((item) => item.id)).toEqual([photoId]);
    const item = await owner.agent.get(`/api/photos/${photoId}?spaceId=${ownerSpace}`).expect(200);
    expect(item.body).toMatchObject({ favorite: true, commentCount: 1 });
    expect(item.body.metadata).toMatchObject({ width: 1, height: 1 });

    const byPerson = await owner.agent.get(`/api/search?spaceId=${ownerSpace}&q=Малыш`).expect(200);
    expect((byPerson.body.results as Array<{ id: string }>).map((entry) => entry.id)).toContain(
      photoId,
    );

    await adult.agent.get(`/api/photos/${photoId}?spaceId=${adultSpace}`).expect(404);
  });

  it('issues expiring password links without download and revokes them', async () => {
    await child.agent
      .post('/api/photos/shares')
      .set('x-csrf-token', child.csrfToken)
      .send({ spaceId: ownerSpace, targetKind: 'album', targetId: albumId, expiresInHours: 1 })
      .expect(403);
    const share = await owner.agent
      .post('/api/photos/shares')
      .set('x-csrf-token', owner.csrfToken)
      .send({
        spaceId: ownerSpace,
        targetKind: 'album',
        targetId: albumId,
        expiresInHours: 24,
        password: 'mare-2024',
        allowDownload: false,
      })
      .expect(201);
    const url = (share.body as { url: string }).url;
    const token = url.split('/').pop()!;
    const server = app.getHttpServer();

    const locked = await request(server).get(`/api/public/shares/${token}`).expect(200);
    expect(locked.body).toMatchObject({ passwordRequired: true, items: [] });
    await request(server).get(`/api/public/shares/${token}/items/${photoId}`).expect(401);
    await request(server)
      .post(`/api/public/shares/${token}/unlock`)
      .send({ password: 'wrong' })
      .expect(401);
    const unlocked = await request(server)
      .post(`/api/public/shares/${token}/unlock`)
      .send({ password: 'mare-2024' })
      .expect(201);
    const grant = (unlocked.body as { grant: string }).grant;
    expect(unlocked.body.items).toHaveLength(1);
    const media = await request(server)
      .get(
        `/api/public/shares/${token}/items/${photoId}?grant=${encodeURIComponent(grant)}&download=1`,
      )
      .expect(200);
    // Download is disabled: content is only served inline.
    expect(media.headers['content-disposition']).toMatch(/^inline/);

    await owner.agent
      .delete(`/api/photos/shares/${(share.body as { id: string }).id}?spaceId=${ownerSpace}`)
      .set('x-csrf-token', owner.csrfToken)
      .expect(200);
    await request(server).get(`/api/public/shares/${token}`).expect(410);
  });

  it('keeps face recognition off for children unless a guardian consents', async () => {
    const own = await child.agent.get(`/api/photos/faces?spaceId=${ownerSpace}`).expect(200);
    expect(own.body).toMatchObject({ enabled: false, isChild: true, engineAvailable: false });
    await child.agent
      .post('/api/photos/faces')
      .set('x-csrf-token', child.csrfToken)
      .send({ spaceId: ownerSpace, enabled: true, consent: true })
      .expect(403);
    await owner.agent
      .post('/api/photos/faces')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, enabled: true })
      .expect(400);
    const guardian = await owner.agent
      .post('/api/photos/faces')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, userId: child.userId, enabled: true, consent: true })
      .expect(201);
    expect(guardian.body).toMatchObject({ enabled: true, consentBy: owner.userId });
    const off = await owner.agent
      .post('/api/photos/faces')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, userId: child.userId, enabled: false })
      .expect(201);
    expect(off.body).toMatchObject({ enabled: false, storedRepresentations: 0 });
  });
});

describe('Stage D journal, memories and encyclopedia', () => {
  let privateId = '';

  it('keeps diaries private from everyone, including space owners', async () => {
    const created = await child.agent
      .post('/api/journal')
      .set('x-csrf-token', child.csrfToken)
      .send({
        spaceId: ownerSpace,
        title: 'Мой секрет',
        body: 'тайный дневник ребёнка',
        visibility: 'private',
      })
      .expect(201);
    privateId = (created.body as { id: string }).id;
    await owner.agent.get(`/api/journal/${privateId}?spaceId=${ownerSpace}`).expect(404);
    const ownerList = await owner.agent.get(`/api/journal?spaceId=${ownerSpace}`).expect(200);
    expect((ownerList.body as Array<{ id: string }>).map((entry) => entry.id)).not.toContain(
      privateId,
    );
    const search = await owner.agent.get(`/api/search?spaceId=${ownerSpace}&q=тайный`).expect(200);
    expect(search.body.results).toHaveLength(0);

    await child.agent
      .patch(`/api/journal/${privateId}`)
      .set('x-csrf-token', child.csrfToken)
      .send({ spaceId: ownerSpace, visibility: 'family' })
      .expect(200);
    await owner.agent.get(`/api/journal/${privateId}?spaceId=${ownerSpace}`).expect(200);
    await owner.agent
      .patch(`/api/journal/${privateId}`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, title: 'чужая правка' })
      .expect(403);
  });

  it('exports and deletes the author’s own entries', async () => {
    const exported = await child.agent.get(`/api/journal/export?spaceId=${ownerSpace}`).expect(200);
    expect(exported.body.entries.length).toBeGreaterThan(0);
    await child.agent
      .delete(`/api/journal/mine?spaceId=${ownerSpace}`)
      .set('x-csrf-token', child.csrfToken)
      .expect(400);
    const removed = await child.agent
      .delete(`/api/journal/mine?spaceId=${ownerSpace}&confirm=DELETE`)
      .set('x-csrf-token', child.csrfToken)
      .expect(200);
    expect(removed.body.deleted).toBeGreaterThan(0);
    await child.agent.get(`/api/journal/${privateId}?spaceId=${ownerSpace}`).expect(404);
  });

  it('shares attachments through family stories (inherited access)', async () => {
    const stories = await child.agent
      .get(`/api/journal?spaceId=${ownerSpace}&kind=story`)
      .expect(200);
    const story = (stories.body as Array<{ id: string; fileIds: string[] }>)[0]!;
    const attachments = await child.agent
      .get(`/api/journal/${story.id}/attachments?spaceId=${ownerSpace}`)
      .expect(200);
    expect(attachments.body).toHaveLength(1);
    // The child has no general file access, but can open the story attachment.
    await child.agent.get(`/api/files/${story.fileIds[0]}?spaceId=${ownerSpace}`).expect(403);
    await child.agent
      .get(`/api/journal/${story.id}/attachments/${story.fileIds[0]}/content?spaceId=${ownerSpace}`)
      .expect(200);
  });

  it('builds memories timeline and on-this-day collections', async () => {
    const timeline = await owner.agent
      .get(`/api/memories/timeline?spaceId=${ownerSpace}`)
      .expect(200);
    const years = (timeline.body as Array<{ year: number }>).map((entry) => entry.year);
    expect(years).toEqual(expect.arrayContaining([2018, 2024]));
    const collections = await owner.agent
      .get(`/api/memories/collections?spaceId=${ownerSpace}&date=2026-07-14`)
      .expect(200);
    const onThisDay = (
      collections.body as Array<{ kind: string; items: Array<{ id: string }> }>
    ).find((entry) => entry.kind === 'on_this_day');
    expect(onThisDay?.items.map((item) => item.id)).toContain(
      (await owner.agent.get(`/api/photos?spaceId=${ownerSpace}&q=beach`)).body[0].id,
    );
  });

  it('manages people, relations, tree, contact privacy and consent-based publication', async () => {
    const tree = await owner.agent.get(`/api/encyclopedia/tree?spaceId=${ownerSpace}`).expect(200);
    const people = tree.body.people as Array<{
      id: string;
      fullName: string;
      generation: number;
      living: boolean;
    }>;
    const grandma = people.find((person) => person.fullName === 'Анна Палермо')!;
    const grandpa = people.find((person) => person.fullName === 'Иван Палермо')!;
    const kid = people.find((person) => person.fullName === 'Ребёнок')!;
    expect(grandma.generation).toBe(0);
    expect(kid.generation).toBe(2);
    expect(grandpa.living).toBe(true);

    // Children read the encyclopedia? No: it is adult-only by default.
    await child.agent.get(`/api/encyclopedia/people?spaceId=${ownerSpace}`).expect(403);

    const cycle = await owner.agent
      .post('/api/encyclopedia/relations')
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, personId: kid.id, relatedPersonId: grandma.id, kind: 'parent' });
    expect(cycle.status).toBe(400);

    const created = await owner.agent
      .post('/api/encyclopedia/people')
      .set('x-csrf-token', owner.csrfToken)
      .send({
        spaceId: ownerSpace,
        fullName: 'Тётя Мария',
        birthDate: '1970-01-01',
        contacts: { phone: '+39 333 0000000' },
        contactVisibility: 'owner',
        visibility: 'private',
      })
      .expect(201);
    const mariaId = (created.body as { id: string }).id;

    const living = await owner.agent
      .post(`/api/encyclopedia/people/${grandpa.id}/publication`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, publish: true });
    expect(living.status).toBe(400);
    await owner.agent
      .post(`/api/encyclopedia/people/${mariaId}/publication`)
      .set('x-csrf-token', owner.csrfToken)
      .send({
        spaceId: ownerSpace,
        publish: true,
        livingConsent: true,
        consentNote: 'согласие устно',
      })
      .expect(403);
    await owner.agent
      .post(`/api/encyclopedia/people/${grandma.id}/publication`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ spaceId: ownerSpace, publish: true })
      .expect(201);
    await owner.agent
      .post(`/api/encyclopedia/people/${grandpa.id}/publication`)
      .set('x-csrf-token', owner.csrfToken)
      .send({
        spaceId: ownerSpace,
        publish: true,
        livingConsent: true,
        consentNote: 'Иван согласился письменно',
      })
      .expect(201);

    const published = await request(app.getHttpServer())
      .get('/api/public/family-people')
      .expect(200);
    const list = published.body as Array<{
      fullName: string;
      birthYear: number | null;
      deathYear: number | null;
    }>;
    expect(list.find((person) => person.fullName === 'Анна Палермо')).toMatchObject({
      birthYear: 1940,
      deathYear: 2019,
    });
    // Living people never expose exact dates or contacts publicly.
    expect(list.find((person) => person.fullName === 'Иван Палермо')).toMatchObject({
      birthYear: null,
    });
    expect(JSON.stringify(published.body)).not.toContain('+39');
    expect(list.some((person) => person.fullName === 'Тётя Мария')).toBe(false);

    const detail = await owner.agent
      .get(`/api/encyclopedia/people/${grandma.id}?spaceId=${ownerSpace}`)
      .expect(200);
    expect(detail.body.links.length).toBeGreaterThanOrEqual(1);
    expect(detail.body.relations.length).toBeGreaterThanOrEqual(2);
  });

  it('respects module permissions in global search and filters by module', async () => {
    const all = await owner.agent.get('/api/search?spaceId=all&q=Палермо').expect(200);
    expect(all.body.searchedModules).toEqual(
      expect.arrayContaining(['files', 'photos', 'encyclopedia']),
    );
    expect(all.body.spaces.length).toBeGreaterThan(1);
    const onlyPeople = await owner.agent
      .get(`/api/search?spaceId=${ownerSpace}&q=Палермо&modules=encyclopedia`)
      .expect(200);
    expect(
      (onlyPeople.body.results as Array<{ module: string }>).every(
        (entry) => entry.module === 'encyclopedia',
      ),
    ).toBe(true);
    const childSearch = await child.agent
      .get(`/api/search?spaceId=${ownerSpace}&q=капонат`)
      .expect(200);
    // The child cannot search files or the encyclopedia, but can read the family story.
    expect(
      childSearch.body.skippedModules.map((entry: { module: string }) => entry.module),
    ).toEqual(expect.arrayContaining(['files', 'encyclopedia']));
    expect(
      (childSearch.body.results as Array<{ module: string }>).map((entry) => entry.module),
    ).toContain('journal');
    const foreign = await adult.agent
      .get(`/api/search?spaceId=${ownerSpace}&q=Палермо`)
      .expect(200);
    expect(foreign.body.results).toHaveLength(0);
  });
});
