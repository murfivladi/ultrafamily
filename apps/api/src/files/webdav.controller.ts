import {
  All,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpStatus,
  MethodNotAllowedException,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  PreconditionFailedException,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthenticatedUser } from '../common/authed-request';
import { Public } from '../common/public.decorator';
import { config, newId } from '../config';
import type { FileRow, FolderRow } from '../stage-d/mappers';
import { StorageService } from '../storage/storage.service';
import { sendContent } from './content-response';
import { FilesService } from './files.service';

const REALM = 'Basic realm="Ultra Family OS WebDAV", charset="UTF-8"';

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function basicToken(request: Request, response: Response): string {
  const header = request.headers.authorization;
  if (!header?.startsWith('Basic ')) {
    response.setHeader('WWW-Authenticate', REALM);
    throw new UnauthorizedException('webdav_basic_auth_required');
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const token = decoded.slice(decoded.indexOf(':') + 1);
  if (!token) {
    response.setHeader('WWW-Authenticate', REALM);
    throw new UnauthorizedException('webdav_token_required');
  }
  return token;
}

/** Splits `/api/webdav/<space>/a/b` into decoded, validated segments. */
function segmentsFrom(pathname: string, spaceId: string): string[] {
  const prefix = `/api/webdav/${spaceId}`;
  const index = pathname.indexOf(prefix);
  if (index < 0) return [];
  const rest = pathname.slice(index + prefix.length);
  const segments = rest
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        throw new NotFoundException('webdav_bad_path');
      }
      if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
        throw new ForbiddenException('webdav_bad_path');
      }
      return decoded;
    });
  return segments;
}

function hrefFor(spaceId: string, segments: string[], collection: boolean): string {
  const path = segments.map((segment) => encodeURIComponent(segment)).join('/');
  return `/api/webdav/${spaceId}/${path}${collection && path ? '/' : ''}`;
}

function httpDate(value: Date | string): string {
  return new Date(value).toUTCString();
}

function folderResponse(href: string, name: string, row?: FolderRow): string {
  return `<D:response><D:href>${xml(href)}</D:href><D:propstat><D:prop>
<D:displayname>${xml(name)}</D:displayname>
<D:resourcetype><D:collection/></D:resourcetype>
${row ? `<D:getlastmodified>${httpDate(row.updated_at)}</D:getlastmodified><D:creationdate>${new Date(row.created_at).toISOString()}</D:creationdate>` : ''}
<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>
</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function fileResponse(href: string, row: FileRow): string {
  return `<D:response><D:href>${xml(href)}</D:href><D:propstat><D:prop>
<D:displayname>${xml(row.name)}</D:displayname>
<D:resourcetype/>
<D:getcontentlength>${Number(row.size_bytes)}</D:getcontentlength>
<D:getcontenttype>${xml(row.mime_type.split(';')[0] ?? 'application/octet-stream')}</D:getcontenttype>
<D:getetag>"${xml(row.sha256)}-${Number(row.version)}"</D:getetag>
<D:getlastmodified>${httpDate(row.updated_at)}</D:getlastmodified>
<D:creationdate>${new Date(row.created_at).toISOString()}</D:creationdate>
<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>
</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function multistatus(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${body}</D:multistatus>`;
}

/**
 * WebDAV mount of a space's file storage for device sync (Finder, Windows
 * Explorer, rclone, mobile file managers). Authentication uses per-space app
 * tokens over HTTP Basic; every operation goes through FilesService, so the
 * same role/module checks, quotas, type validation, versions and trash apply.
 */
@Public()
@Controller('webdav')
export class WebDavController {
  constructor(
    private readonly files: FilesService,
    private readonly storage: StorageService,
  ) {}

  @All(':spaceId')
  root(@Req() request: Request, @Res() response: Response, @Param('spaceId') spaceId: string) {
    return this.handle(request, response, spaceId);
  }

  @All(':spaceId/*path')
  nested(@Req() request: Request, @Res() response: Response, @Param('spaceId') spaceId: string) {
    return this.handle(request, response, spaceId);
  }

  private async handle(request: Request, response: Response, spaceId: string): Promise<void> {
    const method = request.method.toUpperCase();
    response.setHeader('DAV', '1, 2');
    response.setHeader('MS-Author-Via', 'DAV');
    response.setHeader(
      'Allow',
      'OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK',
    );
    response.setHeader('Cache-Control', 'no-store');
    if (method === 'OPTIONS') {
      response.status(HttpStatus.OK).send();
      return;
    }
    const token = basicToken(request, response);
    const context = await this.files.webdavContext(token, spaceId).catch((error: unknown) => {
      response.setHeader('WWW-Authenticate', REALM);
      throw error;
    });
    const user = context.user;
    const segments = segmentsFrom(request.path, spaceId);
    const writeMethods = ['PUT', 'DELETE', 'MKCOL', 'MOVE', 'COPY', 'PROPPATCH'];
    if (context.readOnly && writeMethods.includes(method)) {
      throw new ForbiddenException('webdav_token_read_only');
    }
    const target = await this.files.resolvePath(user, spaceId, segments);

    switch (method) {
      case 'PROPFIND':
        return this.propfind(request, response, user, spaceId, segments, target);
      case 'GET':
      case 'HEAD': {
        if (target.type !== 'file') throw new MethodNotAllowedException('webdav_not_a_file');
        const content = await this.files.content(user, spaceId, target.file.id);
        sendContent(request, response, this.storage.adapter, {
          key: content.key,
          size: content.size,
          mime: content.mime,
          name: content.file.name,
          sha256: content.file.sha256,
          inline: false,
        });
        return;
      }
      case 'PUT':
        return this.put(request, response, user, spaceId, segments, target);
      case 'DELETE': {
        if (target.type === 'file') await this.files.trashFile(user, spaceId, target.file.id);
        else if (target.type === 'folder')
          await this.files.trashFolder(user, spaceId, target.folder.id);
        else if (target.type === 'root') throw new ForbiddenException('webdav_cannot_delete_root');
        else throw new NotFoundException('webdav_not_found');
        response.status(HttpStatus.NO_CONTENT).send();
        return;
      }
      case 'MKCOL': {
        if (target.type !== 'missing') throw new MethodNotAllowedException('webdav_already_exists');
        if (target.parentMissing) throw new ConflictException('webdav_parent_missing');
        await this.files.createFolder(user, spaceId, {
          name: target.name,
          parentId: target.parentId,
        });
        response.status(HttpStatus.CREATED).send();
        return;
      }
      case 'MOVE':
      case 'COPY':
        return this.moveOrCopy(request, response, user, spaceId, target, method === 'COPY');
      case 'LOCK': {
        // Advisory lock only: lets Finder/Explorer write. Real conflicts are
        // handled by versions (every PUT creates a new file version).
        const lockToken = `opaquelocktoken:${newId('lck').slice(4)}`;
        response.setHeader('Lock-Token', `<${lockToken}>`);
        response.type('application/xml; charset=utf-8');
        response.status(target.type === 'missing' ? HttpStatus.CREATED : HttpStatus.OK).send(
          `<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>
<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth>
<D:owner>${xml(user.displayName)}</D:owner><D:timeout>Second-3600</D:timeout>
<D:locktoken><D:href>${lockToken}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`,
        );
        return;
      }
      case 'UNLOCK':
        response.status(HttpStatus.NO_CONTENT).send();
        return;
      case 'PROPPATCH': {
        // Dead properties (e.g. Windows timestamps) are acknowledged, not stored.
        response.type('application/xml; charset=utf-8');
        response
          .status(HttpStatus.MULTI_STATUS)
          .send(
            multistatus(
              `<D:response><D:href>${xml(request.path)}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
            ),
          );
        return;
      }
      default:
        throw new MethodNotAllowedException('webdav_method_not_supported');
    }
  }

  private async propfind(
    request: Request,
    response: Response,
    user: AuthenticatedUser,
    spaceId: string,
    segments: string[],
    target: Awaited<ReturnType<FilesService['resolvePath']>>,
  ): Promise<void> {
    await this.drain(request, 64 * 1024);
    const depth = String(request.headers.depth ?? '1');
    let body = '';
    if (target.type === 'missing') throw new NotFoundException('webdav_not_found');
    if (target.type === 'file') {
      body = fileResponse(hrefFor(spaceId, segments, false), target.file);
    } else {
      const folderId = target.type === 'folder' ? target.folder.id : null;
      body = folderResponse(
        hrefFor(spaceId, segments, true),
        target.type === 'folder' ? target.folder.name : spaceId,
        target.type === 'folder' ? target.folder : undefined,
      );
      if (depth !== '0') {
        const children = await this.files.folderChildren(user, spaceId, folderId);
        for (const folder of children.folders) {
          body += folderResponse(
            hrefFor(spaceId, [...segments, folder.name], true),
            folder.name,
            folder,
          );
        }
        for (const file of children.files) {
          body += fileResponse(hrefFor(spaceId, [...segments, file.name], false), file);
        }
      }
    }
    response.type('application/xml; charset=utf-8');
    response.status(HttpStatus.MULTI_STATUS).send(multistatus(body));
  }

  private async put(
    request: Request,
    response: Response,
    user: AuthenticatedUser,
    spaceId: string,
    segments: string[],
    target: Awaited<ReturnType<FilesService['resolvePath']>>,
  ): Promise<void> {
    if (target.type === 'folder' || target.type === 'root') {
      throw new MethodNotAllowedException('webdav_put_on_collection');
    }
    if (target.type === 'missing' && target.parentMissing) {
      throw new ConflictException('webdav_parent_missing');
    }
    const tempKey = `tmp/${newId('dav')}`;
    const size = await this.streamToKey(request, tempKey);
    const name = segments[segments.length - 1]!;
    await this.files.storeTempKey(user, spaceId, tempKey, size, {
      folderId: target.parentId,
      name,
      visibility: 'space',
      onConflict: 'version',
      module: 'files',
      note: 'webdav',
      targetFileId: target.type === 'file' ? target.file.id : null,
    });
    response.status(target.type === 'file' ? HttpStatus.NO_CONTENT : HttpStatus.CREATED).send();
  }

  private async moveOrCopy(
    request: Request,
    response: Response,
    user: AuthenticatedUser,
    spaceId: string,
    source: Awaited<ReturnType<FilesService['resolvePath']>>,
    copy: boolean,
  ): Promise<void> {
    if (source.type === 'missing') throw new NotFoundException('webdav_not_found');
    if (source.type === 'root') throw new ForbiddenException('webdav_cannot_move_root');
    const destinationHeader = String(request.headers.destination ?? '');
    if (!destinationHeader) throw new ConflictException('webdav_destination_required');
    let destinationPath: string;
    try {
      destinationPath = new URL(destinationHeader, 'http://placeholder').pathname;
    } catch {
      throw new ConflictException('webdav_bad_destination');
    }
    if (!destinationPath.includes(`/api/webdav/${spaceId}`)) {
      throw new ForbiddenException('webdav_cross_space_move');
    }
    const destinationSegments = segmentsFrom(destinationPath, spaceId);
    if (destinationSegments.length === 0) throw new ForbiddenException('webdav_bad_destination');
    const destination = await this.files.resolvePath(user, spaceId, destinationSegments);
    const overwrite = String(request.headers.overwrite ?? 'T').toUpperCase() !== 'F';
    if (destination.type === 'missing' && destination.parentMissing) {
      throw new ConflictException('webdav_parent_missing');
    }
    const existed = destination.type === 'file' || destination.type === 'folder';
    if (existed && !overwrite) throw new PreconditionFailedException('webdav_destination_exists');
    const newName = destinationSegments[destinationSegments.length - 1]!;
    const parentId = destination.parentId;

    if (copy) {
      if (source.type !== 'file') throw new ForbiddenException('webdav_folder_copy_not_supported');
      const tempKey = `tmp/${newId('cpy')}`;
      const content = await this.files.content(user, spaceId, source.file.id);
      await this.storage.adapter.copy(content.key, tempKey);
      await this.files.storeTempKey(user, spaceId, tempKey, content.size, {
        folderId: parentId,
        name: newName,
        visibility: 'space',
        onConflict: 'version',
        module: 'files',
        note: 'webdav-copy',
        targetFileId: destination.type === 'file' ? destination.file.id : null,
      });
    } else {
      if (existed) {
        if (destination.type === 'file')
          await this.files.trashFile(user, spaceId, destination.file.id);
        if (destination.type === 'folder')
          await this.files.trashFolder(user, spaceId, destination.folder.id);
      }
      if (source.type === 'file') {
        await this.files.update(user, spaceId, source.file.id, {
          name: newName,
          folderId: parentId,
        });
      } else {
        await this.files.updateFolder(user, spaceId, source.folder.id, { name: newName, parentId });
      }
    }
    response.status(existed ? HttpStatus.NO_CONTENT : HttpStatus.CREATED).send();
  }

  /** Streams the request body into storage without buffering it in memory. */
  private async streamToKey(request: Request, key: string): Promise<number> {
    await this.storage.adapter.put(key, Buffer.alloc(0));
    let size = 0;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      if (pendingBytes === 0) return;
      const data = Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      await this.storage.adapter.append(key, data);
    };
    try {
      for await (const chunk of request as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > config.storage.maxFileBytes)
          throw new PayloadTooLargeException('file_too_large');
        pending.push(chunk);
        pendingBytes += chunk.length;
        if (pendingBytes >= 4 * 1024 * 1024) await flush();
      }
      await flush();
    } catch (error) {
      await this.storage.adapter.delete(key);
      throw error;
    }
    return size;
  }

  private async drain(request: Request, limit: number): Promise<void> {
    let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > limit) throw new PayloadTooLargeException('webdav_body_too_large');
    }
  }
}
