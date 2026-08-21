export class FileSecretStateLookup {
  private acknowledged = new Set<string>();

  acknowledge(relPath: string): void {
    this.acknowledged.add(relPath);
  }

  isAcknowledged(relPath: string): boolean {
    return this.acknowledged.has(relPath);
  }
}
