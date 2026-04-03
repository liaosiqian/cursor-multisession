import crypto from "node:crypto";
import fs from "node:fs";
import { ClawBotClient } from '../api/client';
import { UploadMediaType, type CDNMedia, type MessageItem } from '../api/types';
import { logger } from '../util/logger';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

function aesEncrypt(data: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function md5(data: Buffer): string {
  return crypto.createHash("md5").update(data).digest("hex");
}

export interface UploadResult {
  downloadParam: string;
  aesKeyHex: string;
  aesKeyBase64: string;
  rawSize: number;
  fileSize: number;
  rawMd5: string;
  filekey: string;
}

export class MediaService {
  private client: ClawBotClient;

  constructor(client: ClawBotClient) {
    this.client = client;
  }

  async upload(
    filePath: string,
    toUserId: string,
    mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType],
  ): Promise<UploadResult> {
    let st: fs.Stats;
    try {
      st = fs.statSync(filePath);
    } catch (e) {
      throw new Error(
        `cannot read file for upload: ${filePath} (${e instanceof Error ? e.message : String(e)})`,
      );
    }

    if (st.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `file exceeds ${MAX_UPLOAD_BYTES} byte limit (${st.size} bytes): ${filePath}`,
      );
    }

    const raw = fs.readFileSync(filePath);
    const aesKeyBuf = crypto.randomBytes(16);
    const aesKeyHex = aesKeyBuf.toString("hex");
    const aesKeyBase64 = aesKeyBuf.toString("base64");
    const encrypted = aesEncrypt(raw, aesKeyBuf);
    const rawMd5 = md5(raw);
    const filekey = crypto.randomBytes(16).toString("hex");

    const resp = await this.client.getUploadUrl({
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: raw.length,
      rawfilemd5: rawMd5,
      filesize: encrypted.length,
      no_need_thumb: true,
      aeskey: aesKeyHex,
    });

    let cdnUrl: string;
    if (resp.upload_param) {
      cdnUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(resp.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
    } else if (resp.upload_full_url) {
      cdnUrl = resp.upload_full_url;
    } else {
      const detail = [resp.errmsg, resp.ret != null ? `ret=${resp.ret}` : ""]
        .filter(Boolean)
        .join(" ");
      throw new Error(
        `getUploadUrl returned neither upload_param nor upload_full_url${detail ? `: ${detail}` : ""}`,
      );
    }

    const uploadRes = await fetch(cdnUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(encrypted),
    });

    if (!uploadRes.ok) {
      const errMsg = uploadRes.headers.get("x-error-message") ?? await uploadRes.text();
      throw new Error(`CDN upload failed: HTTP ${uploadRes.status} — ${errMsg}`);
    }

    const downloadParam = uploadRes.headers.get("x-encrypted-param");
    if (!downloadParam) {
      throw new Error("CDN upload response missing x-encrypted-param header");
    }

    logger.info(
      {
        filePath,
        mediaType,
        rawSize: raw.length,
        encSize: encrypted.length,
        hasDownloadParam: true,
      },
      "file uploaded to CDN",
    );

    return {
      downloadParam,
      aesKeyHex,
      aesKeyBase64,
      rawSize: raw.length,
      fileSize: encrypted.length,
      rawMd5,
      filekey,
    };
  }

  async download(media: CDNMedia, aesKey?: string): Promise<Buffer> {
    let url: string;
    if (media.full_url) {
      url = media.full_url;
    } else if (media.encrypt_query_param) {
      url = `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
    } else {
      throw new Error("CDNMedia has no full_url or encrypt_query_param");
    }

    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`CDN download failed: HTTP ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
    }

    const buf = await res.arrayBuffer();
    const data = Buffer.from(buf);

    if (aesKey) {
      let keyBuf: Buffer;
      if (aesKey.length === 32 && /^[0-9a-f]+$/i.test(aesKey)) {
        keyBuf = Buffer.from(aesKey, "hex");
      } else {
        const decoded = Buffer.from(aesKey, "base64");
        if (decoded.length === 16) {
          keyBuf = decoded;
        } else if (decoded.length === 32) {
          keyBuf = Buffer.from(decoded.toString("utf-8"), "hex");
        } else {
          throw new Error(`Invalid AES key length: ${decoded.length}`);
        }
      }
      const decipher = crypto.createDecipheriv("aes-128-ecb", keyBuf, null);
      decipher.setAutoPadding(true);
      return Buffer.concat([decipher.update(data), decipher.final()]);
    }

    return data;
  }

  buildImageItem(upload: UploadResult): MessageItem {
    return {
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: upload.downloadParam,
          aes_key: Buffer.from(upload.aesKeyHex).toString("base64"),
          encrypt_type: 1,
        },
        mid_size: upload.fileSize,
      },
    };
  }

  buildFileItem(upload: UploadResult, fileName: string): MessageItem {
    return {
      type: 4,
      file_item: {
        media: {
          encrypt_query_param: upload.downloadParam,
          aes_key: Buffer.from(upload.aesKeyHex).toString("base64"),
          encrypt_type: 1,
        },
        file_name: fileName,
        len: String(upload.fileSize),
      },
    };
  }

  buildVideoItem(upload: UploadResult): MessageItem {
    return {
      type: 5,
      video_item: {
        media: {
          encrypt_query_param: upload.downloadParam,
          aes_key: Buffer.from(upload.aesKeyHex).toString("base64"),
          encrypt_type: 1,
        },
        video_size: upload.fileSize,
      },
    };
  }
}
