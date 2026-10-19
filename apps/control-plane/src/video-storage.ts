import { readFileSync } from "node:fs";
import { S3Client, ListObjectsV2Command, HeadObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Principal } from "./auth.js";
import type { ControlPlaneDatabase } from "./db.js";
import { AppError, invariant } from "./errors.js";

export interface VideoStorageConfig {
  workspaceId: string; label: string; endpoint: string; region: string; bucket: string;
  prefix: string; quotaBytes: number; accessKeyId: string; secretAccessKey: string;
}
export function readVideoStorageConfig(path?: string): VideoStorageConfig | undefined {
  if (!path) return;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as VideoStorageConfig;
    invariant(value && [value.workspaceId, value.label, value.region, value.accessKeyId, value.secretAccessKey].every(x => typeof x === "string" && x.length > 0) &&
      typeof value.endpoint === "string" && /^https:\/\//.test(value.endpoint) &&
      /^[a-z0-9][a-z0-9-]{2,62}$/.test(value.bucket) && typeof value.prefix === "string" && /^[a-zA-Z0-9/_-]+\/$/.test(value.prefix) &&
      Number.isSafeInteger(value.quotaBytes) && value.quotaBytes > 0,
      503, "VIDEO_STORAGE_CONFIG_INVALID", "视频存储配置无效，请联系管理员");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new AppError(503, "VIDEO_STORAGE_CONFIG_INVALID", "视频存储配置无效，请联系管理员");
  }
}

/** Only server-owned credentials/configuration. Never accept endpoints or bucket names from a browser. */
export class VideoStorage {
  constructor(private readonly db: ControlPlaneDatabase, private readonly config: VideoStorageConfig | undefined,
    private readonly client?: Pick<S3Client, "send">, private readonly now = () => Date.now()) {}
  private scope(principal: Principal) {
    invariant(this.config && this.config.workspaceId === principal.workspaceId, 404, "VIDEO_STORAGE_UNAVAILABLE", "此工作区尚未配置视频存储");
    return this.config;
  }
  private key(principal: Principal, value: unknown) {
    const config = this.scope(principal);
    invariant(typeof value === "string" && value.startsWith(config.prefix) && value.length > config.prefix.length && Buffer.byteLength(value) <= 1024 &&
      !value.split("/").some(part => part === "." || part === "..") && !/[\x00-\x1f\x7f\\]/.test(value),
      400, "VIDEO_STORAGE_KEY_INVALID", "请选择列表中的视频文件");
    return value;
  }
  private async run<T>(principal: Principal, action: (client: Pick<S3Client, "send">, config: VideoStorageConfig) => Promise<T>): Promise<T> {
    const config = this.scope(principal);
    const client = this.client ?? new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, maxAttempts: 2,
      requestHandler: { requestTimeout: 15_000, connectionTimeout: 5_000 } });
    try { return await action(client, config); }
    catch (error) {
      if (error instanceof AppError) throw error;
      // Do not leak signed URLs, request headers or credentials through logs/errors.
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
        throw new AppError(404, "VIDEO_STORAGE_NOT_FOUND", "文件已不存在，请刷新列表");
      throw new AppError(503, "VIDEO_STORAGE_FAILED", "视频存储暂时不可用，请稍后重试");
    } finally { if (!this.client) (client as S3Client).destroy(); }
  }
  async list(principal: Principal, cursor?: unknown) {
    if (!this.config || this.config.workspaceId !== principal.workspaceId) return { configured: false as const, items: [], nextCursor: null };
    invariant(cursor === undefined || (typeof cursor === "string" && cursor.length <= 4096), 400, "VIDEO_STORAGE_CURSOR_INVALID", "分页参数无效");
    return this.run(principal, async (client, config) => {
      const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: config.prefix, MaxKeys: 20,
        ...(cursor ? { ContinuationToken: cursor as string } : {}) }));
      return { configured: true as const, label: config.label, quotaBytes: config.quotaBytes,
        items: (page.Contents ?? []).filter(item => item.Key?.startsWith(config.prefix)).map(item => ({ key: item.Key!, bytes: item.Size ?? 0,
          etag: item.ETag ?? "", modifiedAt: item.LastModified?.toISOString() ?? null,
          canDelete: Boolean(item.ETag && item.LastModified && this.now() - item.LastModified.getTime() >= 60_000) })),
        nextCursor: page.IsTruncated ? page.NextContinuationToken ?? null : null };
    });
  }
  async download(principal: Principal, input: Record<string, unknown>) {
    const key = this.key(principal, input.key);
    return this.run(principal, async (client, config) => {
      await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      const url = await getSignedUrl(client as S3Client, new GetObjectCommand({ Bucket: config.bucket, Key: key,
        ResponseContentDisposition: "attachment", ResponseContentType: "application/octet-stream" }), { expiresIn: 300 });
      return { url, expiresIn: 300 };
    });
  }
  async remove(principal: Principal, input: Record<string, unknown>) {
    const key = this.key(principal, input.key);
    invariant(typeof input.etag === "string" && input.etag.length > 0 && input.etag.length <= 200 && typeof input.modifiedAt === "string" &&
      Number.isSafeInteger(input.bytes) && Number(input.bytes) >= 0 && input.confirm === true,
      400, "VIDEO_STORAGE_DELETE_INVALID", "请先核对文件信息并确认删除");
    return this.run(principal, async (client, config) => {
      const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      invariant(head.ETag === input.etag && head.ContentLength === input.bytes && head.LastModified?.toISOString() === input.modifiedAt,
        409, "VIDEO_STORAGE_CHANGED", "文件已变化，请刷新后重新确认");
      invariant(head.LastModified && this.now() - head.LastModified.getTime() >= 60_000,
        409, "VIDEO_STORAGE_RECENT", "文件刚写入，请一分钟后刷新再删除");
      this.db.audit({ workspaceId: principal.workspaceId, actorUserId: principal.userId, actorClientSessionId: principal.clientSessionId,
        action: "video.storage.delete.requested", metadata: { key, bytes: input.bytes, etag: input.etag } });
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key, IfMatch: input.etag as string }));
      this.db.audit({ workspaceId: principal.workspaceId, actorUserId: principal.userId, actorClientSessionId: principal.clientSessionId,
        action: "video.storage.deleted", metadata: { key, bytes: input.bytes, etag: input.etag } });
      return { deleted: true };
    });
  }
}
