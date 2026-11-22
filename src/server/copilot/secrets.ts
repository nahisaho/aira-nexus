import type { Principal } from '../../shared/contracts.js';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CopilotError } from './errors.js';

/** @id CODE-CON-002 @implements REQ-CON-004 */
export class TokenVault {
  private readonly key: Buffer;
  constructor(key: string) {
    this.key = Buffer.from(key, 'base64');
    if (this.key.length !== 32 || this.key.toString('base64') !== key)
      throw new Error('Invalid Copilot encryption key.');
  }
  private aad(owner: Principal, id: string, purpose: string) {
    return Buffer.from(
      JSON.stringify([
        owner.tenantId.toLowerCase(),
        owner.objectId.toLowerCase(),
        id.toLowerCase(),
        purpose,
      ]),
    );
  }
  seal(owner: Principal, id: string, purpose: string, plaintext: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(this.aad(owner, id, purpose));
    const bytes = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      'v1',
      nonce.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      bytes.toString('base64'),
    ].join('.');
  }
  open(owner: Principal, id: string, purpose: string, ciphertext: string): string {
    try {
      const [version, nonce, tag, body, extra] = ciphertext.split('.');
      if (version !== 'v1' || !nonce || !tag || !body || extra !== undefined)
        throw new Error('Invalid encrypted record.');
      const n = Buffer.from(nonce, 'base64'),
        t = Buffer.from(tag, 'base64'),
        b = Buffer.from(body, 'base64');
      if (
        n.length !== 12 ||
        t.length !== 16 ||
        n.toString('base64') !== nonce ||
        t.toString('base64') !== tag ||
        b.toString('base64') !== body
      )
        throw new Error('Invalid encrypted record.');
      const decipher = createDecipheriv('aes-256-gcm', this.key, n);
      decipher.setAAD(this.aad(owner, id, purpose));
      decipher.setAuthTag(t);
      return Buffer.concat([decipher.update(b), decipher.final()]).toString('utf8');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new CopilotError(
        503,
        'COPILOT_SECRET_UNAVAILABLE',
        'Stored GitHub credentials could not be read. Contact the administrator.',
      );
    }
  }
}
