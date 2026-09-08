import { common } from '@kit.AbilityKit';
import { fileIo, picker } from '@kit.CoreFileKit';

export interface PickedMobileFile {
  id: string;
  uri: string;
  fileName: string;
  mimeType: string;
  bytes: number;
}

export class AttachmentService {
  static async pickDocument(context: common.UIAbilityContext): Promise<PickedMobileFile | null> {
    const options = new picker.DocumentSelectOptions();
    options.maxSelectNumber = 1;
    options.fileSuffixFilters = [
      '文档|txt,md,log,json,jsonl,yaml,yml,toml,xml,csv,tsv,ini,cfg,conf,sql,pdf,doc,docx,xls,xlsx,ppt,pptx',
      '代码|html,css,js,mjs,cjs,jsx,ts,tsx,py,java,kt,kts,c,cc,cpp,h,hpp,cs,go,rs,sh,ps1,bat,cmd'
    ];
    const uris = await new picker.DocumentViewPicker(context).select(options);
    if (uris.length === 0) {
      return null;
    }
    const uri = uris[0];
    const fileName = AttachmentService.fileNameFromUri(uri);
    AttachmentService.assertPermittedFileName(fileName);
    const file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    try {
      const stat = fileIo.statSync(file.fd);
      const bytes = Number(stat.size);
      if (!Number.isFinite(bytes) || bytes <= 0) {
        throw new Error('文件为空');
      }
      if (bytes > 10 * 1024 * 1024) {
        throw new Error('文件超过 10MB，请压缩或拆分后发送');
      }
      return {
        id: `file-${Date.now()}`,
        uri,
        fileName,
        mimeType: AttachmentService.mimeType(fileName),
        bytes
      };
    } finally {
      fileIo.closeSync(file);
    }
  }

  static readAsBase64(uri: string, maxBytes: number = 10 * 1024 * 1024): string {
    const file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    try {
      const stat = fileIo.statSync(file.fd);
      const size = Number(stat.size);
      if (!Number.isFinite(size) || size <= 0) {
        throw new Error('文件为空');
      }
      if (size > maxBytes) {
        throw new Error('文件超过 10MB 上传限制');
      }
      const buffer = new ArrayBuffer(size);
      const readSize = fileIo.readSync(file.fd, buffer);
      return AttachmentService.base64Encode(new Uint8Array(buffer.slice(0, readSize)));
    } finally {
      fileIo.closeSync(file);
    }
  }

  private static fileNameFromUri(uri: string): string {
    const normalized = String(uri ?? '').split('?')[0];
    const segments = normalized.split('/');
    const encoded = segments.length > 0 ? segments[segments.length - 1] : 'attachment.txt';
    try {
      return decodeURIComponent(encoded);
    } catch (_) {
      return encoded;
    }
  }

  private static assertPermittedFileName(fileName: string): void {
    const lower = fileName.toLowerCase();
    if (lower === '.env'
      || lower.startsWith('.env.')
      || /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(lower)
      || /\.(pem|key|p12|pfx|jks|keystore|mobileprovision)$/.test(lower)
      || /(^|[._-])(credential|credentials|secrets?|tokens?)([._-]|$)/.test(lower)) {
      throw new Error('为保护凭据，该敏感文件不能上传');
    }
  }

  private static mimeType(fileName: string): string {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.pdf')) return 'application/pdf';
    if (lower.endsWith('.json') || lower.endsWith('.jsonl')) return 'application/json';
    if (lower.endsWith('.csv')) return 'text/csv';
    if (lower.endsWith('.html')) return 'text/html';
    if (lower.endsWith('.xml')) return 'application/xml';
    return 'text/plain';
  }

  private static base64Encode(bytes: Uint8Array): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let output = '';
    for (let index = 0; index < bytes.length; index += 3) {
      const first = bytes[index];
      const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
      const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
      const triple = (first << 16) | (second << 8) | third;
      output += alphabet.charAt((triple >> 18) & 0x3F);
      output += alphabet.charAt((triple >> 12) & 0x3F);
      output += index + 1 < bytes.length ? alphabet.charAt((triple >> 6) & 0x3F) : '=';
      output += index + 2 < bytes.length ? alphabet.charAt(triple & 0x3F) : '=';
    }
    return output;
  }
}
