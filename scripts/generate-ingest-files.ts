import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

interface FileInfo {
  relPath: string;
  absPath: string;
  lines: number;
  content: string;
}

function shouldIgnore(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/');
  if (
    norm.startsWith('.git/') ||
    norm.startsWith('.next/') ||
    norm.startsWith('node_modules/') ||
    norm.startsWith('audit-screenshots/') ||
    norm.startsWith('.superpowers/') ||
    norm.startsWith('.claude/') ||
    norm.startsWith('.codegraph/') ||
    norm.includes('/.system_generated/') ||
    norm.endsWith('.png') ||
    norm.endsWith('.pdf') ||
    norm.endsWith('.ico') ||
    norm.endsWith('.tsbuildinfo') ||
    norm.endsWith('.log') ||
    norm === 'package-lock.json'
  ) {
    return true;
  }
  return false;
}

function walkDir(dir: string, fileList: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const rel = path.relative(ROOT, fullPath);
    if (shouldIgnore(rel)) continue;
    if (entry.isDirectory()) {
      walkDir(fullPath, fileList);
    } else if (entry.isFile()) {
      fileList.push(rel);
    }
  }
  return fileList;
}

function getFileSummaryAndExports(content: string): { summary: string; exports: string[] } {
  const lines = content.split('\n');
  const summaryLines: string[] = [];
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    summaryLines.push(lines[i].replace(/\r$/, ''));
  }
  const summary = summaryLines.join('\n');

  const exports: string[] = [];
  const exportRegex = /^export\s+(const|function|class|type|interface|enum|async\s+function|default)\s+([a-zA-Z0-9_$]+)/gm;
  let match;
  while ((match = exportRegex.exec(content)) !== null) {
    exports.push(match[2]);
  }
  return { summary, exports };
}

function writeChunkedFiles(baseName: string, rawItems: string[], maxLinesPerFile = 2000) {
  // Flatten raw items so every entry in allLines is truly one line of text
  const allLines: string[] = [];
  for (const item of rawItems) {
    const split = item.split(/\r?\n/);
    for (const line of split) {
      allLines.push(line);
    }
  }

  // Also write the unified complete file for completeness
  fs.writeFileSync(path.join(ROOT, `${baseName}.md`), allLines.join('\n'), 'utf8');
  console.log(`✓ Wrote complete ${baseName}.md (${allLines.length} lines)`);

  if (allLines.length <= maxLinesPerFile) {
    return;
  }

  const totalParts = Math.ceil(allLines.length / maxLinesPerFile);
  for (let part = 1; part <= totalParts; part++) {
    const start = (part - 1) * maxLinesPerFile;
    const end = Math.min(part * maxLinesPerFile, allLines.length);
    const chunkLines = allLines.slice(start, end);
    const fileName = `${baseName}-part${part}.md`;

    const header = [
      `# ${baseName} (Part ${part} of ${totalParts})`,
      `> Continuation Header: Lines ${start + 1} to ${end} of total ${allLines.length} lines.`,
      part > 1 ? `> Continued from \`${baseName}-part${part - 1}.md\`` : '',
      part < totalParts ? `> Continues in \`${baseName}-part${part + 1}.md\`` : '',
      '',
      '---',
      '',
    ].filter(Boolean);

    const fullContent = [...header, ...chunkLines].join('\n');
    fs.writeFileSync(path.join(ROOT, fileName), fullContent, 'utf8');
    console.log(`✓ Wrote ${fileName} (${chunkLines.length} lines)`);
  }
}

async function main() {
  console.log('Building Ingest Deliverables...');
  const relPaths = walkDir(ROOT).sort();

  // 1. Generate skeleton-ingest.md
  console.log('Generating skeleton-ingest.md...');
  const skeletonLines: string[] = [];
  skeletonLines.push('# Repository Skeleton Ingest');
  skeletonLines.push('> Complete file tree and structured contents (<500 lines full; >=500 lines summary + exports)');
  skeletonLines.push('');
  skeletonLines.push('## File Tree');
  skeletonLines.push('```');
  for (const rel of relPaths) {
    skeletonLines.push(rel.replace(/\\/g, '/'));
  }
  skeletonLines.push('```');
  skeletonLines.push('');
  skeletonLines.push('---');
  skeletonLines.push('');

  for (const rel of relPaths) {
    const norm = rel.replace(/\\/g, '/');
    // Skip large generated/audit files in skeleton
    if (norm.startsWith('deep-ingest-') || norm === 'skeleton-ingest.md') continue;
    const abs = path.join(ROOT, rel);
    try {
      const content = fs.readFileSync(abs, 'utf8');
      const lines = content.split('\n');
      skeletonLines.push(`## File: \`${norm}\``);
      skeletonLines.push(`- Total Lines: ${lines.length}`);
      skeletonLines.push(`- Size Bytes: ${Buffer.byteLength(content, 'utf8')}`);
      skeletonLines.push('');

      if (lines.length < 500) {
        skeletonLines.push('Full Contents:');
        skeletonLines.push('```' + path.extname(rel).replace('.', ''));
        skeletonLines.push(content.replace(/\r/g, ''));
        skeletonLines.push('```');
      } else {
        const { summary, exports } = getFileSummaryAndExports(content);
        skeletonLines.push('File Summary (first 5 lines):');
        skeletonLines.push('```');
        skeletonLines.push(summary);
        skeletonLines.push('```');
        skeletonLines.push('');
        skeletonLines.push(`Exported Symbols (${exports.length}):`);
        skeletonLines.push(exports.map((e) => `- \`${e}\``).join('\n') || '- (No direct top-level named exports detected)');
      }
      skeletonLines.push('');
      skeletonLines.push('---');
      skeletonLines.push('');
    } catch (err) {
      // Binary or unreadable
    }
  }

  writeChunkedFiles('skeleton-ingest', skeletonLines, 2000);

  // Helper to build deep ingest
  function buildDeepIngest(baseName: string, title: string, filterFn: (rel: string) => boolean) {
    console.log(`Generating ${baseName}...`);
    const deepLines: string[] = [];
    deepLines.push(`# Deep Ingest: ${title}`);
    deepLines.push(`> Complete, untruncated file contents for ${title}`);
    deepLines.push('');

    const matched = relPaths.filter((r) => filterFn(r.replace(/\\/g, '/')));
    deepLines.push('## Included Files Inventory:');
    for (const m of matched) {
      deepLines.push(`- \`${m.replace(/\\/g, '/')}\``);
    }
    deepLines.push('');
    deepLines.push('---');
    deepLines.push('');

    for (const rel of matched) {
      const norm = rel.replace(/\\/g, '/');
      const abs = path.join(ROOT, rel);
      try {
        const content = fs.readFileSync(abs, 'utf8');
        const lines = content.split('\n');
        deepLines.push(`## File: \`${norm}\``);
        deepLines.push(`- Line count: ${lines.length}`);
        deepLines.push('');
        deepLines.push('```' + (path.extname(rel).replace('.', '') || 'text'));
        deepLines.push(content.replace(/\r/g, ''));
        deepLines.push('```');
        deepLines.push('');
        deepLines.push('---');
        deepLines.push('');
      } catch (err) {}
    }

    writeChunkedFiles(baseName, deepLines, 2000);
  }

  // deep-ingest-tenancy.md (lib/db/, lib/auth/, every migration, RLS tests)
  buildDeepIngest('deep-ingest-tenancy', 'Tenancy, Auth, Migrations & RLS', (rel) => {
    return (
      rel.startsWith('lib/db/') ||
      rel.startsWith('lib/auth/') ||
      rel.startsWith('drizzle/') ||
      rel.includes('rls') ||
      rel.includes('security')
    );
  });

  // deep-ingest-clinical.md (lib/services/ipd-*, lib/domain/ipd-*, components/ipd/, app/(app)/ipd/)
  buildDeepIngest('deep-ingest-clinical', 'Clinical & IPD Department', (rel) => {
    return (
      rel.startsWith('lib/services/ipd-') ||
      rel.startsWith('lib/domain/ipd-') ||
      rel.startsWith('components/ipd/') ||
      rel.startsWith('app/(app)/ipd/') ||
      rel.includes('emar') ||
      rel.includes('tpr') ||
      rel.includes('rounding') ||
      rel.includes('notes')
    );
  });

  // deep-ingest-billing.md (lib/services/*billing*, discharge-bill, claims, ipd-emar-outbox, every bill_items migration)
  buildDeepIngest('deep-ingest-billing', 'Billing, Claims & Discharge Finance', (rel) => {
    return (
      rel.includes('billing') ||
      rel.includes('discharge-bill') ||
      rel.includes('claims') ||
      rel.includes('ipd-emar-outbox') ||
      rel.includes('pricing') ||
      rel.includes('payment')
    );
  });

  // deep-ingest-whatsapp.md (lib/notify/, lib/services/whatsapp-*, app/api/whatsapp*, the whatsapp-notices components)
  buildDeepIngest('deep-ingest-whatsapp', 'WhatsApp Notifications & Webhooks', (rel) => {
    return (
      rel.startsWith('lib/notify/') ||
      rel.startsWith('lib/services/whatsapp-') ||
      rel.startsWith('app/api/whatsapp') ||
      rel.includes('whatsapp') ||
      rel.includes('notice')
    );
  });

  // deep-ingest-migrations.md (every file in drizzle/ plus the journal)
  buildDeepIngest('deep-ingest-migrations', 'Drizzle Migrations & Journal History', (rel) => {
    return rel.startsWith('drizzle/');
  });

  console.log('✓ All ingest files generated successfully.');
}

main().catch(console.error);
