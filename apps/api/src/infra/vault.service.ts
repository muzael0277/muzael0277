import { Injectable } from '@nestjs/common';
import { SecretVault, maskSecret, type SealedSecret } from '@bizbot/database';
import { loadEnv } from '@bizbot/config';

/**
 * Wraps SecretVault as an injectable. Third-party credentials — bot tokens, Click and
 * Payme merchant keys — are encrypted at rest and decrypted only inside a provider call
 * (invariant I7).
 */
@Injectable()
export class VaultService {
  private readonly vault: SecretVault;

  constructor() {
    this.vault = new SecretVault(loadEnv().SECRETS_ENCRYPTION_KEY);
  }

  seal(plaintext: string): SealedSecret {
    return this.vault.seal(plaintext);
  }

  open(sealed: SealedSecret): string {
    return this.vault.open(sealed);
  }

  /** Seals a credential map for Integration.secretCipher. */
  sealJson(value: Record<string, string>): SealedSecret {
    return this.vault.seal(JSON.stringify(value));
  }

  openJson(sealed: SealedSecret): Record<string, string> {
    return JSON.parse(this.vault.open(sealed)) as Record<string, string>;
  }

  mask(value: string): string {
    return maskSecret(value);
  }

  needsRotation(sealed: SealedSecret): boolean {
    return this.vault.needsRotation(sealed);
  }
}
