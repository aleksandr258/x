import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function collectTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

function extractModuleSpecifiers(sourceCode: string): string[] {
  const regex = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const specs: string[] = [];
  for (const match of sourceCode.matchAll(regex)) {
    if (match[1]) {
      specs.push(match[1]);
    }
  }
  return specs;
}

describe('Hexagonal Architecture Layer Boundaries', () => {
  const srcRoot = path.resolve(import.meta.dirname, '../src');

  it('enforces zero external or outer-layer imports in src/domain/**', () => {
    const domainFiles = collectTsFiles(path.join(srcRoot, 'domain'));
    expect(domainFiles.length).toBeGreaterThan(0);

    for (const file of domainFiles) {
      const code = fs.readFileSync(file, 'utf8');
      const imports = extractModuleSpecifiers(code);

      for (const spec of imports) {
        // Domain files may ONLY import relative files inside src/domain
        expect(
          spec.startsWith('.'),
          `Domain file ${path.relative(srcRoot, file)} imported external package "${spec}"`,
        ).toBe(true);

        const resolved = path.resolve(path.dirname(file), spec);
        expect(
          resolved.startsWith(path.join(srcRoot, 'domain')),
          `Domain file ${path.relative(srcRoot, file)} imported outside domain: "${spec}"`,
        ).toBe(true);
      }
    }
  });

  it('enforces that src/application/** never imports from infrastructure, config, or I/O packages', () => {
    const appFiles = collectTsFiles(path.join(srcRoot, 'application'));
    expect(appFiles.length).toBeGreaterThan(0);

    for (const file of appFiles) {
      const code = fs.readFileSync(file, 'utf8');
      const imports = extractModuleSpecifiers(code);

      for (const spec of imports) {
        expect(
          spec.startsWith('.'),
          `Application file ${path.relative(srcRoot, file)} imported external package "${spec}"`,
        ).toBe(true);

        const resolved = path.resolve(path.dirname(file), spec);
        const insideDomainOrApp =
          resolved.startsWith(path.join(srcRoot, 'domain')) ||
          resolved.startsWith(path.join(srcRoot, 'application'));

        expect(
          insideDomainOrApp,
          `Application file ${path.relative(srcRoot, file)} violated Hexagonal boundary via "${spec}"`,
        ).toBe(true);
      }
    }
  });
});
